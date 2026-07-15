const state = {
  sessionUser: null,
  publicFiles: [],
  publicFolders: [],
  publicBreadcrumbs: [],
  publicFolderId: null,
  files: [],
  folders: [],
  folderTree: [],
  breadcrumbs: [],
  currentFolderId: null,
  currentFolder: null,
  selectedFiles: [],
  uploading: false,
  uploadController: null,
  uploadConfig: { concurrency: 3 },
  moveFile: null,
  shareFile: null,
  publicPreviewTrigger: null,
  publicPreviewController: null,
};

const elements = Object.fromEntries(
  [
    "loginView",
    "guestHome",
    "publicView",
    "appView",
    "loginForm",
    "loginError",
    "username",
    "password",
    "togglePassword",
    "logoutButton",
    "fileList",
    "emptyState",
    "fileCount",
    "spaceUsed",
    "searchInput",
    "breadcrumbs",
    "currentFolderName",
    "uploadModal",
    "uploadForm",
    "fileInput",
    "dropZone",
    "selectedFiles",
    "submitUpload",
    "uploadError",
    "uploadProgress",
    "toast",
    "folderModal",
    "folderForm",
    "folderName",
    "folderError",
    "moveModal",
    "moveFileName",
    "moveDestination",
    "moveError",
    "confirmMoveButton",
    "shareModal",
    "shareUrl",
    "shareError",
    "copyShareButton",
    "revokeShareButton",
    "createShareButton",
    "publicFileName",
    "publicFileMeta",
    "publicError",
    "publicDownload",
    "homeLoginButton",
    "homeAdminButton",
    "guestUser",
    "publicSearchInput",
    "publicBreadcrumbs",
    "publicLibraryList",
    "publicLibraryEmpty",
    "publicLibraryError",
    "publicPreviewModal",
    "publicPreviewTitle",
    "publicPreviewMeta",
    "publicPreviewStatus",
    "publicPreviewCode",
    "publicPreviewContent",
    "publicPreviewDownload",
    "publicPreviewClose",
    "operatorName",
    "publicContextNotice",
    "uploadPublic",
    "folderPublic",
  ].map((id) => [id, document.querySelector(`#${id}`)]),
);

boot();

async function boot() {
  if (window.location.pathname.startsWith("/s/")) {
    await showPublicFile();
    return;
  }
  bindEvents();
  await routePage();
}

async function routePage() {
  try {
    const session = await api("/api/session");
    state.sessionUser = session.user || null;
    if (window.location.pathname === "/admin") {
      if (session.authenticated) await showApp(session.user);
      else showLogin();
    } else if (window.location.pathname === "/login") {
      showLogin();
    } else {
      await showHome(session);
    }
  } catch {
    await showHome({ authenticated: false, user: null });
  }
}

function bindEvents() {
  elements.loginForm.addEventListener("submit", login);
  elements.homeLoginButton.addEventListener("click", () => {
    navigateTo("/login");
    showLogin();
  });
  elements.homeAdminButton.addEventListener("click", async () => {
    navigateTo("/admin");
    await showApp(state.sessionUser);
  });
  elements.publicSearchInput.addEventListener("input", renderPublicLibrary);
  elements.togglePassword.addEventListener("click", togglePassword);
  elements.logoutButton.addEventListener("click", logout);
  document.querySelector("#uploadButton").addEventListener("click", openUpload);
  document
    .querySelector("#newFolderButton")
    .addEventListener("click", openFolderModal);
  document
    .querySelector("#newTextButton")
    .addEventListener("click", openNewTextEditor);
  document.querySelector("#emptyUpload").addEventListener("click", openUpload);
  document
    .querySelector("#navFiles")
    .addEventListener("click", () => openFolder(null));
  document
    .querySelector("#mobileMenu")
    .addEventListener("click", () =>
      document.querySelector(".sidebar").classList.toggle("open"),
    );
  document
    .querySelector("#viewPublicSite")
    .addEventListener("click", async () => {
      navigateTo("/");
      await showHome({ authenticated: true, user: state.sessionUser });
    });
  document
    .querySelectorAll("[data-close]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        closeNamedModal(button.dataset.close),
      ),
    );
  elements.fileInput.addEventListener("change", () =>
    selectFiles(elements.fileInput.files),
  );
  elements.uploadForm.addEventListener("submit", uploadFiles);
  elements.searchInput.addEventListener("input", renderBrowser);
  elements.folderForm.addEventListener("submit", createFolder);
  elements.confirmMoveButton.addEventListener("click", confirmMove);
  elements.createShareButton.addEventListener("click", createShare);
  elements.revokeShareButton.addEventListener("click", revokeShare);
  elements.copyShareButton.addEventListener("click", copyShareUrl);
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
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "Tab" &&
      !elements.publicPreviewModal.classList.contains("hidden")
    ) {
      trapPublicPreviewFocus(event);
      return;
    }
    if (event.key !== "Escape") return;
    if (!elements.publicPreviewModal.classList.contains("hidden")) {
      closePublicTextPreview();
      return;
    }
    document
      .querySelectorAll(".modal:not(.hidden)")
      .forEach((modal) => modal.classList.add("hidden"));
  });
  window.addEventListener("popstate", routePage);
}

