const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const sharp = require("sharp");

const projectRoot = path.resolve(__dirname, "..");
const exportDirectory = path.join(projectRoot, "Export");
const baseUrl = String(process.env.EXPORT_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");

run().catch((error) => {
  console.error(`Falha ao gerar amostras: ${error.message}`);
  process.exitCode = 1;
});

async function run() {
  await fs.promises.mkdir(exportDirectory, { recursive: true });
  const image = await createSampleImage();
  const text = Buffer.from(
    [
      "VAULTKEEP // TESTE DE CONVERSÃO",
      "",
      "Este arquivo valida acentuação: ação, proteção, usuário e informação.",
      "Ele também verifica múltiplas linhas e símbolos: < > & \" '.",
      "",
      "Trecho PowerShell:",
      "Get-Process | Sort-Object CPU -Descending | Select-Object -First 5",
      "",
      "Status esperado: conteúdo preservado e saída somente para download.",
    ].join("\n"),
    "utf8",
  );

  await fs.promises.writeFile(path.join(exportDirectory, "imagem-original.png"), image);
  await fs.promises.writeFile(path.join(exportDirectory, "texto-original.txt"), text);

  const imageCapabilities = await getJson("/api/tools/images/capabilities");
  const documentCapabilities = await getJson("/api/tools/documents/capabilities");
  const generated = [
    await describeFile("imagem-original.png"),
    await describeFile("texto-original.txt"),
  ];

  for (const format of ["jpeg", "png", "webp", "avif", "tiff", "gif", "svg"]) {
    const advertisedFormat = format === "jpeg" ? "jpg" : format;
    if (!imageCapabilities.outputs.includes(advertisedFormat)) continue;
    const result = await convert(
      "/api/tools/images/convert",
      image,
      "imagem-original.png",
      "image/png",
      { format, quality: "86", removeBackground: "false" },
    );
    const filename = `imagem-convertida.${extensionForImage(format)}`;
    await fs.promises.writeFile(path.join(exportDirectory, filename), result);
    generated.push(await describeFile(filename));
  }

  if (imageCapabilities.backgroundRemoval?.available) {
    const result = await convert(
      "/api/tools/images/convert",
      image,
      "imagem-original.png",
      "image/png",
      { format: "png", quality: "90", removeBackground: "true", tolerance: "32" },
    );
    const filename = "imagem-sem-fundo.png";
    await fs.promises.writeFile(path.join(exportDirectory, filename), result);
    generated.push(await describeFile(filename));
  }

  for (const target of [
    "docx",
    "pdf",
    "md",
    "html",
    "rtf",
    "xlsx",
    "csv",
    "tsv",
    "json",
    "xml",
    "yaml",
  ]) {
    if (!documentCapabilities.outputs.includes(target)) continue;
    const result = await convert(
      "/api/tools/documents/convert",
      text,
      "texto-original.txt",
      "text/plain",
      { target },
    );
    const filename = `texto-convertido.${target}`;
    await fs.promises.writeFile(path.join(exportDirectory, filename), result);
    generated.push(await describeFile(filename));
  }

  const manifest = [
    "VAULTKEEP // MANIFESTO DO TESTE DE CONVERSÃO",
    `Servidor testado: ${baseUrl}`,
    `Gerado em: ${new Date().toISOString()}`,
    "",
    "Arquivo | Bytes | SHA-256",
    ...generated.map((file) => `${file.name} | ${file.size} | ${file.sha256}`),
    "",
    `Total: ${generated.length} arquivos de conteúdo + este manifesto.`,
  ].join("\r\n");
  await fs.promises.writeFile(
    path.join(exportDirectory, "manifesto-conversoes.txt"),
    manifest,
    "utf8",
  );
  console.log(`OK: ${generated.length} arquivos gerados em ${exportDirectory}`);
}

async function createSampleImage() {
  const overlay = Buffer.from(`
    <svg width="960" height="600" viewBox="0 0 960 600" xmlns="http://www.w3.org/2000/svg">
      <rect x="300" y="125" width="360" height="245" rx="28" fill="#f2c94c"/>
      <path d="M340 125V92Q340 76 356 76H470Q488 76 496 92L514 125Z" fill="#d6a929"/>
      <circle cx="480" cy="247" r="72" fill="#082842"/>
      <circle cx="480" cy="247" r="44" fill="none" stroke="#f2c94c" stroke-width="4"/>
      <path d="M480 183V311M416 247H544" stroke="#f2c94c" stroke-width="4"/>
      <circle cx="480" cy="247" r="13" fill="#f2c94c"/>
      <text x="480" y="440" text-anchor="middle" fill="#ffffff" font-size="50" font-weight="800" font-family="Arial">VAULTKEEP</text>
      <text x="480" y="485" text-anchor="middle" fill="#f2c94c" font-size="22" font-weight="700" letter-spacing="6" font-family="Arial">CONVERSION TEST</text>
      <text x="480" y="535" text-anchor="middle" fill="#9db8cb" font-size="16" font-family="Arial">960 × 600 · PNG ORIGINAL</text>
    </svg>
  `);
  return sharp({
    create: { width: 960, height: 600, channels: 3, background: "#082842" },
  })
    .composite([{ input: overlay }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function getJson(route) {
  const response = await fetch(`${baseUrl}${route}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${route} respondeu HTTP ${response.status}`);
  return response.json();
}

async function convert(route, buffer, filename, mimeType, fields) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType }), filename);
  Object.entries(fields).forEach(([key, value]) => form.append(key, value));
  const response = await fetch(`${baseUrl}${route}`, { method: "POST", body: form });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      message = (await response.json()).error || message;
    } catch {
      /* A mensagem HTTP ainda identifica a falha. */
    }
    throw new Error(`${filename} → ${fields.target || fields.format}: ${message}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function describeFile(name) {
  const buffer = await fs.promises.readFile(path.join(exportDirectory, name));
  return {
    name,
    size: buffer.length,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
  };
}

function extensionForImage(format) {
  return format === "jpeg" ? "jpg" : format === "tiff" ? "tif" : format;
}
