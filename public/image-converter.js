const state = {
  file: null,
  maxBytes: 12 * 1024 * 1024,
  pdfMaxBytes: 10 * 1024 * 1024,
  isPdf: false,
  inputUrl: null,
  resultUrl: null,
};

const validExtensions = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif", "tif", "tiff", "svg", "pdf"]);
const alphaFormats = new Set(["png", "webp", "gif", "avif", "tiff", "svg"]);
const localPreviewFormats = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif"]);
const elements = Object.fromEntries(
  [
    "imageForm", "imageDrop", "imageFile", "imagePreview", "imageDropCopy",
    "imageSelected", "imageFileType", "imageFileName", "imageFileMeta", "clearImage",
    "imageFormat", "imageQuality", "qualityValue", "imageWidth", "imageHeight",
    "imageDpi", "pdfDpiOption", "backgroundOption", "removeBackground",
    "toleranceOption", "backgroundTolerance", "toleranceValue",
    "imageSubmit", "imageError", "imageProgress", "imageResult", "imageResultPreview",
    "imageResultMeta", "imageDownload", "imageLimit",
  ].map((id) => [id, document.querySelector(`#${id}`)]),
);

bindEvents();
loadCapabilities();

function bindEvents() {
  elements.imageFile.addEventListener("change", () => selectImage(elements.imageFile.files[0]));
  elements.clearImage.addEventListener("click", clearImage);
  elements.imageQuality.addEventListener("input", () => {
    elements.qualityValue.textContent = elements.imageQuality.value;
  });
  elements.backgroundTolerance.addEventListener("input", () => {
    elements.toleranceValue.textContent = elements.backgroundTolerance.value;
  });
  elements.removeBackground.addEventListener("change", updateBackgroundOption);
  elements.imageFormat.addEventListener("change", updateBackgroundOption);
  elements.imageForm.addEventListener("submit", convertImage);
  ["dragenter", "dragover"].forEach((name) =>
    elements.imageDrop.addEventListener(name, (event) => {
      event.preventDefault();
      elements.imageDrop.classList.add("dragging");
    }),
  );
  ["dragleave", "drop"].forEach((name) =>
    elements.imageDrop.addEventListener(name, (event) => {
      event.preventDefault();
      elements.imageDrop.classList.remove("dragging");
    }),
  );
  elements.imageDrop.addEventListener("drop", (event) => selectImage(event.dataTransfer.files[0]));
}

async function loadCapabilities() {
  try {
    const response = await fetch("/api/tools/images/capabilities", { cache: "no-store" });
    if (!response.ok) return;
    const capabilities = await response.json();
    state.maxBytes = capabilities.maxBytes || state.maxBytes;
    state.pdfMaxBytes = capabilities.pdfMaxBytes || state.pdfMaxBytes;
    updateLimitCopy();
  } catch {
    /* Mantém o limite padrão. */
  }
}

function selectImage(file) {
  resetResult();
  elements.imageError.textContent = "";
  if (!file) return;
  const extension = extensionOf(file.name);
  if (!validExtensions.has(extension))
    return rejectImage("Use JPG, PNG, WEBP, GIF, AVIF, TIFF, SVG ou PDF.");
  state.isPdf = extension === "pdf";
  const applicableLimit = state.isPdf ? state.pdfMaxBytes : state.maxBytes;
  if (file.size > applicableLimit)
    return rejectImage(
      `${state.isPdf ? "O PDF" : "A imagem"} excede o limite de ${formatBytes(applicableLimit)}.`,
    );
  if (!file.size) return rejectImage("A imagem está vazia.");
  state.file = file;
  if (state.inputUrl) URL.revokeObjectURL(state.inputUrl);
  state.inputUrl = null;
  if (localPreviewFormats.has(extension)) {
    state.inputUrl = URL.createObjectURL(file);
    elements.imagePreview.src = state.inputUrl;
    elements.imagePreview.classList.remove("hidden");
    elements.imageDropCopy.classList.add("hidden");
  } else {
    elements.imagePreview.removeAttribute("src");
    elements.imagePreview.classList.add("hidden");
    elements.imageDropCopy.classList.remove("hidden");
    elements.imageDropCopy.querySelector("strong").textContent = state.isPdf
      ? "PDF selecionado"
      : "Prévia protegida";
    elements.imageDropCopy.querySelector("small").textContent =
      state.isPdf
        ? "Cada página será renderizada com segurança no servidor"
        : "SVG e TIFF são validados no servidor antes do processamento";
  }
  elements.imageFileType.textContent = extension.toUpperCase();
  elements.imageFileName.textContent = file.name;
  elements.imageFileMeta.textContent = `${formatBytes(file.size)} · pronto para conversão`;
  elements.imageSelected.classList.remove("hidden");
  elements.imageSubmit.disabled = false;
  updateSourceOptions();
  updateLimitCopy();
}

function clearImage() {
  state.file = null;
  state.isPdf = false;
  elements.imageFile.value = "";
  if (state.inputUrl) URL.revokeObjectURL(state.inputUrl);
  state.inputUrl = null;
  elements.imagePreview.removeAttribute("src");
  elements.imagePreview.classList.add("hidden");
  elements.imageDropCopy.classList.remove("hidden");
  restoreDropCopy();
  elements.imageSelected.classList.add("hidden");
  elements.imageError.textContent = "";
  elements.imageSubmit.disabled = true;
  updateSourceOptions();
  updateLimitCopy();
  resetResult();
}

