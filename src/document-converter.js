const path = require("node:path");

const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const mammoth = require("mammoth");
const YAML = require("yaml");
const cheerio = require("cheerio");
const {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} = require("docx");
const { XMLBuilder, XMLParser, XMLValidator } = require("fast-xml-parser");
const { parse: parseCsv } = require("csv-parse/sync");
const { stringify: stringifyCsv } = require("csv-stringify/sync");
const yauzl = require("yauzl");

const { WorkGate } = require("./public-tool-security");
const { toolError } = require("./tool-upload");

const INPUT_FORMATS = new Set([
  "pdf",
  "docx",
  "xlsx",
  "csv",
  "tsv",
  "json",
  "xml",
  "yaml",
  "html",
  "txt",
  "md",
]);
const OUTPUT_FORMATS = new Set([
  "docx",
  "pdf",
  "xlsx",
  "csv",
  "tsv",
  "json",
  "md",
  "txt",
  "html",
  "xml",
  "yaml",
  "rtf",
]);
const MIME_TYPES = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
  tsv: "text/tab-separated-values; charset=utf-8",
  json: "application/json; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  html: "text/html; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  yaml: "application/yaml; charset=utf-8",
  rtf: "application/rtf",
};

class DocumentConverter {
  constructor({ maxPages = 100, maxCells = 120_000 } = {}) {
    this.maxPages = maxPages;
    this.maxCells = maxCells;
    this.gate = new WorkGate({ concurrency: 2, maxQueue: 6 });
  }

  capabilities(maxBytes) {
    return {
      maxBytes,
      maxPages: this.maxPages,
      maxCells: this.maxCells,
      inputs: [...INPUT_FORMATS],
      outputs: [...OUTPUT_FORMATS],
      notes: {
        pdf: "PDFs digitalizados sem camada de texto precisam de OCR e não são aceitos nesta etapa.",
        layout: "PDF e DOCX preservam conteúdo e estrutura, mas layouts complexos podem ser simplificados.",
        csv: "CSV e TSV representam somente a primeira planilha quando o original possui várias abas.",
      },
    };
  }

  convert(options) {
    return this.gate.run(() => this.convertNow(options));
  }

  async convertNow({ buffer, filename, target }) {
    const source = normalizeFormat(extensionOf(filename));
    const cleanTarget = normalizeFormat(String(target || "").toLowerCase());
    if (!INPUT_FORMATS.has(source))
      throw toolError(
        "Formato não permitido. Use PDF, DOCX, XLSX, CSV, TSV, JSON, XML, YAML, HTML, TXT ou MD.",
        415,
      );
    if (!OUTPUT_FORMATS.has(cleanTarget))
      throw toolError("Escolha um formato de saída válido.", 400);
    if (source === cleanTarget)
      throw toolError("Escolha um formato diferente do arquivo original.", 400);

    validateSignature(buffer, source);
    const model = await this.readSource(buffer, source, filename);
    enforceModelLimits(model, this.maxCells);
    const output = await writeTarget(model, cleanTarget, filename);
    return {
      ...output,
      mimeType: MIME_TYPES[cleanTarget],
      filename: outputFilename(filename, cleanTarget),
      source,
      target: cleanTarget,
    };
  }

  async readSource(buffer, source, filename) {
    if (source === "pdf")
      return readPdf(buffer, filename, this.maxPages, this.maxCells);
    if (source === "xlsx") {
      await inspectOfficeArchive(buffer, "xl/workbook.xml", "XLSX");
      return readXlsx(buffer, filename, this.maxCells);
    }
    if (source === "docx") {
      await inspectOfficeArchive(buffer, "word/document.xml", "DOCX");
      return readDocx(buffer, filename, this.maxCells);
    }
    if (source === "json") return readJson(buffer, filename, this.maxCells);
    if (source === "yaml") return readYaml(buffer, filename, this.maxCells);
    if (source === "xml") return readXml(buffer, filename, this.maxCells);
    if (source === "html") return readHtml(buffer, filename, this.maxCells);
    if (source === "csv" || source === "tsv")
      return readDelimited(buffer, filename, source, this.maxCells);
    return readPlainText(buffer, filename, source, this.maxCells);
  }
}

