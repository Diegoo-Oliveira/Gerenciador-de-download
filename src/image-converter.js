const path = require("node:path");

const { XMLParser, XMLValidator } = require("fast-xml-parser");
const sharp = require("sharp");

const { WorkGate } = require("./public-tool-security");
const { toolError } = require("./tool-upload");

const INPUT_FORMATS = new Set(["jpeg", "png", "webp", "gif", "heif", "tiff", "svg"]);
const OUTPUT_FORMATS = new Set(["jpeg", "png", "webp", "gif", "avif", "tiff", "svg"]);
const ALPHA_FORMATS = new Set(["png", "webp", "gif", "avif", "tiff", "svg"]);
const MIME_TYPES = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  tiff: "image/tiff",
  svg: "image/svg+xml",
};
const EXTENSIONS = {
  jpeg: "jpg",
  png: "png",
  webp: "webp",
  gif: "gif",
  avif: "avif",
  tiff: "tiff",
  svg: "svg",
};
const FORBIDDEN_SVG_ELEMENTS = new Set([
  "a",
  "animate",
  "animatemotion",
  "animatetransform",
  "audio",
  "canvas",
  "cursor",
  "discard",
  "embed",
  "feimage",
  "font-face-format",
  "font-face-src",
  "font-face-uri",
  "foreignobject",
  "iframe",
  "link",
  "object",
  "script",
  "set",
  "style",
  "video",
]);
const SAFE_XML_ENTITIES = new Set(["amp", "apos", "gt", "lt", "quot"]);

class ImageConverter {
  constructor({ maxPixels = 24_000_000, maxBackgroundPixels = 6_000_000 } = {}) {
    this.maxPixels = maxPixels;
    this.maxBackgroundPixels = maxBackgroundPixels;
    this.conversionGate = new WorkGate({ concurrency: 2, maxQueue: 5 });
    this.backgroundGate = new WorkGate({ concurrency: 1, maxQueue: 3 });
  }

  capabilities(maxBytes) {
    return {
      maxBytes,
      maxPixels: this.maxPixels,
      maxBackgroundPixels: this.maxBackgroundPixels,
      inputs: ["jpg", "jpeg", "png", "webp", "gif", "avif", "tif", "tiff", "svg"],
      outputs: ["jpg", "png", "webp", "gif", "avif", "tiff", "svg"],
      backgroundRemoval: {
        available: true,
        method: "uniform-edge",
        description: "Remove fundos uniformes conectados às bordas da imagem.",
      },
    };
  }

  convert(options) {
    const gate = parseBoolean(options.removeBackground)
      ? this.backgroundGate
      : this.conversionGate;
    return gate.run(() => this.convertNow(options));
  }

