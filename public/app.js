const state = {
  files: [],
  selectedFiles: [],
  uploading: false,
  uploadController: null,
  uploadConfig: { concurrency: 3 },
};

const elements = {
  loginView: document.querySelector("#loginView"),
  appView: document.querySelector("#appView"),
  loginForm: document.querySelector("#loginForm"),
  loginError: document.querySelector("#loginError"),
  password: document.querySelector("#password"),
  togglePassword: document.querySelector("#togglePassword"),
  logoutButton: document.querySelector("#logoutButton"),
  fileList: document.querySelector("#fileList"),
  emptyState: document.querySelector("#emptyState"),
  fileCount: document.querySelector("#fileCount"),
  spaceUsed: document.querySelector("#spaceUsed"),
  searchInput: document.querySelector("#searchInput"),
  uploadModal: document.querySelector("#uploadModal"),
  uploadForm: document.querySelector("#uploadForm"),
  fileInput: document.querySelector("#fileInput"),
  dropZone: document.querySelector("#dropZone"),
  selectedFiles: document.querySelector("#selectedFiles"),
  submitUpload: document.querySelector("#submitUpload"),
  uploadError: document.querySelector("#uploadError"),
  uploadProgress: document.querySelector("#uploadProgress"),
  toast: document.querySelector("#toast"),
};

boot();

async function boot() {
  bindEvents();
  try {
    const session = await api("/api/session");
    if (session.authenticated) await showApp();
  } catch {
    /* A tela de login continua disponível. */
  }
}

function bindEvents() {
  elements.loginForm.addEventListener("submit", login);
  elements.togglePassword.addEventListener("click", () => {
    const isPassword = elements.password.type === "password";
    elements.password.type = isPassword ? "text" : "password";
    elements.togglePassword.setAttribute(
      "aria-label",
      isPassword ? "Ocultar senha" : "Mostrar senha",
    );
  });
  elements.logoutButton.addEventListener("click", logout);
  document.querySelector("#uploadButton").addEventListener("click", openUpload);
  document.querySelector("#emptyUpload").addEventListener("click", openUpload);
  document
    .querySelector("#navFiles")
    .addEventListener("click", () =>
      document.querySelector("#filesSection").scrollIntoView(),
    );
  document
    .querySelector("#mobileMenu")
    .addEventListener("click", () =>
      document.querySelector(".sidebar").classList.toggle("open"),
    );
  document
    .querySelectorAll("[data-close-modal]")
    .forEach((button) => button.addEventListener("click", () => closeUpload()));
  elements.fileInput.addEventListener("change", () =>
    selectFiles(elements.fileInput.files),
  );
  elements.uploadForm.addEventListener("submit", uploadFiles);
  elements.searchInput.addEventListener("input", renderFiles);
  ["dragenter", "dragover"].forEach((eventName) =>
    elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropZone.classList.add("dragging");
    }),
  );
  ["dragleave", "drop"].forEach((eventName) =>
    elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropZone.classList.remove("dragging");
    }),
  );
  elements.dropZone.addEventListener("drop", (event) =>
    selectFiles(event.dataTransfer.files),
  );
}