async function readPdf(buffer, filename, maxPages, maxCells) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  let loadingTask;
  try {
    loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      isEvalSupported: false,
      useSystemFonts: true,
      verbosity: 0,
    });
    const document = await loadingTask.promise;
    if (document.numPages > maxPages)
      throw toolError(`O PDF excede o limite de ${maxPages} páginas.`, 413);

    const rows = [["Página", "Linha", "Texto"]];
    let extractedCharacters = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines = pdfItemsToLines(content.items);
      lines.forEach((line, index) => {
        if ((rows.length + 1) * 3 > maxCells)
          throw toolError(`O PDF excede o limite de ${maxCells} células.`, 413);
        extractedCharacters += line.length;
        rows.push([pageNumber, index + 1, line]);
      });
      page.cleanup();
    }
    if (!extractedCharacters)
      throw toolError(
        "Nenhum texto foi encontrado. O PDF pode ser digitalizado e precisar de OCR.",
        422,
      );
    return workbookModel(filename, "pdf", [
      { name: "Texto do PDF", rows, merges: [] },
    ]);
  } catch (error) {
    if (error.status) throw error;
    throw toolError(
      "Não foi possível ler o PDF. Verifique se ele não está corrompido ou protegido por senha.",
      422,
    );
  } finally {
    loadingTask?.destroy?.();
  }
}

function pdfItemsToLines(items) {
  const groups = new Map();
  for (const item of items) {
    if (!item?.str) continue;
    const x = Number(item.transform?.[4] || 0);
    const y = Number(item.transform?.[5] || 0);
    const key = Math.round(y / 2);
    let group = groups.get(key);
    if (!group) {
      group = { y, items: [] };
      groups.set(key, group);
    }
    group.items.push({ x, width: Number(item.width || 0), text: item.str });
  }
  return [...groups.values()]
    .sort((left, right) => right.y - left.y)
    .map((group) => {
      let result = "";
      let previousEnd = null;
      group.items
        .sort((left, right) => left.x - right.x)
        .forEach((item) => {
          if (previousEnd !== null && item.x - previousEnd > 2) result += " ";
          result += item.text;
          previousEnd = item.x + item.width;
        });
      return result.trim();
    })
    .filter(Boolean);
}

async function readXlsx(buffer, filename, maxCells) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer, {
      ignoreNodes: ["dataValidations", "extLst"],
    });
  } catch {
    throw toolError("A planilha XLSX está corrompida ou não é compatível.", 422);
  }
  if (!workbook.worksheets.length)
    throw toolError("A planilha não possui abas legíveis.", 422);

  let cells = 0;
  const sheets = workbook.worksheets.map((worksheet) => {
    if (worksheet.rowCount * Math.max(1, worksheet.columnCount) > maxCells)
      throw toolError(`A planilha excede o limite de ${maxCells} células.`, 413);
    const rows = [];
    for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
      const row = [];
      for (
        let columnNumber = 1;
        columnNumber <= worksheet.columnCount;
        columnNumber += 1
      ) {
        cells += 1;
        row.push(jsonSafeCell(worksheet.getCell(rowNumber, columnNumber).value));
      }
      rows.push(trimTrailingEmpty(row));
    }
    return {
      name: worksheet.name,
      rows,
      merges: [...(worksheet.model.merges || [])],
    };
  });
  if (cells > maxCells)
    throw toolError(`A planilha excede o limite de ${maxCells} células.`, 413);
  return workbookModel(filename, "xlsx", sheets);
}

function readJson(buffer, filename, maxCells) {
  let value;
  try {
    value = JSON.parse(decodeUtf8(buffer));
  } catch {
    throw toolError("O JSON é inválido. Revise vírgulas, aspas e chaves.", 422);
  }
  const sheets = jsonToSheets(value, maxCells);
  return workbookModel(filename, "json", sheets, value);
}

async function readDocx(buffer, filename, maxCells) {
  let result;
  try {
    result = await mammoth.extractRawText({ buffer });
  } catch {
    throw toolError("O DOCX está corrompido, protegido ou não é compatível.", 422);
  }
  const text = stripBom(result.value || "").replace(/\u0000/g, "");
  if (!text.trim()) throw toolError("Nenhum texto legível foi encontrado no DOCX.", 422);
  return plainTextModel(text, filename, "docx", maxCells, "Documento Word");
}

function readYaml(buffer, filename, maxCells) {
  const text = stripBom(decodeUtf8(buffer));
  let document;
  try {
    document = YAML.parseDocument(text, {
      maxAliasCount: 25,
      strict: true,
      uniqueKeys: true,
    });
  } catch {
    throw toolError("O YAML é inválido ou possui uma estrutura insegura.", 422);
  }
  if (document.errors.length)
    throw toolError(`O YAML é inválido: ${document.errors[0].message.split("\n")[0]}`, 422);
  let value;
  try {
    value = document.toJS({ maxAliasCount: 25 });
    enforceStructuredDepth(value, 50, "YAML");
  } catch (error) {
    if (error.status) throw error;
    throw toolError("O YAML possui referências ou profundidade excessivas.", 413);
  }
  return workbookModel(filename, "yaml", jsonToSheets(value, maxCells), value);
}