async function showHome(session) {
  elements.loginView.classList.add("hidden");
  elements.publicView.classList.add("hidden");
  elements.appView.classList.add("hidden");
  elements.guestHome.classList.remove("hidden");
  state.sessionUser = session.user || state.sessionUser;
  const authenticated = Boolean(session.authenticated && state.sessionUser);
  elements.homeLoginButton.classList.toggle("hidden", authenticated);
  elements.homeAdminButton.classList.toggle("hidden", !authenticated);
  elements.guestUser.classList.toggle("hidden", !authenticated);
  elements.guestUser.textContent = authenticated
    ? `Operador: ${state.sessionUser.username}`
    : "";
  await loadPublicLibrary(null);
}

function showLogin() {
  elements.guestHome.classList.add("hidden");
  elements.publicView.classList.add("hidden");
  elements.appView.classList.add("hidden");
  elements.loginView.classList.remove("hidden");
  elements.loginError.textContent = "";
  setTimeout(() => elements.username.focus(), 50);
}

async function loadPublicLibrary(folderId = state.publicFolderId) {
  elements.publicLibraryError.textContent = "";
  const value = folderId || "root";
  try {
    const data = await api(
      `/api/public-library?folderId=${encodeURIComponent(value)}`,
    );
    state.publicFiles = data.files;
    state.publicFolders = data.folders;
    state.publicBreadcrumbs = data.breadcrumbs;
    state.publicFolderId = data.currentFolderId;
    renderPublicBreadcrumbs();
    renderPublicLibrary();
  } catch (error) {
    elements.publicLibraryError.textContent = error.message;
    state.publicFiles = [];
    state.publicFolders = [];
    renderPublicLibrary();
  }
}

function renderPublicBreadcrumbs() {
  elements.publicBreadcrumbs.innerHTML = "";
  state.publicBreadcrumbs.forEach((crumb, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = crumb.name === "Bunker" ? "Arquivos" : crumb.name;
    button.className =
      index === state.publicBreadcrumbs.length - 1 ? "active" : "";
    button.addEventListener("click", () => loadPublicLibrary(crumb.id));
    elements.publicBreadcrumbs.appendChild(button);
    if (index < state.publicBreadcrumbs.length - 1)
      elements.publicBreadcrumbs.append("›");
  });
}