  async convertNow({
    buffer,
    filename,
    format,
    quality,
    width,
    height,
    removeBackground,
    tolerance,
  }) {
    const target = normalizeFormat(format);
    if (!OUTPUT_FORMATS.has(target))
      throw toolError("Escolha JPG, PNG, WEBP, GIF, AVIF, TIFF ou SVG como saída.", 400);
    const shouldRemoveBackground = parseBoolean(removeBackground);
    if (shouldRemoveBackground && !ALPHA_FORMATS.has(target))
      throw toolError(
        "Para preservar a transparência, escolha PNG, WEBP, GIF, AVIF, TIFF ou SVG.",
        400,
      );

    const requestedWidth = optionalInteger(width, 1, 6000, "largura");
    const requestedHeight = optionalInteger(height, 1, 6000, "altura");
    const cleanQuality = integerInRange(quality, 1, 100, 82);
    const cleanTolerance = integerInRange(tolerance, 8, 100, 36);

    const xmlLikeInput = looksLikeXml(buffer);
    if (xmlLikeInput) await validateSvgInput(buffer, this.maxPixels);

    let metadata;
    try {
      metadata = await sharp(buffer, {
        failOn: "error",
        limitInputPixels: this.maxPixels,
        animated: false,
      }).metadata();
    } catch {
      throw toolError(
        "A imagem está corrompida, excede o limite de pixels ou não é compatível.",
        422,
      );
    }
    if (metadata.format === "svg" && !xmlLikeInput)
      throw toolError("O SVG deve usar XML UTF-8 sem compactação.", 415);
    if (metadata.format === "svg" && path.extname(String(filename || "")).toLowerCase() !== ".svg")
      throw toolError("Arquivos SVG devem usar a extensão .svg.", 415);
    if (!INPUT_FORMATS.has(metadata.format))
      throw toolError("O conteúdo enviado não corresponde a uma imagem permitida.", 415);
    if (!metadata.width || !metadata.height)
      throw toolError("Não foi possível identificar as dimensões da imagem.", 422);
    if (metadata.width * metadata.height > this.maxPixels)
      throw toolError("A imagem excede o limite de pixels do conversor.", 413);
    if (Number(metadata.pages || 1) > 1)
      throw toolError("Imagens animadas ou com várias páginas ainda não são aceitas.", 422);
    if (
      shouldRemoveBackground &&
      metadata.width * metadata.height > this.maxBackgroundPixels
    )
      throw toolError(
        `A remoção de fundo aceita até ${this.maxBackgroundPixels.toLocaleString("pt-BR")} pixels.`,
        413,
      );

    let pipeline = sharp(buffer, {
      failOn: "error",
      limitInputPixels: this.maxPixels,
      animated: false,
    }).rotate();
    if (requestedWidth || requestedHeight) {
      pipeline = pipeline.resize({
        width: requestedWidth || undefined,
        height: requestedHeight || undefined,
        fit: "inside",
        withoutEnlargement: true,
      });
    }

    if (shouldRemoveBackground) {
      const raw = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      removeUniformBackground(raw.data, raw.info, cleanTolerance);
      pipeline = sharp(raw.data, { raw: raw.info });
    }

    try {
      const output =
        target === "svg"
          ? await svgOutput(pipeline)
          : await outputPipeline(pipeline, target, cleanQuality).toBuffer({
              resolveWithObject: true,
            });
      return {
        buffer: output.data,
        mimeType: MIME_TYPES[target],
        filename: outputFilename(filename, target, shouldRemoveBackground),
        source: metadata.format,
        target,
        width: output.info.width,
        height: output.info.height,
        backgroundRemoved: shouldRemoveBackground,
      };
    } catch {
      throw toolError("Não foi possível gerar a imagem convertida.", 422);
    }
  }
}

function outputPipeline(pipeline, target, quality) {
  if (target === "jpeg")
    return pipeline.flatten({ background: "#ffffff" }).jpeg({ quality, mozjpeg: true });
  if (target === "png")
    return pipeline.png({ compressionLevel: 9, palette: false, quality });
  if (target === "webp") return pipeline.webp({ quality, effort: 4 });
  if (target === "gif")
    return pipeline.gif({
      colours: Math.max(2, Math.min(256, Math.round((quality / 100) * 256))),
      dither: 1,
      effort: 7,
    });
  if (target === "avif") return pipeline.avif({ quality, effort: 4 });
  return pipeline.tiff({ quality, compression: "lzw" });
}