function readXml(buffer, filename, maxCells) {
  const text = stripBom(decodeUtf8(buffer));
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text))
    throw toolError("DOCTYPE e entidades personalizadas não são aceitos por segurança.", 422);
  const validation = XMLValidator.validate(text, {
    allowBooleanAttributes: false,
    unpairedTags: [],
  });
  if (validation !== true)
    throw toolError(`O XML é inválido: ${validation.err?.msg || "estrutura incorreta"}.`, 422);
  let value;
  try {
    value = new XMLParser({
      allowBooleanAttributes: false,
      attributeNamePrefix: "@",
      ignoreAttributes: false,
      parseAttributeValue: false,
      parseTagValue: false,
      processEntities: false,
      trimValues: false,
    }).parse(text);
    enforceStructuredDepth(value, 50, "XML");
  } catch (error) {
    if (error.status) throw error;
    throw toolError("Não foi possível interpretar a estrutura do XML.", 422);
  }
  return workbookModel(filename, "xml", jsonToSheets(value, maxCells), value);
}

function readHtml(buffer, filename, maxCells) {
  const html = stripBom(decodeUtf8(buffer));
  let $;
  try {
    $ = cheerio.load(html, { xmlMode: false });
  } catch {
    throw toolError("O HTML não pôde ser interpretado.", 422);
  }
  $("script, style, noscript, iframe, object, embed, template").remove();
  const sheets = [];
  let cells = 0;
  $("table").each((tableIndex, table) => {
    const rows = [];
    $(table)
      .find("tr")
      .each((_, row) => {
        const values = [];
        $(row)
          .children("th, td")
          .each((__, cell) => values.push(normalizeVisibleText($(cell).text())));
        if (!values.length) return;
        cells += values.length;
        if (cells > maxCells)
          throw toolError(`O HTML excede o limite de ${maxCells} células.`, 413);
        rows.push(values);
      });
    if (rows.length)
      sheets.push({ name: `Tabela ${tableIndex + 1}`, rows, merges: [] });
  });

  const textRows = [["Tipo", "Texto"]];
  $("h1, h2, h3, h4, h5, h6, p, li, pre, blockquote")
    .filter((_, element) => !$(element).parents("table").length)
    .each((_, element) => {
      const text = normalizeVisibleText($(element).text());
      if (!text) return;
      cells += 2;
      if (cells > maxCells)
        throw toolError(`O HTML excede o limite de ${maxCells} células.`, 413);
      textRows.push([element.tagName.toUpperCase(), text]);
    });
  if (textRows.length > 1)
    sheets.unshift({ name: "Conteúdo HTML", rows: textRows, merges: [] });
  if (!sheets.length) {
    const text = normalizeVisibleText($.root().text());
    if (!text) throw toolError("Nenhum texto ou tabela foi encontrado no HTML.", 422);
    return plainTextModel(text, filename, "html", maxCells, "Conteúdo HTML");
  }
  return workbookModel(filename, "html", sheets);
}

function readDelimited(buffer, filename, source, maxCells) {
  let records;
  let cellCount = 0;
  try {
    records = parseCsv(stripBom(decodeUtf8(buffer)), {
      bom: true,
      delimiter: source === "tsv" ? "\t" : ",",
      relax_column_count: true,
      skip_empty_lines: false,
      max_record_size: 1024 * 1024,
      on_record(record) {
        cellCount += record.length;
        if (cellCount > maxCells)
          throw toolError(`O ${source.toUpperCase()} excede o limite de ${maxCells} células.`, 413);
        return record;
      },
    });
  } catch (error) {
    if (error.status) throw error;
    throw toolError(`O ${source.toUpperCase()} possui aspas ou separadores inválidos.`, 422);
  }
  return workbookModel(filename, source, [
    { name: "Dados", rows: records, merges: [] },
  ]);
}

function readPlainText(buffer, filename, source, maxCells) {
  const text = stripBom(decodeUtf8(buffer));
  if (text.includes("\u0000"))
    throw toolError("O arquivo não parece conter texto UTF-8 válido.", 422);
  return plainTextModel(text, filename, source, maxCells);
}

function plainTextModel(text, filename, source, maxCells, sheetName = undefined) {
  const lines = text.split(/\r?\n/);
  if ((lines.length + 1) * 2 > maxCells)
    throw toolError(`O texto excede o limite de ${maxCells} células.`, 413);
  const rows = [["Linha", "Texto"]];
  lines.forEach((line, index) => rows.push([index + 1, line]));
  return workbookModel(filename, source, [
    { name: sheetName || (source === "md" ? "Markdown" : "Texto"), rows, merges: [] },
  ], undefined, text);
}