function renderPublicLibrary() {
  const query = elements.publicSearchInput.value
    .trim()
    .toLocaleLowerCase("pt-BR");
  const folders = state.publicFolders.filter((folder) =>
    folder.name.toLocaleLowerCase("pt-BR").includes(query),
  );
  const files = state.publicFiles.filter((file) =>
    file.name.toLocaleLowerCase("pt-BR").includes(query),
  );
  elements.publicLibraryList.innerHTML = "";
  elements.publicLibraryEmpty.classList.toggle(
    "hidden",
    folders.length > 0 || files.length > 0 || Boolean(query),
  );
  if (!folders.length && !files.length && query) {
    elements.publicLibraryList.innerHTML =
      '<div class="public-no-result"><b>Nenhum resultado nesta pasta.</b><span>Tente buscar por outro nome.</span></div>';
    return;
  }
  folders.forEach((folder) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "public-item public-folder-card";
    card.innerHTML = `<span class="public-item-icon">DIR</span><span class="public-item-copy"><b>${escapeHtml(folder.name)}</b><small>Pasta pública</small></span><span class="public-item-action">→</span>`;
    card.addEventListener("click", () => loadPublicLibrary(folder.id));
    elements.publicLibraryList.appendChild(card);
  });
  files.forEach((file) => {
    const card = document.createElement("article");
    card.className = "public-item public-file-card";
    card.innerHTML = `<span class="public-item-icon">${escapeHtml(extensionOf(file.name))}</span><span class="public-item-copy"><b title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</b><small>${formatBytes(file.size)} · ${formatDate(file.updatedAt || file.createdAt)}</small></span><span class="public-item-actions">${file.previewable ? `<button class="public-item-action public-preview-button" type="button" title="Visualizar em modo somente leitura" aria-label="Visualizar ${escapeHtml(file.name)}">◉</button>` : ""}<a class="public-item-action" href="/api/public-library/files/${encodeURIComponent(file.id)}/download" title="Baixar arquivo" aria-label="Baixar ${escapeHtml(file.name)}">↓</a></span>`;
    card
      .querySelector(".public-preview-button")
      ?.addEventListener("click", (event) =>
        openPublicTextPreview(file, event.currentTarget),
      );
    elements.publicLibraryList.appendChild(card);
  });
}

async function openPublicTextPreview(file, trigger) {
  state.publicPreviewController?.abort();
  state.publicPreviewTrigger = trigger;
  const controller = new AbortController();
  state.publicPreviewController = controller;

  elements.publicPreviewTitle.textContent = file.name;
  elements.publicPreviewMeta.textContent = `${formatBytes(file.size)} · validando conteúdo`;
  elements.publicPreviewStatus.textContent = "Carregando visualização...";
  elements.publicPreviewContent.textContent = "";
  elements.publicPreviewDownload.href = `/api/public-library/files/${encodeURIComponent(file.id)}/download`;
  elements.publicPreviewModal.classList.remove("hidden");
  setTimeout(() => elements.publicPreviewClose.focus(), 0);

  try {
    const data = await api(
      `/api/public-library/files/${encodeURIComponent(file.id)}/content`,
      { signal: controller.signal },
    );
    if (state.publicPreviewController !== controller) return;
    elements.publicPreviewTitle.textContent = data.file.name;
    elements.publicPreviewMeta.textContent = `${publicLanguageLabel(data.language)} · ${formatBytes(data.file.size)} · ${String(data.encoding || "utf8").toUpperCase()}`;
    elements.publicPreviewContent.textContent = data.content;
    elements.publicPreviewStatus.textContent =
      "Conteúdo carregado em modo somente leitura.";
  } catch (error) {
    if (error.name === "AbortError") return;
    elements.publicPreviewStatus.textContent = error.message;
    elements.publicPreviewContent.textContent =
      "Não foi possível exibir este arquivo. O download continua disponível.";
  }
}

function closePublicTextPreview() {
  state.publicPreviewController?.abort();
  state.publicPreviewController = null;
  elements.publicPreviewModal.classList.add("hidden");
  elements.publicPreviewContent.textContent = "";
  const trigger = state.publicPreviewTrigger;
  state.publicPreviewTrigger = null;
  if (trigger?.isConnected) setTimeout(() => trigger.focus(), 0);
}

