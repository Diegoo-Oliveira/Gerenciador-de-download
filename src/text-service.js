const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const hljs = require("highlight.js");

const fsp = fs.promises;
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".log",
  ".csv",
  ".tsv",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".json",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".xml",
  ".svg",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".properties",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".psm1",
  ".psd1",
  ".bat",
  ".cmd",
  ".py",
  ".pyw",
  ".rb",
  ".php",
  ".java",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cc",
  ".cs",
  ".go",
  ".rs",
  ".sql",
  ".graphql",
  ".gql",
  ".lua",
  ".r",
  ".pl",
  ".vue",
  ".svelte",
  ".astro",
  ".env",
  ".gitignore",
  ".dockerignore",
]);

const LANGUAGE_BY_EXTENSION = new Map([
  [".md", "markdown"],
  [".markdown", "markdown"],
  [".js", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".jsx", "javascript"],
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".json", "json"],
  [".html", "html"],
  [".htm", "html"],
  [".xml", "xml"],
  [".svg", "xml"],
  [".css", "css"],
  [".scss", "scss"],
  [".sass", "sass"],
  [".less", "less"],
  [".yaml", "yaml"],
  [".yml", "yaml"],
  [".toml", "ini"],
  [".ini", "ini"],
  [".cfg", "ini"],
  [".conf", "ini"],
  [".properties", "properties"],
  [".sh", "bash"],
  [".bash", "bash"],
  [".zsh", "bash"],
  [".fish", "bash"],
  [".ps1", "powershell"],
  [".psm1", "powershell"],
  [".psd1", "powershell"],
  [".bat", "dos"],
  [".cmd", "dos"],
  [".py", "python"],
  [".pyw", "python"],
  [".rb", "ruby"],
  [".php", "php"],
  [".java", "java"],
  [".c", "c"],
  [".h", "c"],
  [".cpp", "cpp"],
  [".hpp", "cpp"],
  [".cc", "cpp"],
  [".cs", "csharp"],
  [".go", "go"],
  [".rs", "rust"],
  [".sql", "sql"],
  [".graphql", "graphql"],
  [".gql", "graphql"],
  [".lua", "lua"],
  [".r", "r"],
  [".pl", "perl"],
  [".vue", "html"],
  [".svelte", "html"],
  [".astro", "html"],
]);

const AUTO_LANGUAGES = [
  "javascript",
  "typescript",
  "json",
  "xml",
  "css",
  "bash",
  "powershell",
  "python",
  "ruby",
  "php",
  "java",
  "c",
  "cpp",
  "csharp",
  "go",
  "rust",
  "sql",
  "yaml",
  "markdown",
  "ini",
  "lua",
  "r",
  "perl",
  "graphql",
];

function isTextCandidate(file, maxBytes) {
  if (Number(file.size) > maxBytes) return false;
  const extension = path.extname(file.name || "").toLowerCase();
  const basename = path.basename(file.name || "").toLowerCase();
  return (
    TEXT_EXTENSIONS.has(extension) ||
    TEXT_EXTENSIONS.has(`.${basename}`) ||
    basename === "dockerfile" ||
    basename === "makefile" ||
    String(file.mimeType || "").startsWith("text/") ||
    /(?:json|javascript|xml|yaml|toml|sql)/i.test(String(file.mimeType || ""))
  );
}

async function probeTextFile(filename, file, maxBytes) {
  if (Number(file.size) > maxBytes) return false;
  const handle = await fsp.open(filename, "r");
  try {
    const sampleSize = Math.min(64 * 1024, Number(file.size));
    const sample = Buffer.alloc(sampleSize);
    await handle.read(sample, 0, sampleSize, 0);
    decodeText(sample);
    return true;
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}

async function readTextFile(filename, maxBytes) {
  const stat = await fsp.stat(filename);
  if (stat.size > maxBytes)
    throw httpError(
      `Este arquivo excede o limite de edição de ${formatMegabytes(maxBytes)}.`,
      413,
    );
  const buffer = await fsp.readFile(filename);
  const decoded = decodeText(buffer);
  return {
    ...decoded,
    revision: crypto.createHash("sha256").update(buffer).digest("hex"),
    size: buffer.length,
  };
}

async function writeTextFile(
  filename,
  content,
  encoding = "utf8",
  maxBytes = Number.POSITIVE_INFINITY,
) {
  const buffer = encodeText(String(content), encoding);
  if (buffer.length > maxBytes)
    throw httpError(
      `Este arquivo excede o limite de edição de ${formatMegabytes(maxBytes)}.`,
      413,
    );
  const temporary = `${filename}.${crypto.randomUUID()}.editing`;
  await fsp.writeFile(temporary, buffer);
  await fsp.rename(temporary, filename);
  return {
    size: buffer.length,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
  };
}

function detectLanguage(name, content) {
  const extension = path.extname(name || "").toLowerCase();
  const basename = path.basename(name || "").toLowerCase();
  if (LANGUAGE_BY_EXTENSION.has(extension))
    return LANGUAGE_BY_EXTENSION.get(extension);
  if (basename === "dockerfile") return "dockerfile";
  if (basename === "makefile") return "makefile";
  if (extension === ".txt" || extension === ".log" || !extension) {
    const result = hljs.highlightAuto(
      String(content).slice(0, 60_000),
      AUTO_LANGUAGES,
    );
    if (result.language && result.relevance >= 4) return result.language;
  }
  return "plaintext";
}

function mimeTypeForText(name) {
  const extension = path.extname(name).toLowerCase();
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".html" || extension === ".htm")
    return "text/html; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".md" || extension === ".markdown")
    return "text/markdown; charset=utf-8";
  if (extension === ".csv") return "text/csv; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function decodeText(buffer) {
  if (
    buffer.includes(0) &&
    !(buffer[0] === 0xff && buffer[1] === 0xfe) &&
    !(buffer[0] === 0xfe && buffer[1] === 0xff)
  ) {
    throw httpError(
      "O arquivo contém dados binários e não pode ser editado como texto.",
      415,
    );
  }
  try {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) {
      return {
        content: new TextDecoder("utf-16le", { fatal: true }).decode(
          buffer.subarray(2),
        ),
        encoding: "utf16le",
      };
    }
    if (buffer[0] === 0xfe && buffer[1] === 0xff) {
      return {
        content: new TextDecoder("utf-16be", { fatal: true }).decode(
          buffer.subarray(2),
        ),
        encoding: "utf16be",
      };
    }
    const start =
      buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 3 : 0;
    return {
      content: new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(start),
      ),
      encoding: "utf8",
    };
  } catch (error) {
    if (error.status) throw error;
    throw httpError(
      "O arquivo não usa uma codificação de texto compatível.",
      415,
    );
  }
}

function encodeText(content, encoding) {
  if (encoding === "utf16le")
    return Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(content, "utf16le"),
    ]);
  if (encoding === "utf16be") {
    const littleEndian = Buffer.from(content, "utf16le");
    for (let index = 0; index < littleEndian.length; index += 2) {
      [littleEndian[index], littleEndian[index + 1]] = [
        littleEndian[index + 1],
        littleEndian[index],
      ];
    }
    return Buffer.concat([Buffer.from([0xfe, 0xff]), littleEndian]);
  }
  return Buffer.from(content, "utf8");
}

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function formatMegabytes(bytes) {
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

module.exports = {
  detectLanguage,
  isTextCandidate,
  mimeTypeForText,
  probeTextFile,
  readTextFile,
  writeTextFile,
};