function jsonToSheets(value, maxCells) {
  if (Array.isArray(value))
    return [{ name: "Dados", rows: jsonArrayToRows(value, maxCells), merges: [] }];
  if (!value || typeof value !== "object")
    return [{ name: "Dados", rows: [["Valor", "Tipo"], [value, typeOf(value)]], merges: [] }];

  const sheets = [];
  const summary = [];
  let usedCells = 0;
  for (const [key, item] of Object.entries(value)) {
    if (Array.isArray(item)) {
      const rows = jsonArrayToRows(item, maxCells - usedCells);
      usedCells += countCells(rows);
      sheets.push({ name: safeSheetName(key), rows, merges: [] });
    } else if (item && typeof item === "object") {
      const flattened = flattenObject(item, key, Math.floor((maxCells - usedCells) / 3));
      for (const [field, nested] of Object.entries(flattened)) {
        summary.push([field, typeOf(nested), valueForTable(nested)]);
        usedCells += 3;
        if (usedCells > maxCells)
          throw toolError(`O JSON excede o limite de ${maxCells} células.`, 413);
      }
    } else {
      summary.push([key, typeOf(item), valueForTable(item)]);
      usedCells += 3;
      if (usedCells > maxCells)
        throw toolError(`O JSON excede o limite de ${maxCells} células.`, 413);
    }
  }
  if (summary.length)
    sheets.unshift({
      name: "Resumo",
      rows: [["Campo", "Tipo", "Valor"], ...summary],
      merges: [],
    });
  return sheets.length
    ? sheets
    : [{ name: "Dados", rows: [["Campo", "Tipo", "Valor"]], merges: [] }];
}