function trapPublicPreviewFocus(event) {
  const focusable = [
    ...elements.publicPreviewModal.querySelectorAll(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((element) => !element.hidden);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function publicLanguageLabel(language) {
  const value = String(language || "plaintext");
  return value === "plaintext"
    ? "Texto simples"
    : value.charAt(0).toUpperCase() + value.slice(1);
}

async function showPublicFile() {
  elements.guestHome.classList.add("hidden");
  elements.loginView.classList.add("hidden");
  elements.appView.classList.add("hidden");
  elements.publicView.classList.remove("hidden");
  const token = window.location.pathname.split("/").filter(Boolean).pop();
  try {
    const data = await api(`/api/public/${encodeURIComponent(token)}`);
    elements.publicFileName.textContent = data.file.name;
    elements.publicFileMeta.textContent = `${formatBytes(data.file.size)} · publicado em ${formatDate(data.file.createdAt)}`;
    elements.publicDownload.href = `/api/public/${encodeURIComponent(token)}/download`;
    elements.publicDownload.classList.remove("hidden");
    document.title = `${data.file.name} — VaultKeep`;
  } catch (error) {
    elements.publicFileName.textContent = "Arquivo indisponível";
    elements.publicFileMeta.textContent =
      "Este link pode ter expirado ou sido desativado.";
    elements.publicError.textContent = error.message;
  }
}

async function login(event) {
  event.preventDefault();
  elements.loginError.textContent = "";
  const button = elements.loginForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        username: elements.username.value,
        password: elements.password.value,
      }),
    });
    elements.password.value = "";
    const session = await api("/api/session");
    state.sessionUser = session.user;
    navigateTo("/admin");
    await showApp(session.user);
  } catch (error) {
    elements.loginError.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function togglePassword() {
  const hidden = elements.password.type === "password";
  elements.password.type = hidden ? "text" : "password";
  elements.togglePassword.setAttribute(
    "aria-label",
    hidden ? "Ocultar senha" : "Mostrar senha",
  );
}

async function logout() {
  await fetch("/api/logout", { method: "POST" });
  state.sessionUser = null;
  navigateTo("/");
  await showHome({ authenticated: false, user: null });
}

async function showApp(user = state.sessionUser) {
  elements.guestHome.classList.add("hidden");
  elements.loginView.classList.add("hidden");
  elements.publicView.classList.add("hidden");
  elements.appView.classList.remove("hidden");
  state.sessionUser = user || state.sessionUser;
  elements.operatorName.textContent = state.sessionUser
    ? `Operador: ${state.sessionUser.username}`
    : "Operador autenticado";
  await Promise.all([loadFiles(adminFolderFromLocation()), loadFolderTree()]);
}

function adminFolderFromLocation() {
  const folderId = new URLSearchParams(window.location.search).get("folderId");
  if (!folderId || folderId === "root") return null;
  return /^[0-9a-f-]{36}$/i.test(folderId) ? folderId : null;
}

async function loadFiles(folderId = state.currentFolderId) {
  const value = folderId || "root";
  const data = await api(`/api/files?folderId=${encodeURIComponent(value)}`);
  state.files = data.files;
  state.folders = data.folders;
  state.breadcrumbs = data.breadcrumbs;
  state.currentFolderId = data.currentFolderId;
  state.currentFolder = data.currentFolder;
  state.uploadConfig = data.upload || state.uploadConfig;
  elements.fileCount.textContent = data.summary.fileCount;
  elements.spaceUsed.textContent = formatBytes(data.summary.totalBytes);
  elements.currentFolderName.textContent =
    state.breadcrumbs.at(-1)?.name || "Bunker";
  elements.publicContextNotice.classList.toggle(
    "hidden",
    !state.currentFolder?.publiclyAccessible,
  );
  renderBreadcrumbs();
  renderBrowser();
}

async function loadFolderTree() {
  const data = await api("/api/folders");
  state.folderTree = data.tree;
}

function renderBreadcrumbs() {
  elements.breadcrumbs.innerHTML = "";
  state.breadcrumbs.forEach((crumb, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = crumb.name;
    button.className = index === state.breadcrumbs.length - 1 ? "active" : "";
    button.addEventListener("click", () => openFolder(crumb.id));
    elements.breadcrumbs.appendChild(button);
    if (index < state.breadcrumbs.length - 1) elements.breadcrumbs.append("›");
  });
}

function renderBrowser() {
  const query = elements.searchInput.value.trim().toLocaleLowerCase("pt-BR");
  const folders = state.folders.filter((folder) =>
    folder.name.toLocaleLowerCase("pt-BR").includes(query),
  );
  const files = state.files.filter((file) =>
    file.name.toLocaleLowerCase("pt-BR").includes(query),
  );
  elements.fileList.innerHTML = "";
  elements.emptyState.classList.toggle(
    "hidden",
    folders.length > 0 || files.length > 0 || Boolean(query),
  );
  if (!folders.length && !files.length && query) {
    elements.fileList.innerHTML =
      '<div class="empty-state"><h4>Nenhum resultado</h4><p>Tente buscar por outro nome nesta pasta.</p></div>';
    return;
  }
  folders.forEach(renderFolderRow);
  files.forEach(renderFileRow);
}

function renderFolderRow(folder) {
  const row = document.createElement("article");
  row.className = "file-row folder-entry";
  const publicBadge =
    folder.visibility === "public"
      ? `<span class="file-badge public">${folder.publiclyAccessible ? "PÚBLICA" : "PUBLICAÇÃO BLOQUEADA"}</span>`
      : "";
  row.innerHTML = `
    <button class="file-info folder-open" type="button"><span class="file-type folder-type">DIR</span><div><b>${escapeHtml(folder.name)}</b><small>${folder.itemCount} ${folder.itemCount === 1 ? "item" : "itens"} ${publicBadge}</small></div></button>
    <div class="file-meta file-date"><b>${formatDate(folder.createdAt)}</b><small>Criada</small></div>
    <div class="file-actions"><label class="row-visibility" title="Exibir esta pasta no site público"><input type="checkbox" ${folder.visibility === "public" ? "checked" : ""}><span></span><small>Site</small></label><button class="row-icon-button open-folder" title="Abrir pasta">→</button><button class="row-icon-button rename-folder" title="Renomear pasta">✎</button><button class="delete-button delete-folder" title="Excluir pasta">×</button></div>`;
  row
    .querySelector(".folder-open")
    .addEventListener("click", () => openFolder(folder.id));
  row
    .querySelector(".open-folder")
    .addEventListener("click", () => openFolder(folder.id));
  row
    .querySelector(".rename-folder")
    .addEventListener("click", () => renameFolder(folder));
  row
    .querySelector(".delete-folder")
    .addEventListener("click", () => deleteFolder(folder));
  row
    .querySelector(".row-visibility input")
    .addEventListener("change", (event) =>
      updateFolderVisibility(folder, event.target.checked),
    );
  elements.fileList.appendChild(row);
}

function renderFileRow(file) {
  const row = document.createElement("article");
  row.className = "file-row";
  const badges = `${file.editable ? '<span class="file-badge code">EDITÁVEL</span>' : ""}${file.visibility === "public" ? '<span class="file-badge public">NO SITE</span>' : ""}${file.isShared ? '<span class="file-badge shared">LINK ATIVO</span>' : ""}`;
  row.innerHTML = `
    <div class="file-info"><span class="file-type">${escapeHtml(extensionOf(file.name))}</span><div><b title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</b><small>${formatBytes(file.size)} ${badges}</small></div></div>
    <div class="file-meta file-date"><b>${formatDate(file.updatedAt || file.createdAt)}</b><small>${file.updatedAt ? "Alterado" : "Enviado"}</small></div>
    <div class="file-actions">
      <label class="row-visibility" title="Exibir este arquivo no site público"><input type="checkbox" ${file.visibility === "public" ? "checked" : ""}><span></span><small>Site</small></label>
      ${file.editable ? '<button class="row-icon-button edit-file" title="Editar conteúdo">{ }</button>' : ""}
      <button class="row-icon-button move-file" title="Mover para outra pasta">↪</button>
      <button class="row-icon-button share-file" title="Compartilhar para download">↗</button>
      <button class="download-button" title="Baixar">↓</button>
      <button class="delete-button" title="Excluir arquivo">×</button>
    </div>`;
  row
    .querySelector(".edit-file")
    ?.addEventListener("click", () => openTextEditor(file));
  row
    .querySelector(".move-file")
    .addEventListener("click", () => openMoveModal(file));
  row
    .querySelector(".share-file")
    .addEventListener("click", () => openShareModal(file));
  row
    .querySelector(".download-button")
    .addEventListener("click", () => downloadFile(file));
  row
    .querySelector(".delete-button")
    .addEventListener("click", () => deleteFile(file));
  row
    .querySelector(".row-visibility input")
    .addEventListener("change", (event) =>
      updateFileVisibility(file, event.target.checked),
    );
  elements.fileList.appendChild(row);
}

async function openFolder(folderId) {
  document.querySelector(".sidebar").classList.remove("open");
  elements.searchInput.value = "";
  try {
    await loadFiles(folderId);
  } catch (error) {
    showToast(error.message, true);
  }
}

function openFolderModal() {
  elements.folderForm.reset();
  elements.folderPublic.checked = false;
  elements.folderError.textContent = "";
  elements.folderModal.classList.remove("hidden");
  setTimeout(() => elements.folderName.focus(), 50);
}

async function createFolder(event) {
  event.preventDefault();
  elements.folderError.textContent = "";
  try {
    await api("/api/folders", {
      method: "POST",
      body: JSON.stringify({
        name: elements.folderName.value,
        parentId: state.currentFolderId,
        visibility: elements.folderPublic.checked ? "public" : "private",
      }),
    });
    elements.folderModal.classList.add("hidden");
    await Promise.all([loadFiles(), loadFolderTree()]);
    showToast("Pasta criada no bunker.");
  } catch (error) {
    elements.folderError.textContent = error.message;
  }
}

async function renameFolder(folder) {
  const name = window.prompt("Novo nome da pasta:", folder.name);
  if (!name || name === folder.name) return;
  try {
    await api(`/api/folders/${encodeURIComponent(folder.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
    await Promise.all([loadFiles(), loadFolderTree()]);
    showToast("Pasta renomeada.");
  } catch (error) {
    showToast(error.message, true);
  }
}

async function updateFolderVisibility(folder, makePublic) {
  if (
    makePublic &&
    !window.confirm(
      "Tornar esta pasta visível no site público? Os arquivos continuam privados até serem publicados individualmente.",
    )
  ) {
    renderBrowser();
    return;
  }
  try {
    await api(`/api/folders/${encodeURIComponent(folder.id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        visibility: makePublic ? "public" : "private",
      }),
    });
    await Promise.all([loadFiles(), loadFolderTree()]);
    showToast(
      makePublic
        ? "Pasta publicada. Libere os arquivos que devem aparecer nela."
        : "Pasta removida do site público.",
    );
  } catch (error) {
    renderBrowser();
    showToast(error.message, true);
  }
}