async function login(event) {
  event.preventDefault();
  elements.loginError.textContent = "";
  const button = elements.loginForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ password: elements.password.value }),
    });
    elements.password.value = "";
    await showApp();
  } catch (error) {
    elements.loginError.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function logout() {
  await fetch("/api/logout", { method: "POST" });
  elements.appView.classList.add("hidden");
  elements.loginView.classList.remove("hidden");
}

async function showApp() {
  elements.loginView.classList.add("hidden");
  elements.appView.classList.remove("hidden");
  await loadFiles();
}

async function loadFiles() {
  const data = await api("/api/files");
  state.files = data.files;
  state.uploadConfig = data.upload || state.uploadConfig;
  renderFiles();
  elements.fileCount.textContent = state.files.length;
  elements.spaceUsed.textContent = formatBytes(
    state.files.reduce((total, file) => total + file.size, 0),
  );
}

function renderFiles() {
  const query = elements.searchInput.value.trim().toLocaleLowerCase("pt-BR");
  const files = state.files.filter((file) =>
    file.name.toLocaleLowerCase("pt-BR").includes(query),
  );
  elements.fileList.innerHTML = "";
  elements.emptyState.classList.toggle(
    "hidden",
    files.length > 0 || Boolean(query),
  );
  if (!files.length && query) {
    elements.fileList.innerHTML =
      '<div class="empty-state"><h4>Nenhum resultado</h4><p>Tente buscar por outro nome.</p></div>';
    return;
  }
  for (const file of files) {
    const row = document.createElement("article");
    row.className = "file-row";
    row.innerHTML = `
      <div class="file-info"><span class="file-type">${escapeHtml(extensionOf(file.name))}</span><div><b title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</b><small>${formatBytes(file.size)}</small></div></div>
      <div class="file-meta file-date"><b>${formatDate(file.createdAt)}</b><small>Enviado</small></div>
      <div class="file-actions"><button class="download-button">Baixar</button><button class="delete-button" aria-label="Excluir arquivo">×</button></div>`;
    row
      .querySelector(".download-button")
      .addEventListener("click", () => downloadFile(file));
    row
      .querySelector(".delete-button")
      .addEventListener("click", () => deleteFile(file));
    elements.fileList.appendChild(row);
  }
}

function openUpload() {
  elements.uploadModal.classList.remove("hidden");
}

function closeUpload() {
  if (
    state.uploading &&
    !window.confirm(
      "Pausar este upload? Os blocos enviados ficarão salvos para você retomar depois.",
    )
  )
    return;
  if (state.uploading) {
    state.uploadController?.abort();
    showToast("Upload pausado. Selecione o mesmo arquivo para retomar.");
  }
  state.uploading = false;
  elements.uploadModal.classList.add("hidden");
  resetUploadForm();
}

function resetUploadForm() {
  elements.uploadForm.reset();
  state.selectedFiles = [];
  elements.selectedFiles.innerHTML = "";
  elements.submitUpload.disabled = true;
  elements.uploadError.textContent = "";
  setOverallProgress(0, true);
}

function selectFiles(fileList) {
  if (state.uploading) return;
  state.selectedFiles = [...fileList].slice(0, 10).map((file) => ({
    file,
    progress: 0,
    status: "Aguardando",
    completed: false,
  }));
  renderSelectedFiles();
}

function renderSelectedFiles() {
  elements.selectedFiles.innerHTML = state.selectedFiles
    .map(
      (item) => `
    <div class="selected-file">
      <div class="selected-file-copy"><span title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</span><small>${formatBytes(item.file.size)} · ${escapeHtml(item.status)}</small><i><span style="width:${item.progress}%"></span></i></div>
      <strong>${Math.round(item.progress)}%</strong>
    </div>`,
    )
    .join("");
  elements.submitUpload.disabled =
    state.uploading || !state.selectedFiles.length;
  updateOverallProgress();
}

async function uploadFiles(event) {
  event.preventDefault();
  if (!state.selectedFiles.length || state.uploading) return;

  state.uploading = true;
  state.uploadController = new AbortController();
  elements.submitUpload.disabled = true;
  elements.uploadError.textContent = "";
  setOverallProgress(0, false);

  try {
    for (const item of state.selectedFiles) {
      await uploadFileInChunks(item, state.uploadController.signal);
    }
    const count = state.selectedFiles.length;
    state.uploading = false;
    state.uploadController = null;
    elements.uploadModal.classList.add("hidden");
    resetUploadForm();
    await loadFiles();
    showToast(
      `${count} arquivo${count > 1 ? "s enviados" : " enviado"} com integridade verificada.`,
    );
  } catch (error) {
    if (error.name !== "AbortError") {
      elements.uploadError.textContent = error.message;
      const active = state.selectedFiles.find((item) => !item.completed);
      if (active) active.status = "Falhou — tente novamente";
    }
  } finally {
    state.uploading = false;
    state.uploadController = null;
    renderSelectedFiles();
  }
}

async function uploadFileInChunks(item, signal) {
  item.status = "Preparando upload";
  renderSelectedFiles();
  const fingerprint = await fingerprintFile(item.file);

  const session = await api("/api/uploads", {
    method: "POST",
    signal,
    body: JSON.stringify({
      name: item.file.name,
      size: item.file.size,
      mimeType: item.file.type,
      lastModified: item.file.lastModified,
      fingerprint,
    }),
  });

  item.status = session.resumed ? "Retomando envio" : "Enviando blocos";
  const uploaded = new Set(session.uploadedChunks);
  let uploadedBytes = [...uploaded].reduce(
    (total, index) => total + chunkSizeAt(session, index),
    0,
  );
  let completedChunks = uploaded.size;
  item.progress = Math.min(99, (uploadedBytes / item.file.size) * 100);
  renderSelectedFiles();

  const missing = Array.from(
    { length: session.totalChunks },
    (_, index) => index,
  ).filter((index) => !uploaded.has(index));
  let cursor = 0;
  const workerCount = Math.min(
    session.concurrency || state.uploadConfig.concurrency || 3,
    missing.length,
  );

  async function worker() {
    while (cursor < missing.length) {
      const index = missing[cursor];
      cursor += 1;
      await uploadChunkWithRetry(session, item.file, index, signal);
      uploadedBytes += chunkSizeAt(session, index);
      completedChunks += 1;
      item.progress = Math.min(99, (uploadedBytes / item.file.size) * 100);
      item.status = `Enviando ${completedChunks} de ${session.totalChunks} blocos`;
      renderSelectedFiles();
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  item.status = "Montando arquivo no servidor";
  renderSelectedFiles();
  await api(`/api/uploads/${encodeURIComponent(session.id)}/complete`, {
    method: "POST",
    signal,
    body: "{}",
  });
  item.progress = 100;
  item.status = "Concluído";
  item.completed = true;
  renderSelectedFiles();
}

async function uploadChunkWithRetry(session, file, index, signal) {
  const start = index * session.chunkSize;
  const blob = file.slice(
    start,
    Math.min(start + session.chunkSize, file.size),
  );
  const hash = await sha256(blob);
  let lastError;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(
        `/api/uploads/${encodeURIComponent(session.id)}/chunks/${index}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Chunk-SHA256": hash,
          },
          body: blob,
          signal,
        },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || `Falha no bloco ${index + 1}.`);
      return result;
    } catch (error) {
      if (error.name === "AbortError") throw error;
      lastError = error;
      if (attempt < 4) await delay(400 * 2 ** (attempt - 1), signal);
    }
  }
  throw lastError;
}

function updateOverallProgress() {
  if (!state.selectedFiles.length) return setOverallProgress(0, true);
  const totalBytes = state.selectedFiles.reduce(
    (total, item) => total + item.file.size,
    0,
  );
  const uploadedBytes = state.selectedFiles.reduce(
    (total, item) => total + (item.file.size * item.progress) / 100,
    0,
  );
  setOverallProgress((uploadedBytes / totalBytes) * 100, false);
}

function setOverallProgress(progress, hidden) {
  elements.uploadProgress.classList.toggle("hidden", hidden);
  elements.uploadProgress.querySelector("span").style.width = `${progress}%`;
}

function downloadFile(file) {
  window.location.assign(`/api/files/${encodeURIComponent(file.id)}/download`);
  setTimeout(loadFiles, 1200);
}

async function deleteFile(file) {
  if (!window.confirm(`Excluir “${file.name}” permanentemente?`)) return;
  try {
    await api(`/api/files/${encodeURIComponent(file.id)}`, {
      method: "DELETE",
    });
    await loadFiles();
    showToast("Arquivo excluído.");
  } catch (error) {
    showToast(error.message, true);
  }
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });
  if (response.status === 204) return null;
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Algo deu errado.");
  return result;
}

async function sha256(blob) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await blob.arrayBuffer(),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function fingerprintFile(file) {
  const sampleSize = 64 * 1024;
  const metadata = new TextEncoder().encode(
    `${file.name}\0${file.size}\0${file.lastModified}\0`,
  );
  const beginning = new Uint8Array(
    await file.slice(0, Math.min(sampleSize, file.size)).arrayBuffer(),
  );
  const endingStart = Math.max(0, file.size - sampleSize);
  const ending = new Uint8Array(await file.slice(endingStart).arrayBuffer());
  const combined = new Uint8Array(
    metadata.length + beginning.length + ending.length,
  );
  combined.set(metadata, 0);
  combined.set(beginning, metadata.length);
  combined.set(ending, metadata.length + beginning.length);
  const digest = await crypto.subtle.digest("SHA-256", combined);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted)
      return reject(new DOMException("Cancelado", "AbortError"));
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Cancelado", "AbortError"));
      },
      { once: true },
    );
  });
}

function chunkSizeAt(session, index) {
  return Math.min(session.chunkSize, session.size - index * session.chunkSize);
}

function showToast(message, error = false) {
  elements.toast.querySelector("span").textContent = error ? "!" : "✓";
  elements.toast.querySelector("p").textContent = message;
  elements.toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(
    () => elements.toast.classList.add("hidden"),
    3500,
  );
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / 1024 ** exponent).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} ${units[exponent]}`;
}
function formatDate(date) {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(date));
}
function extensionOf(name) {
  return (name.split(".").pop() || "FILE").toUpperCase().slice(0, 4);
}
function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = String(value);
  return div.innerHTML;
}