function jsonArrayToRows(items, maxCells) {
  if (!items.length) return [["Valor"]];
  if (!items.some((item) => item && typeof item === "object"))
    return (() => {
      if ((items.length + 1) * 2 > maxCells)
        throw toolError(`O JSON excede o limite de células.`, 413);
      return [["Valor", "Tipo"], ...items.map((item) => [item, typeOf(item)])];
    })();
  const flattened = items.map((item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? flattenObject(item, "", maxCells)
      : { value: valueForTable(item) },
  );
  const headers = [...new Set(flattened.flatMap((item) => Object.keys(item)))];
  if (headers.length * (flattened.length + 1) > maxCells)
    throw toolError("O JSON possui combinações demais de linhas e colunas.", 413);
  return [
    headers,
    ...flattened.map((item) => headers.map((header) => valueForTable(item[header]))),
  ];
}

function flattenObject(value, prefix = "", maxFields = 120_000) {
  const output = Object.create(null);
  const stack = [{ value, prefix, depth: 0 }];
  let fields = 0;
  while (stack.length) {
    const current = stack.pop();
    if (current.depth > 50)
      throw toolError("O JSON excede o limite de 50 níveis de profundidade.", 413);
    for (const [key, item] of Object.entries(current.value || {})) {
      const field = current.prefix ? `${current.prefix}.${key}` : key;
      if (item && typeof item === "object" && !Array.isArray(item) && !(item instanceof Date))
        stack.push({ value: item, prefix: field, depth: current.depth + 1 });
      else {
        fields += 1;
        if (fields > maxFields)
          throw toolError("O JSON possui campos demais para conversão.", 413);
        output[field] = Array.isArray(item) ? JSON.stringify(item) : item;
      }
    }
  }
  return output;
}

function countCells(rows) {
  return rows.reduce((total, row) => total + row.length, 0);
}

async function writeTarget(model, target, filename) {
  if (target === "json") {
    const value = structuredOutput(model, filename);
    return { buffer: Buffer.from(JSON.stringify(value, null, 2), "utf8") };
  }
  if (target === "txt") return { buffer: Buffer.from(modelToText(model), "utf8") };
  if (target === "md") return { buffer: Buffer.from(modelToMarkdown(model), "utf8") };
  if (target === "html") return { buffer: Buffer.from(modelToHtml(model, filename), "utf8") };
  if (target === "xml") return { buffer: Buffer.from(modelToXml(model, filename), "utf8") };
  if (target === "yaml")
    return { buffer: Buffer.from(YAML.stringify(structuredOutput(model, filename)), "utf8") };
  if (target === "rtf") return { buffer: Buffer.from(modelToRtf(model, filename), "utf8") };
  if (target === "csv" || target === "tsv") {
    const rows = (model.sheets[0]?.rows || []).map((row) => row.map(safeCsvCell));
    const delimiter = target === "tsv" ? "\t" : ",";
    return {
      buffer: Buffer.from(
        `\uFEFF${stringifyCsv(rows, {
          delimiter,
          quoted_match: target === "tsv" ? /[\r\n\t"]/ : /[\r\n,;"]/,
          record_delimiter: "\r\n",
        })}`,
        "utf8",
      ),
    };
  }
  if (target === "xlsx") return { buffer: await modelToXlsx(model) };
  if (target === "docx") return { buffer: await modelToDocx(model, filename) };
  return { buffer: await modelToPdf(model, filename) };
}

async function modelToXlsx(model) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "VaultKeep";
  workbook.created = new Date();
  model.sheets.forEach((sheet, sheetIndex) => {
    const worksheet = workbook.addWorksheet(
      uniqueSheetName(workbook, sheet.name || `Planilha ${sheetIndex + 1}`),
    );
    sheet.rows.forEach((row) => worksheet.addRow(row.map(excelCellValue)));
    const firstRow = worksheet.getRow(1);
    firstRow.font = { bold: true, color: { argb: "FF082842" } };
    firstRow.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFF2C94C" },
    };
    worksheet.views = [{ state: "frozen", ySplit: 1 }];
    worksheet.columns.forEach((column) => {
      let width = 10;
      column.eachCell({ includeEmpty: false }, (cell) => {
        width = Math.max(width, Math.min(55, displayCell(cell.value).length + 2));
      });
      column.width = width;
    });
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function modelToDocx(model, filename) {
  const children = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun({ text: `VaultKeep // ${path.basename(filename)}`, bold: true })],
    }),
    new Paragraph({
      children: [new TextRun({ text: `Convertido de ${model.source.toUpperCase()}`, italics: true })],
    }),
  ];

  model.sheets.forEach((sheet) => {
    children.push(new Paragraph({ text: sheet.name, heading: HeadingLevel.HEADING_1 }));
    const flow = textFlowInfo(model, sheet);
    if (flow) {
      let currentPage;
      sheet.rows.slice(1).forEach((row) => {
        if (flow.pageIndex >= 0 && row[flow.pageIndex] !== currentPage) {
          currentPage = row[flow.pageIndex];
          children.push(
            new Paragraph({ text: `Página ${displayCell(currentPage)}`, heading: HeadingLevel.HEADING_2 }),
          );
        }
        const text = displayCell(row[flow.textIndex]);
        const tag = flow.typeIndex >= 0 ? displayCell(row[flow.typeIndex]).toLowerCase() : "";
        children.push(
          new Paragraph({
            text: text || " ",
            heading: htmlHeadingLevel(tag),
          }),
        );
      });
      return;
    }

    const columnCount = Math.max(0, ...sheet.rows.map((row) => row.length));
    if (!columnCount) return;
    if (columnCount > 50) {
      sheet.rows.forEach((row) => children.push(new Paragraph({ text: row.map(textCell).join("\t") })));
      return;
    }
    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: sheet.rows.map(
          (row, rowIndex) =>
            new TableRow({
              children: Array.from({ length: columnCount }, (_, columnIndex) =>
                new TableCell({
                  children: [
                    new Paragraph({
                      children: [
                        new TextRun({
                          text: displayCell(row[columnIndex]),
                          bold: rowIndex === 0,
                        }),
                      ],
                    }),
                  ],
                }),
              ),
            }),
        ),
      }),
    );
  });

  const document = new Document({
    creator: "VaultKeep",
    title: `Conversão de ${path.basename(filename)}`,
    sections: [{ properties: {}, children }],
  });
  return Buffer.from(await Packer.toBuffer(document));
}

function modelToMarkdown(model) {
  const sections = [`# ${escapeMarkdown(model.filename || "Documento convertido")}`];
  model.sheets.forEach((sheet) => {
    sections.push(`## ${escapeMarkdown(sheet.name)}`);
    const flow = textFlowInfo(model, sheet);
    if (flow) {
      let currentPage;
      sheet.rows.slice(1).forEach((row) => {
        if (flow.pageIndex >= 0 && row[flow.pageIndex] !== currentPage) {
          currentPage = row[flow.pageIndex];
          sections.push(`### Página ${escapeMarkdown(displayCell(currentPage))}`);
        }
        const value = displayCell(row[flow.textIndex]);
        if (value) sections.push(value);
      });
      return;
    }
    if (!sheet.rows.length) return;
    const columnCount = Math.max(1, ...sheet.rows.map((row) => row.length));
    const normalized = sheet.rows.map((row) =>
      Array.from({ length: columnCount }, (_, index) => markdownCell(row[index])),
    );
    sections.push(`| ${normalized[0].join(" | ")} |`);
    sections.push(`| ${normalized[0].map(() => "---").join(" | ")} |`);
    normalized.slice(1).forEach((row) => sections.push(`| ${row.join(" | ")} |`));
  });
  return `${sections.join("\n\n")}\n`;
}