async function deleteFolder(folder) {
  if (!window.confirm(`Excluir a pasta vazia “${folder.name}”?`)) return;
  try {
    await api(`/api/folders/${encodeURIComponent(folder.id)}`, {
      method: "DELETE",
    });
    await Promise.all([loadFiles(), loadFolderTree()]);
    showToast("Pasta excluída.");
  } catch (error) {
    showToast(error.message, true);
  }
}

function openUpload() {
  elements.uploadModal.classList.remove("hidden");
}

function closeUpload() {
  if (
    state.uploading &&
    !window.confirm(
      "Pausar este upload? Os blocos enviados ficarão salvos para retomada.",
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
  elements.uploadPublic.checked = false;
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
    <div class="selected-file"><div class="selected-file-copy"><span title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</span><small>${formatBytes(item.file.size)} · ${escapeHtml(item.status)}</small><i><span style="width:${item.progress}%"></span></i></div><strong>${Math.round(item.progress)}%</strong></div>`,
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
    for (const item of state.selectedFiles)
      await uploadFileInChunks(item, state.uploadController.signal);
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
  item.status = "Identificando arquivo";
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
      folderId: state.currentFolderId,
      visibility: elements.uploadPublic.checked ? "public" : "private",
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
      const index = missing[cursor++];
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

function openNewTextEditor() {
  const folderId = state.currentFolderId || "root";
  openEditorPage(`/editor?folderId=${encodeURIComponent(folderId)}`);
}

function openTextEditor(file) {
  const returnFolderId = state.currentFolderId || "root";
  openEditorPage(
    `/editor?fileId=${encodeURIComponent(file.id)}&returnFolderId=${encodeURIComponent(returnFolderId)}`,
  );
}

function openEditorPage(relativeUrl) {
  window.location.assign(relativeUrl);
}

async function openMoveModal(file) {
  state.moveFile = file;
  elements.moveFileName.textContent = file.name;
  elements.moveError.textContent = "";
  await loadFolderTree();
  elements.moveDestination.innerHTML =
    '<option value="root">Bunker (raiz)</option>' +
    state.folderTree
      .map(
        (folder) =>
          `<option value="${folder.id}">${"— ".repeat(folder.depth + 1)}${escapeHtml(folder.name)}</option>`,
      )
      .join("");
  elements.moveDestination.value = file.folderId || "root";
  elements.moveModal.classList.remove("hidden");
}

async function confirmMove() {
  if (!state.moveFile) return;
  elements.moveError.textContent = "";
  const folderId =
    elements.moveDestination.value === "root"
      ? null
      : elements.moveDestination.value;
  try {
    await api(`/api/files/${encodeURIComponent(state.moveFile.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ folderId }),
    });
    elements.moveModal.classList.add("hidden");
    await loadFiles();
    showToast("Arquivo movido.");
  } catch (error) {
    elements.moveError.textContent = error.message;
  }
}