async function svgOutput(pipeline) {
  const png = await pipeline.png({ compressionLevel: 9, palette: false }).toBuffer({
    resolveWithObject: true,
  });
  const encoded = png.data.toString("base64");
  const svg = Buffer.from(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<svg xmlns="http://www.w3.org/2000/svg" width="${png.info.width}" height="${png.info.height}" viewBox="0 0 ${png.info.width} ${png.info.height}">`,
      `<image width="${png.info.width}" height="${png.info.height}" href="data:image/png;base64,${encoded}"/>`,
      "</svg>",
    ].join(""),
    "utf8",
  );
  return { data: svg, info: { width: png.info.width, height: png.info.height } };
}

function looksLikeXml(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return false;
  if (
    (buffer[0] === 0xff && buffer[1] === 0xfe) ||
    (buffer[0] === 0xfe && buffer[1] === 0xff)
  )
    return true;
  const prefix = buffer.subarray(0, Math.min(buffer.length, 4096)).toString("utf8");
  return prefix.replace(/^\uFEFF/, "").trimStart().startsWith("<");
}

async function validateSvgInput(buffer, maxPixels) {
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw toolError("O SVG deve estar codificado em UTF-8.", 422);
  }
  source = source.replace(/^\uFEFF/, "");
  if (/\0/.test(source)) throw toolError("O SVG contém bytes inválidos.", 422);
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source))
    throw toolError("SVG com DOCTYPE ou entidades personalizadas não é permitido.", 422);
  if (/<\?(?!xml\s)[\s\S]*?\?>/i.test(source))
    throw toolError("O SVG contém uma instrução de processamento não permitida.", 422);
  rejectUnsafeEntityReferences(source);

  const validation = XMLValidator.validate(source, { allowBooleanAttributes: false });
  if (validation !== true) throw toolError("O SVG enviado possui XML inválido.", 422);

  let document;
  try {
    document = new XMLParser({
      allowBooleanAttributes: false,
      ignoreAttributes: false,
      ignoreDeclaration: false,
      parseAttributeValue: false,
      parseTagValue: false,
      processEntities: false,
      trimValues: false,
    }).parse(source);
  } catch {
    throw toolError("Não foi possível interpretar o SVG com segurança.", 422);
  }

  const roots = Object.keys(document).filter((name) => !name.startsWith("?"));
  if (roots.length !== 1 || localXmlName(roots[0]) !== "svg")
    throw toolError("O arquivo XML enviado não possui um elemento SVG raiz.", 415);

  const counters = { elements: 0, attributes: 0, embeddedBytes: 0, embeddedImages: [] };
  inspectSvgNode(roots[0], document[roots[0]], 1, counters);
  for (const embeddedImage of counters.embeddedImages) {
    let metadata;
    try {
      metadata = await sharp(embeddedImage, {
        animated: false,
        failOn: "error",
        limitInputPixels: maxPixels,
      }).metadata();
    } catch {
      throw toolError("O SVG contém uma imagem incorporada inválida ou excessiva.", 422);
    }
    if (
      !INPUT_FORMATS.has(metadata.format) ||
      metadata.format === "svg" ||
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > maxPixels ||
      Number(metadata.pages || 1) > 1
    )
      throw toolError("O SVG contém uma imagem incorporada não permitida.", 422);
  }
}

function inspectSvgNode(tagName, value, depth, counters) {
  if (depth > 96) throw toolError("O SVG excede o limite de profundidade.", 413);
  if (Array.isArray(value)) {
    for (const item of value) inspectSvgNode(tagName, item, depth, counters);
    return;
  }
  counters.elements += 1;
  if (counters.elements > 20_000)
    throw toolError("O SVG excede o limite de elementos.", 413);
  const element = localXmlName(tagName);
  if (FORBIDDEN_SVG_ELEMENTS.has(element))
    throw toolError(`O elemento SVG <${element}> não é permitido.`, 422);
  if (!value || typeof value !== "object") return;

  for (const [name, child] of Object.entries(value)) {
    if (name.startsWith("@_")) {
      counters.attributes += 1;
      if (counters.attributes > 80_000)
        throw toolError("O SVG excede o limite de atributos.", 413);
      inspectSvgAttribute(name.slice(2), child, element, counters);
      continue;
    }
    if (name === "#text" || name === "#cdata") continue;
    inspectSvgNode(name, child, depth + 1, counters);
  }
}

function inspectSvgAttribute(name, rawValue, element, counters) {
  const qualifiedName = String(name).toLowerCase();
  const attribute = localXmlName(name);
  const value = String(rawValue ?? "").trim();
  if (qualifiedName === "xmlns" || qualifiedName.startsWith("xmlns:")) return;
  if (attribute.startsWith("on"))
    throw toolError("Eventos JavaScript não são permitidos em SVG.", 422);
  if (attribute === "style")
    throw toolError("Estilos CSS embutidos não são permitidos em SVG.", 422);
  if (attribute === "href" && element === "image") {
    const embedded = value.match(
      /^data:image\/(png|jpeg|webp|gif|avif);base64,([A-Za-z\d+/]+={0,2})$/i,
    );
    if (!embedded)
      throw toolError("Imagens dentro do SVG devem ser rasters incorporados e seguros.", 422);
    const imageBuffer = Buffer.from(embedded[2], "base64");
    counters.embeddedBytes += imageBuffer.length;
    counters.embeddedImages.push(imageBuffer);
    if (counters.embeddedImages.length > 8 || counters.embeddedBytes > 12 * 1024 * 1024)
      throw toolError("O SVG excede o limite de imagens incorporadas.", 413);
    return;
  }
  if (attribute === "href" && value && !/^#[A-Za-z_][\w:.-]*$/.test(value))
    throw toolError("O SVG não pode carregar links ou recursos externos.", 422);
  if (/(?:javascript|data|file|https?|ftp)\s*:/i.test(value) || /^[/\\]{2}/.test(value))
    throw toolError("O SVG contém uma referência externa não permitida.", 422);
  for (const match of value.matchAll(/url\s*\(\s*([^)]*?)\s*\)/gi)) {
    const reference = match[1].replace(/^['"]|['"]$/g, "").trim();
    if (!/^#[A-Za-z_][\w:.-]*$/.test(reference))
      throw toolError("O SVG não pode carregar recursos externos.", 422);
  }
}

function rejectUnsafeEntityReferences(source) {
  for (const match of source.matchAll(/&([^;\s]{1,64});/g)) {
    const entity = match[1];
    if (
      !SAFE_XML_ENTITIES.has(entity) &&
      !/^#\d+$/.test(entity) &&
      !/^#x[\da-f]+$/i.test(entity)
    )
      throw toolError("O SVG contém uma entidade XML não permitida.", 422);
  }
}

function localXmlName(name) {
  return String(name).split(":").pop().toLowerCase();
}

function removeUniformBackground(data, info, tolerance) {
  const { width, height, channels } = info;
  if (channels !== 4) throw toolError("A imagem não possui canais RGBA válidos.", 422);
  const background = estimateEdgeColor(data, width, height, channels);
  const totalPixels = width * height;
  const visited = new Uint8Array(totalPixels);
  const queue = new Uint32Array(totalPixels);
  let head = 0;
  let tail = 0;
  const toleranceSquared = tolerance * tolerance;

  function visit(pixelIndex) {
    if (visited[pixelIndex]) return;
    visited[pixelIndex] = 1;
    const offset = pixelIndex * channels;
    if (data[offset + 3] === 0) {
      queue[tail++] = pixelIndex;
      return;
    }
    const red = data[offset] - background.red;
    const green = data[offset + 1] - background.green;
    const blue = data[offset + 2] - background.blue;
    const distanceSquared = red * red + green * green + blue * blue;
    if (distanceSquared > toleranceSquared) return;
    const distance = Math.sqrt(distanceSquared);
    const featherStart = tolerance * 0.45;
    data[offset + 3] =
      distance <= featherStart
        ? 0
        : Math.min(255, Math.round(((distance - featherStart) / (tolerance - featherStart)) * 255));
    queue[tail++] = pixelIndex;
  }

  for (let x = 0; x < width; x += 1) {
    visit(x);
    visit((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    visit(y * width);
    visit(y * width + width - 1);
  }

  while (head < tail) {
    const pixel = queue[head++];
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    if (x > 0) visit(pixel - 1);
    if (x + 1 < width) visit(pixel + 1);
    if (y > 0) visit(pixel - width);
    if (y + 1 < height) visit(pixel + width);
  }
}

function estimateEdgeColor(data, width, height, channels) {
  const buckets = new Map();
  const stepX = Math.max(1, Math.floor(width / 250));
  const stepY = Math.max(1, Math.floor(height / 250));
  function sample(pixel) {
    const offset = pixel * channels;
    if (data[offset + 3] < 16) return;
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    const key = `${red >> 4}:${green >> 4}:${blue >> 4}`;
    const bucket = buckets.get(key) || { count: 0, red: 0, green: 0, blue: 0 };
    bucket.count += 1;
    bucket.red += red;
    bucket.green += green;
    bucket.blue += blue;
    buckets.set(key, bucket);
  }
  for (let x = 0; x < width; x += stepX) {
    sample(x);
    sample((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += stepY) {
    sample(y * width);
    sample(y * width + width - 1);
  }
  const winner = [...buckets.values()].sort((left, right) => right.count - left.count)[0];
  if (!winner) return { red: 255, green: 255, blue: 255 };
  return {
    red: winner.red / winner.count,
    green: winner.green / winner.count,
    blue: winner.blue / winner.count,
  };
}

function normalizeFormat(value) {
  const format = String(value || "").toLowerCase();
  return format === "jpg" ? "jpeg" : format;
}

function parseBoolean(value) {
  return value === true || value === "true" || value === "1" || value === "on";
}

function integerInRange(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(number)));
}

function optionalInteger(value, minimum, maximum, label) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum)
    throw toolError(`Informe uma ${label} entre ${minimum} e ${maximum} pixels.`, 400);
  return number;
}

function outputFilename(filename, target, backgroundRemoved) {
  const base = path
    .basename(String(filename || "imagem"), path.extname(String(filename || "")))
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
    .slice(0, 120);
  const suffix = backgroundRemoved ? "-sem-fundo" : "-convertida";
  return `${base || "imagem"}${suffix}.${EXTENSIONS[target]}`;
}

module.exports = { ImageConverter };