function modelToHtml(model, filename) {
  const sections = model.sheets
    .map((sheet) => {
      const flow = textFlowInfo(model, sheet);
      if (flow) {
        let currentPage;
        const content = sheet.rows
          .slice(1)
          .map((row) => {
            let pageHeading = "";
            if (flow.pageIndex >= 0 && row[flow.pageIndex] !== currentPage) {
              currentPage = row[flow.pageIndex];
              pageHeading = `<h3>Página ${escapeHtml(displayCell(currentPage))}</h3>`;
            }
            const tag = flow.typeIndex >= 0 ? displayCell(row[flow.typeIndex]).toLowerCase() : "p";
            const safeTag = /^h[1-6]$/.test(tag) ? tag : tag === "pre" ? "pre" : "p";
            return `${pageHeading}<${safeTag}>${escapeHtml(displayCell(row[flow.textIndex]))}</${safeTag}>`;
          })
          .join("\n");
        return `<section><h2>${escapeHtml(sheet.name)}</h2>${content}</section>`;
      }
      const rows = sheet.rows
        .map(
          (row, index) =>
            `<tr>${row
              .map((cell) => `<${index ? "td" : "th"}>${escapeHtml(displayCell(cell))}</${index ? "td" : "th"}>`)
              .join("")}</tr>`,
        )
        .join("\n");
      return `<section><h2>${escapeHtml(sheet.name)}</h2><table>${rows}</table></section>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(path.basename(filename))}</title><style>body{max-width:1100px;margin:40px auto;padding:0 24px;font:16px/1.55 system-ui;color:#102c3c}h1,h2,h3{color:#082842}table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{border:1px solid #a8b7bf;padding:8px;text-align:left;vertical-align:top}th{background:#f2c94c}pre{white-space:pre-wrap;background:#eef3f5;padding:12px}</style></head>
<body><h1>VaultKeep // ${escapeHtml(path.basename(filename))}</h1>${sections}</body></html>`;
}

function modelToXml(model, filename) {
  const builder = new XMLBuilder({
    format: true,
    ignoreAttributes: false,
    suppressEmptyNode: false,
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build({
    vaultkeep: structuredXmlOutput(model, filename),
  })}`;
}

function modelToRtf(model, filename) {
  const body = [`\\b\\fs32 ${rtfEscape(`VaultKeep // ${path.basename(filename)}`)}\\b0\\fs24\\par`];
  model.sheets.forEach((sheet) => {
    body.push(`\\par\\b\\fs28 ${rtfEscape(sheet.name)}\\b0\\fs24\\par`);
    const flow = textFlowInfo(model, sheet);
    if (flow) {
      let currentPage;
      sheet.rows.slice(1).forEach((row) => {
        if (flow.pageIndex >= 0 && row[flow.pageIndex] !== currentPage) {
          currentPage = row[flow.pageIndex];
          body.push(`\\b Página ${rtfEscape(displayCell(currentPage))}\\b0\\par`);
        }
        body.push(`${rtfEscape(displayCell(row[flow.textIndex]))}\\par`);
      });
    } else {
      sheet.rows.forEach((row, index) =>
        body.push(`${index === 0 ? "\\b " : ""}${rtfEscape(row.map(textCell).join("\\tab "))}${index === 0 ? "\\b0" : ""}\\par`),
      );
    }
  });
  return `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\uc1\n${body.join("\n")}\n}`;
}

function modelToPdf(model, filename) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({
      size: "A4",
      margin: 40,
      info: { Title: `Conversão de ${path.basename(filename)}`, Creator: "VaultKeep" },
      bufferPages: false,
    });
    const chunks = [];
    document.on("data", (chunk) => chunks.push(chunk));
    document.on("error", reject);
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.font("Helvetica-Bold").fontSize(16).fillColor("#082842");
    document.text(`VaultKeep // ${path.basename(filename)}`);
    document.moveDown(0.7);
    model.sheets.forEach((sheet, sheetIndex) => {
      if (sheetIndex) document.addPage();
      document.font("Helvetica-Bold").fontSize(12).fillColor("#8a6a0a");
      document.text(sheet.name);
      document.moveDown(0.4);
      const flow = textFlowInfo(model, sheet);
      if (flow) {
        let currentPage;
        sheet.rows.slice(1).forEach((row) => {
          if (flow.pageIndex >= 0 && row[flow.pageIndex] !== currentPage) {
            currentPage = row[flow.pageIndex];
            document.moveDown(0.4).font("Helvetica-Bold").fontSize(10).fillColor("#8a6a0a");
            document.text(`Página ${displayCell(currentPage)}`);
          }
          document.font("Helvetica").fontSize(9).fillColor("#102c3c");
          document.text(displayCell(row[flow.textIndex]) || " ", { lineGap: 1 });
        });
        return;
      }
      document.font("Courier").fontSize(7).fillColor("#102c3c");
      sheet.rows.forEach((row) => {
        const line = row.map(displayCell).join("  |  ").slice(0, 8_000);
        document.text(line || " ", { lineGap: 1 });
      });
    });
    document.end();
  });
}