async function openShareModal(file) {
  state.shareFile = file;
  elements.shareModal.classList.remove("hidden");
  elements.shareError.textContent = "";
  elements.shareUrl.value = "";
  try {
    const data = await api(`/api/files/${encodeURIComponent(file.id)}/share`);
    updateShareModal(data);
  } catch (error) {
    elements.shareError.textContent = error.message;
  }
}

function updateShareModal(data) {
  elements.shareUrl.value = data.url || "";
  elements.copyShareButton.disabled = !data.url;
  elements.revokeShareButton.classList.toggle("hidden", !data.isPublic);
  elements.createShareButton.classList.toggle("hidden", data.isPublic);
}

async function createShare() {
  if (!state.shareFile) return;
  try {
    const data = await api(
      `/api/files/${encodeURIComponent(state.shareFile.id)}/share`,
      { method: "POST", body: "{}" },
    );
    updateShareModal(data);
    await copyShareUrl();
    await loadFiles();
    showToast("Link público criado e copiado.");
  } catch (error) {
    elements.shareError.textContent = error.message;
  }
}

async function revokeShare() {
  if (!state.shareFile || !window.confirm("Desativar este link público?"))
    return;
  try {
    await api(`/api/files/${encodeURIComponent(state.shareFile.id)}/share`, {
      method: "DELETE",
    });
    updateShareModal({ isPublic: false, url: null });
    await loadFiles();
    showToast("Link público desativado.");
  } catch (error) {
    elements.shareError.textContent = error.message;
  }
}

