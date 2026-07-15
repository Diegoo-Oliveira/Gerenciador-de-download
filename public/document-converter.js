const state = {
  file: null,
  maxBytes: 10 * 1024 * 1024,
  resultUrl: null,
};

const outputFormats = [
  "docx",
  "pdf",
  "md",
  "txt",
  "html",
  "rtf",
  "xlsx",
  "csv",
  "tsv",
  "json",
  "xml",
  "yaml",
];
const sourceAliases = { yml: "yaml", htm: "html" };
const inputFormats = ["pdf", "docx", "xlsx", "csv", "tsv", "json", "xml", "yaml", "yml", "html", "htm", "txt", "md"];
const targetsBySource = Object.fromEntries(
  inputFormats.map((source) => [
    source,
    outputFormats.filter((target) => target !== (sourceAliases[source] || source)),
  ]),
);

const labels = {
  docx: "Word (.docx)",
  pdf: "PDF",
  md: "Markdown (.md)",
  txt: "Texto (.txt)",
  html: "Página HTML",
  rtf: "Rich Text (.rtf)",
  xlsx: "Excel (.xlsx)",
  csv: "CSV",
  tsv: "TSV",
  json: "JSON",
  xml: "XML",
  yaml: "YAML",
};
const elements = Object.fromEntries(
  [
    "documentForm",
    "documentDrop",
    "documentFile",
    "documentSelected",
    "documentFileType",
    "documentFileName",
    "documentFileMeta",
    "clearDocument",
    "documentTarget",
    "documentSubmit",
    "documentError",
    "documentProgress",
    "documentResult",
    "documentResultMeta",
    "documentDownload",
    "documentLimit",
  ].map((id) => [id, document.querySelector(`#${id}`)]),
);

bindEvents();
loadCapabilities();

function bindEvents() {
  elements.documentFile.addEventListener("change", () => selectFile(elements.documentFile.files[0]));
  elements.clearDocument.addEventListener("click", clearFile);
  elements.documentTarget.addEventListener("change", updateSubmitState);
  elements.documentForm.addEventListener("submit", convertDocument);
  ["dragenter", "dragover"].forEach((name) =>
    elements.documentDrop.addEventListener(name, (event) => {
      event.preventDefault();
      elements.documentDrop.classList.add("dragging");
    }),
  );
  ["dragleave", "drop"].forEach((name) =>
    elements.documentDrop.addEventListener(name, (event) => {
      event.preventDefault();
      elements.documentDrop.classList.remove("dragging");
    }),
  );
  elements.documentDrop.addEventListener("drop", (event) => selectFile(event.dataTransfer.files[0]));
}

async function loadCapabilities() {
  try {
    const response = await fetch("/api/tools/documents/capabilities", { cache: "no-store" });
    if (!response.ok) return;
    const capabilities = await response.json();
    state.maxBytes = capabilities.maxBytes || state.maxBytes;
    elements.documentLimit.textContent = `Até ${formatBytes(state.maxBytes)}`;
  } catch {
    /* O limite padrão continua visível se a consulta falhar. */
  }
}

function selectFile(file) {
  resetResult();
  elements.documentError.textContent = "";
  if (!file) return;
  const extension = extensionOf(file.name);
  if (!targetsBySource[extension])
    return rejectFile("Use PDF, DOCX, XLSX, CSV, TSV, JSON, XML, YAML, HTML, TXT ou MD.");
  if (file.size > state.maxBytes)
    return rejectFile(`O arquivo excede o limite de ${formatBytes(state.maxBytes)}.`);
  if (!file.size) return rejectFile("O arquivo está vazio.");

  state.file = file;
  elements.documentFileType.textContent = extension.toUpperCase();
  elements.documentFileName.textContent = file.name;
  elements.documentFileMeta.textContent = `${formatBytes(file.size)} · pronto para conversão`;
  elements.documentSelected.classList.remove("hidden");
  populateTargets(extension);
  updateSubmitState();
}

function populateTargets(source) {
  elements.documentTarget.innerHTML =
    '<option value="">Escolha o formato final</option>' +
    targetsBySource[source]
      .map((target) => `<option value="${target}">${labels[target]}</option>`)
      .join("");
  elements.documentTarget.disabled = false;
}

function clearFile() {
  state.file = null;
  elements.documentFile.value = "";
  elements.documentSelected.classList.add("hidden");
  elements.documentTarget.innerHTML = '<option value="">Selecione após enviar o arquivo</option>';
  elements.documentTarget.disabled = true;
  elements.documentError.textContent = "";
  resetResult();
  updateSubmitState();
}

function rejectFile(message) {
  state.file = null;
  elements.documentFile.value = "";
  elements.documentSelected.classList.add("hidden");
  elements.documentTarget.innerHTML = '<option value="">Selecione após enviar o arquivo</option>';
  elements.documentTarget.disabled = true;
  elements.documentError.textContent = message;
  updateSubmitState();
}

async function convertDocument(event) {
  event.preventDefault();
  if (!state.file || !elements.documentTarget.value) return;
  setBusy(true);
  elements.documentError.textContent = "";
  resetResult();
  const formData = new FormData();
  formData.append("file", state.file, state.file.name);
  formData.append("target", elements.documentTarget.value);
  try {
    const response = await fetch("/api/tools/documents/convert", {
      method: "POST",
      body: formData,
    });
    if (!response.ok) throw new Error(await responseError(response));
    const blob = await response.blob();
    state.resultUrl = URL.createObjectURL(blob);
    const filename = downloadFilename(response) || `documento-convertido.${elements.documentTarget.value}`;
    elements.documentDownload.href = state.resultUrl;
    elements.documentDownload.download = filename;
    elements.documentResultMeta.textContent = `${filename} · ${formatBytes(blob.size)}`;
    elements.documentResult.classList.remove("hidden");
  } catch (error) {
    showError(error.message);
  } finally {
    setBusy(false);
  }
}

function setBusy(busy) {
  elements.documentSubmit.disabled = busy || !state.file || !elements.documentTarget.value;
  elements.documentProgress.classList.toggle("hidden", !busy);
  elements.documentFile.disabled = busy;
  elements.documentTarget.disabled = busy || !state.file;
}

function updateSubmitState() {
  elements.documentSubmit.disabled = !state.file || !elements.documentTarget.value;
}

function resetResult() {
  if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
  state.resultUrl = null;
  elements.documentResult.classList.add("hidden");
  elements.documentDownload.removeAttribute("href");
}

function showError(message) {
  elements.documentError.textContent = message;
  updateSubmitState();
}

async function responseError(response) {
  try {
    const body = await response.json();
    return body.error || "Não foi possível concluir a conversão.";
  } catch {
    return "Não foi possível concluir a conversão.";
  }
}

function downloadFilename(response) {
  const disposition = response.headers.get("content-disposition") || "";
  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8) return decodeURIComponent(utf8[1]);
  const basic = disposition.match(/filename="?([^";]+)"?/i);
  return basic?.[1] || null;
}

function extensionOf(filename) {
  return String(filename).split(".").pop().toLowerCase();
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** power).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} ${units[power]}`;
}