function modelToText(model) {
  return model.sheets
    .map((sheet) => {
      const flow = textFlowInfo(model, sheet);
      if (flow) {
        let currentPage;
        return sheet.rows
          .slice(1)
          .map((row) => {
            const parts = [];
            if (flow.pageIndex >= 0 && row[flow.pageIndex] !== currentPage) {
              currentPage = row[flow.pageIndex];
              parts.push(`### Página ${displayCell(currentPage)}`);
            }
            parts.push(displayCell(row[flow.textIndex]));
            return parts.join("\r\n");
          })
          .join("\r\n");
      }
      const rows = sheet.rows.map((row) => row.map(textCell).join("\t")).join("\r\n");
      return `### ${sheet.name}\r\n${rows}`;
    })
    .join("\r\n\r\n");
}

function textFlowInfo(model, sheet) {
  const headers = (sheet.rows[0] || []).map((value) => displayCell(value).toLowerCase());
  const textIndex = headers.indexOf("texto");
  if (textIndex < 0) return null;
  if (model.source === "pdf" && sheet.name === "Texto do PDF")
    return { textIndex, pageIndex: headers.indexOf("página"), typeIndex: -1 };
  if (["docx", "txt", "md"].includes(model.source))
    return { textIndex, pageIndex: -1, typeIndex: -1 };
  if (model.source === "html" && sheet.name === "Conteúdo HTML")
    return { textIndex, pageIndex: -1, typeIndex: headers.indexOf("tipo") };
  return null;
}

function htmlHeadingLevel(tag) {
  return {
    h1: HeadingLevel.HEADING_1,
    h2: HeadingLevel.HEADING_2,
    h3: HeadingLevel.HEADING_3,
    h4: HeadingLevel.HEADING_4,
    h5: HeadingLevel.HEADING_5,
    h6: HeadingLevel.HEADING_6,
  }[tag];
}

function structuredOutput(model, filename) {
  return {
    schema: "vaultkeep-conversion/v1",
    source: { name: path.basename(filename), format: model.source },
    sheets: model.sheets,
  };
}

function structuredXmlOutput(model, filename) {
  return {
    source: {
      name: xmlSafeString(path.basename(filename)),
      format: model.source,
    },
    sheets: {
      sheet: model.sheets.map((sheet) => ({
        name: xmlSafeString(sheet.name),
        rows: {
          row: sheet.rows.map((row) => ({
            cell: row.map((cell) => xmlSafeString(displayCell(cell))),
          })),
        },
      })),
    },
  };
}