async function copyShareUrl() {
  if (!elements.shareUrl.value) return;
  try {
    await navigator.clipboard.writeText(elements.shareUrl.value);
  } catch {
    elements.shareUrl.select();
    document.execCommand("copy");
  }
}

function closeNamedModal(name) {
  if (name === "upload") return closeUpload();
  if (name === "publicPreview") return closePublicTextPreview();
  const modal = document.querySelector(`#${name}Modal`);
  modal?.classList.add("hidden");
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

async function updateFileVisibility(file, makePublic) {
  if (
    makePublic &&
    !window.confirm(
      "Publicar este arquivo? Qualquer visitante poderá encontrá-lo e baixá-lo sem login.",
    )
  ) {
    renderBrowser();
    return;
  }
  try {
    await api(`/api/files/${encodeURIComponent(file.id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        visibility: makePublic ? "public" : "private",
      }),
    });
    await loadFiles();
    const parentAllowsPublication =
      !state.currentFolderId || state.currentFolder?.publiclyAccessible;
    showToast(
      makePublic && !parentAllowsPublication
        ? "Arquivo marcado como público, mas as pastas acima também precisam ser publicadas."
        : makePublic
          ? "Arquivo publicado no site."
          : "Arquivo voltou a ser privado.",
      makePublic && !parentAllowsPublication,
    );
  } catch (error) {
    renderBrowser();
    showToast(error.message, true);
  }
}

async function api(url, options = {}) {
  const { headers, ...rest } = options;
  const response = await fetch(url, {
    ...rest,
    headers: { "Content-Type": "application/json", ...headers },
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
  const ending = new Uint8Array(
    await file.slice(Math.max(0, file.size - sampleSize)).arrayBuffer(),
  );
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

function navigateTo(pathname) {
  if (window.location.pathname !== pathname)
    window.history.pushState({}, "", pathname);
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
  const part = name.includes(".") ? name.split(".").pop() : "TXT";
  return (part || "FILE").toUpperCase().slice(0, 4);
}
function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = String(value);
  return div.innerHTML;
}