function rejectImage(message) {
  state.file = null;
  state.isPdf = false;
  elements.imageFile.value = "";
  if (state.inputUrl) URL.revokeObjectURL(state.inputUrl);
  state.inputUrl = null;
  elements.imagePreview.removeAttribute("src");
  elements.imagePreview.classList.add("hidden");
  elements.imageDropCopy.classList.remove("hidden");
  restoreDropCopy();
  elements.imageSelected.classList.add("hidden");
  elements.imageSubmit.disabled = true;
  elements.imageError.textContent = message;
  updateSourceOptions();
  updateLimitCopy();
}

function updateBackgroundOption() {
  const enabled = !state.isPdf && elements.removeBackground.checked;
  elements.toleranceOption.classList.toggle("hidden", !enabled);
  if (enabled && !alphaFormats.has(elements.imageFormat.value)) {
    elements.imageFormat.value = "png";
  }
}

function updateSourceOptions() {
  elements.pdfDpiOption.classList.toggle("hidden", !state.isPdf);
  elements.backgroundOption.classList.toggle("hidden", state.isPdf);
  if (state.isPdf) elements.removeBackground.checked = false;
  elements.removeBackground.disabled = state.isPdf;
  updateBackgroundOption();
}

function updateLimitCopy() {
  elements.imageLimit.textContent = state.isPdf
    ? `PDF até ${formatBytes(state.pdfMaxBytes)}`
    : `Imagens até ${formatBytes(state.maxBytes)} · PDF até ${formatBytes(state.pdfMaxBytes)}`;
}

async function convertImage(event) {
  event.preventDefault();
  if (!state.file) return;
  setBusy(true);
  elements.imageError.textContent = "";
  resetResult();
  const formData = new FormData();
  formData.append("file", state.file, state.file.name);
  formData.append("format", elements.imageFormat.value);
  formData.append("quality", elements.imageQuality.value);
  formData.append("width", elements.imageWidth.value);
  formData.append("height", elements.imageHeight.value);
  formData.append("removeBackground", String(elements.removeBackground.checked));
  formData.append("tolerance", elements.backgroundTolerance.value);
  formData.append("dpi", elements.imageDpi.value);
  try {
    const response = await fetch("/api/tools/images/convert", { method: "POST", body: formData });
    if (!response.ok) throw new Error(await responseError(response));
    const blob = await response.blob();
    state.resultUrl = URL.createObjectURL(blob);
    const filename = downloadFilename(response) || `imagem-convertida.${elements.imageFormat.value}`;
    const contentType = response.headers.get("content-type") || "";
    const pages = Number(response.headers.get("x-pdf-pages") || 0);
    const isArchive = contentType.includes("application/zip");
    if (elements.imageFormat.value === "tiff" || isArchive) {
      elements.imageResultPreview.removeAttribute("src");
      elements.imageResultPreview.classList.add("hidden");
    } else {
      elements.imageResultPreview.src = state.resultUrl;
      elements.imageResultPreview.classList.remove("hidden");
    }
    elements.imageDownload.href = state.resultUrl;
    elements.imageDownload.download = filename;
    elements.imageDownload.textContent = isArchive ? "Baixar ZIP ↓" : "Baixar imagem ↓";
    const width = response.headers.get("x-image-width");
    const height = response.headers.get("x-image-height");
    const dimensions = width && height ? ` · ${width} × ${height}` : "";
    const pageCopy = pages ? ` · ${pages} ${pages === 1 ? "página" : "páginas"}` : "";
    elements.imageResultMeta.textContent = `${filename}${pageCopy}${dimensions} · ${formatBytes(blob.size)}`;
    elements.imageResult.classList.remove("hidden");
  } catch (error) {
    showError(error.message);
  } finally {
    setBusy(false);
  }
}

function setBusy(busy) {
  elements.imageSubmit.disabled = busy || !state.file;
  elements.imageProgress.classList.toggle("hidden", !busy);
  [elements.imageFile, elements.imageFormat, elements.imageQuality, elements.imageWidth,
    elements.imageHeight, elements.imageDpi, elements.removeBackground, elements.backgroundTolerance]
    .forEach((element) => { element.disabled = busy; });
  if (!busy) updateSourceOptions();
}

function resetResult() {
  if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
  state.resultUrl = null;
  elements.imageResult.classList.add("hidden");
  elements.imageResultPreview.removeAttribute("src");
  elements.imageResultPreview.classList.remove("hidden");
  elements.imageDownload.removeAttribute("href");
  elements.imageDownload.textContent = "Baixar imagem ↓";
}

function showError(message) {
  elements.imageError.textContent = message;
}

function restoreDropCopy() {
  elements.imageDropCopy.querySelector("strong").textContent = "Solte a imagem ou PDF nesta área";
  elements.imageDropCopy.querySelector("small").textContent =
    "JPG, PNG, WEBP, GIF, AVIF, TIFF, SVG ou PDF";
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
  return disposition.match(/filename="?([^";]+)"?/i)?.[1] || null;
}

function extensionOf(filename) { return String(filename).split(".").pop().toLowerCase(); }
function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** power).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} ${units[power]}`;
}