function escapeMarkdown(value) {
  return String(value || "").replace(/([\\`*_{}[\]<>#+.!|~-])/g, "\\$1");
}

function markdownCell(value) {
  return displayCell(value).replace(/\|/g, "\\|").replace(/[\r\n]+/g, "<br>");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function xmlSafeString(value) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "");
}

function rtfEscape(value) {
  let output = "";
  const text = String(value ?? "");
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 92 || code === 123 || code === 125) output += `\\${text[index]}`;
    else if (code === 10) output += "\\line ";
    else if (code === 13) continue;
    else if (code > 127) output += `\\u${code > 32767 ? code - 65536 : code}?`;
    else output += text[index];
  }
  return output;
}

function normalizeVisibleText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function enforceStructuredDepth(value, maxDepth, label) {
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop();
    if (!current.value || typeof current.value !== "object") continue;
    if (current.depth > maxDepth)
      throw toolError(`O ${label} excede o limite de ${maxDepth} níveis.`, 413);
    nodes += 1;
    if (nodes > 250_000)
      throw toolError(`O ${label} possui elementos demais para conversão.`, 413);
    Object.values(current.value).forEach((item) =>
      stack.push({ value: item, depth: current.depth + 1 }),
    );
  }
}

function inspectOfficeArchive(buffer, requiredEntry, label) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, archive) => {
      if (error) return reject(toolError(`O ${label} não possui uma estrutura ZIP válida.`, 422));
      let totalSize = 0;
      let entries = 0;
      let requiredEntryFound = false;
      let settled = false;
      const fail = (message, status = 422) => {
        if (settled) return;
        settled = true;
        archive.close();
        reject(toolError(message, status));
      };
      archive.readEntry();
      archive.on("entry", (entry) => {
        entries += 1;
        totalSize += Number(entry.uncompressedSize || 0);
        if (entry.fileName === requiredEntry) requiredEntryFound = true;
        if (entries > 2_000 || totalSize > 80 * 1024 * 1024) {
          return fail(`O ${label} expandido excede o limite de segurança.`, 413);
        }
        archive.readEntry();
      });
      archive.on("end", () => {
        if (settled) return;
        settled = true;
        if (!requiredEntryFound)
          reject(toolError(`O arquivo não contém a estrutura interna esperada de um ${label}.`, 422));
        else resolve();
      });
      archive.on("error", () => fail(`Não foi possível abrir o ${label}.`));
    });
  });
}

function validateSignature(buffer, source) {
  if (source === "pdf" && !buffer.subarray(0, 1024).includes(Buffer.from("%PDF-")))
    throw toolError("O conteúdo enviado não corresponde a um PDF.", 415);
  if (
    (source === "xlsx" || source === "docx") &&
    !buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  )
    throw toolError(`O conteúdo enviado não corresponde a um ${source.toUpperCase()}.`, 415);
}

function enforceModelLimits(model, maxCells) {
  let cells = 0;
  for (const sheet of model.sheets) {
    for (const row of sheet.rows) cells += row.length;
  }
  if (cells > maxCells)
    throw toolError(`O documento excede o limite de ${maxCells} células.`, 413);
}

function workbookModel(filename, source, sheets, originalJson = undefined, rawText = undefined) {
  return { filename: path.basename(filename), source, sheets, originalJson, rawText };
}

function jsonSafeCell(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return { type: "date", value: value.toISOString() };
  if (Buffer.isBuffer(value)) return { type: "binary", value: value.toString("base64") };
  if (typeof value !== "object") return value;
  if (Array.isArray(value.richText))
    return { type: "richText", value: value.richText.map((part) => part.text).join("") };
  if (value.formula)
    return { type: "formula", formula: value.formula, result: jsonSafeCell(value.result) };
  if (value.hyperlink)
    return { type: "hyperlink", text: value.text || value.hyperlink, hyperlink: value.hyperlink };
  if (value.error) return { type: "error", value: value.error };
  return JSON.parse(JSON.stringify(value));
}

function excelCellValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value ?? "";
  if (value.type === "date") return new Date(value.value);
  if (value.type === "formula") return displayCell(value.result);
  if (value.type === "hyperlink") return { text: value.text, hyperlink: value.hyperlink };
  if (value.type === "richText" || value.type === "error") return value.value;
  return JSON.stringify(value);
}

function displayCell(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return String(value);
  if (value.type === "formula") return displayCell(value.result ?? value.formula);
  if (value.type === "date" || value.type === "richText" || value.type === "error")
    return String(value.value || "");
  if (value.type === "hyperlink") return String(value.text || value.hyperlink || "");
  if (value.formula) return displayCell(value.result ?? value.formula);
  if (value.richText) return value.richText.map((part) => part.text).join("");
  return JSON.stringify(value);
}

function safeCsvCell(value) {
  const displayed = displayCell(value);
  return /^[\t\r\n ]*[=+\-@]/.test(displayed) ? `'${displayed}` : displayed;
}

function textCell(value) {
  return displayCell(value).replace(/[\t\r\n]+/g, " ");
}

function trimTrailingEmpty(row) {
  let last = row.length;
  while (last > 0 && (row[last - 1] === null || row[last - 1] === "")) last -= 1;
  return row.slice(0, last);
}

function decodeUtf8(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw toolError("O texto precisa estar codificado em UTF-8.", 422);
  }
}

function stripBom(value) {
  return value.replace(/^\uFEFF/, "");
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function valueForTable(value) {
  if (value === undefined) return "";
  if (value && typeof value === "object") return JSON.stringify(value);
  return value;
}

function safeSheetName(value) {
  const name = String(value || "Dados")
    .replace(/[\\/?*:[\]]/g, " ")
    .trim()
    .slice(0, 31);
  return name || "Dados";
}

function uniqueSheetName(workbook, requested) {
  const base = safeSheetName(requested);
  let name = base;
  let suffix = 2;
  while (workbook.getWorksheet(name)) {
    const tail = ` ${suffix}`;
    name = `${base.slice(0, 31 - tail.length)}${tail}`;
    suffix += 1;
  }
  return name;
}

function extensionOf(filename) {
  return path.extname(String(filename || "")).slice(1).toLowerCase();
}

function normalizeFormat(format) {
  if (format === "yml") return "yaml";
  if (format === "htm") return "html";
  return format;
}

function outputFilename(filename, target) {
  const base = path
    .basename(String(filename || "documento"), path.extname(String(filename || "")))
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
    .slice(0, 120);
  return `${base || "documento"}-convertido.${target}`;
}

module.exports = { DocumentConverter };
