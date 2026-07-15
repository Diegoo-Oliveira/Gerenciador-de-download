const params = new URLSearchParams(window.location.search);
const requestedFolderId = params.get("folderId");
const requestedReturnFolderId = params.get("returnFolderId");
const state = {
  fileId: params.get("fileId"),
  folderId: requestedFolderId === "root" ? null : requestedFolderId,
  returnFolderId: validFolderId(requestedReturnFolderId)
    ? requestedReturnFolderId
    : validFolderId(requestedFolderId)
      ? requestedFolderId
      : "root",
  creating: !params.get("fileId"),
  originalName: "",
  originalContent: "",
  originalVisibility: "private",
  revision: null,
  encoding: "utf8",
  language: "plaintext",
  dirty: false,
  silent: true,
  detectionTimer: null,
  editor: null,
};

const elements = Object.fromEntries(
  [
    "editorTitle",
    "editorBackLink",
    "editorOperator",
    "editorFileName",
    "editorLanguage",
    "editorLanguageCode",
    "editorTextarea",
    "editorEncoding",
    "editorSize",
    "editorSaveState",
    "editorPublic",
    "editorError",
    "cancelEditorButton",
    "saveEditorButton",
    "editorLoading",
    "editorToast",
  ].map((id) => [id, document.querySelector(`#${id}`)]),
);

boot();

async function boot() {
  bindEvents();
  try {
    const session = await api("/api/session");
    if (!session.authenticated || session.user?.role !== "admin") {
      window.location.replace("/login");
      return;
    }
    elements.editorOperator.textContent = `Operador: ${session.user.username}`;
    elements.editorBackLink.href = adminReturnUrl();
    createCodeEditor();
    if (state.creating) prepareNewFile();
    else await loadExistingFile();
    elements.editorLoading.classList.add("hidden");
    state.editor.focus();
  } catch (error) {
    elements.editorLoading.classList.add("hidden");
    showError(error.message);
  }
}

function bindEvents() {
  elements.cancelEditorButton.addEventListener("click", cancelEditor);
  elements.saveEditorButton.addEventListener("click", saveEditor);
  elements.editorFileName.addEventListener("input", () => {
    markDirty();
    setLanguage(languageFromFilename(elements.editorFileName.value));
    scheduleLanguageDetection();
    updateDocumentTitle();
  });
  elements.editorPublic.addEventListener("change", markDirty);
  window.addEventListener("beforeunload", (event) => {
    if (!hasUnsavedChanges()) return;
    event.preventDefault();
    event.returnValue = "";
  });
  window.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveEditor();
    }
    if (event.key === "Escape") cancelEditor();
  });
}

function createCodeEditor() {
  state.editor = window.CodeMirror.fromTextArea(elements.editorTextarea, {
    lineNumbers: true,
    theme: "vaultkeep-page",
    mode: null,
    indentUnit: 2,
    tabSize: 2,
    lineWrapping: false,
    autofocus: true,
  });
  state.editor.on("change", () => {
    updateSize();
    if (!state.silent) {
      markDirty();
      scheduleLanguageDetection();
    }
  });
}

function prepareNewFile() {
  elements.editorTitle.textContent = "Criar arquivo de texto";
  elements.editorFileName.value = "notas.md";
  elements.editorPublic.checked = false;
  state.originalName = "notas.md";
  state.originalContent = "";
  state.originalVisibility = "private";
  state.silent = true;
  state.editor.setValue("");
  setLanguage("markdown");
  state.silent = false;
  state.dirty = false;
  updateSize();
  updateSaveState();
  updateDocumentTitle();
}

async function loadExistingFile() {
  if (!/^[0-9a-f-]{36}$/i.test(String(state.fileId || "")))
    throw new Error("Identificador de arquivo inválido.");
  elements.editorTitle.textContent = "Carregando arquivo...";
  const data = await api(
    `/api/files/${encodeURIComponent(state.fileId)}/content`,
  );
  state.revision = data.revision;
  state.encoding = data.encoding;
  state.originalName = data.file.name;
  state.originalContent = data.content;
  state.originalVisibility = data.file.visibility;
  elements.editorFileName.value = data.file.name;
  elements.editorPublic.checked = data.file.visibility === "public";
  elements.editorEncoding.textContent = data.encoding.toUpperCase();
  state.silent = true;
  state.editor.setValue(data.content);
  setLanguage(data.language);
  state.silent = false;
  state.dirty = false;
  elements.editorTitle.textContent = "Editar arquivo de texto";
  updateSize();
  updateSaveState();
  updateDocumentTitle();
}

async function saveEditor() {
  if (elements.saveEditorButton.disabled) return;
  const name = elements.editorFileName.value.trim();
  if (!name) return showError("Informe o nome do arquivo.");
  elements.editorError.textContent = "";
  elements.saveEditorButton.disabled = true;
  elements.saveEditorButton.querySelector("span:first-child").textContent =
    "Salvando...";
  try {
    const visibility = elements.editorPublic.checked ? "public" : "private";
    if (state.creating) {
      const created = await api("/api/text-files", {
        method: "POST",
        body: JSON.stringify({
          name,
          content: state.editor.getValue(),
          folderId: state.folderId,
          visibility,
        }),
      });
      state.fileId = created.file.id;
    } else {
      const saved = await api(
        `/api/files/${encodeURIComponent(state.fileId)}/content`,
        {
          method: "PUT",
          body: JSON.stringify({
            content: state.editor.getValue(),
            revision: state.revision,
          }),
        },
      );
      state.revision = saved.revision;
      if (
        name !== state.originalName ||
        visibility !== state.originalVisibility
      ) {
        await api(`/api/files/${encodeURIComponent(state.fileId)}`, {
          method: "PATCH",
          body: JSON.stringify({ name, visibility }),
        });
      }
    }
    const wasCreating = state.creating;
    state.creating = false;
    state.originalName = name;
    state.originalContent = state.editor.getValue();
    state.originalVisibility = visibility;
    state.dirty = false;
    updateSaveState("Salvo agora");
    showToast(
      wasCreating ? "Arquivo criado com sucesso." : "Alterações salvas.",
    );
    setTimeout(returnToAdmin, 550);
  } catch (error) {
    showError(error.message);
  } finally {
    elements.saveEditorButton.disabled = false;
    elements.saveEditorButton.querySelector("span:first-child").textContent =
      "Salvar arquivo";
  }
}

function cancelEditor() {
  if (
    hasUnsavedChanges() &&
    !window.confirm("Descartar alterações que ainda não foram salvas?")
  )
    return;
  state.dirty = false;
  returnToAdmin();
}

function returnToAdmin() {
  window.location.assign(adminReturnUrl());
}

function adminReturnUrl() {
  return `/admin?folderId=${encodeURIComponent(state.returnFolderId)}`;
}

function validFolderId(folderId) {
  return folderId === "root" || /^[0-9a-f-]{36}$/i.test(String(folderId || ""));
}

function markDirty() {
  state.dirty = hasUnsavedChanges();
  updateSaveState();
}

function hasUnsavedChanges() {
  const visibility = elements.editorPublic.checked ? "public" : "private";
  return (
    (state.editor?.getValue() || "") !== state.originalContent ||
    elements.editorFileName.value.trim() !== state.originalName ||
    visibility !== state.originalVisibility
  );
}

function updateSaveState(text) {
  elements.editorSaveState.textContent =
    text || (state.dirty ? "Alterações não salvas" : "Sem alterações");
  elements.editorSaveState.classList.toggle("dirty", state.dirty);
}

function updateSize() {
  const bytes = new TextEncoder().encode(state.editor?.getValue() || "").length;
  elements.editorSize.textContent = formatBytes(bytes);
}

function updateDocumentTitle() {
  const name = elements.editorFileName.value.trim() || "Novo arquivo";
  document.title = `${name} — Editor VaultKeep`;
}

function scheduleLanguageDetection() {
  clearTimeout(state.detectionTimer);
  state.detectionTimer = setTimeout(detectLanguage, 650);
}

async function detectLanguage() {
  try {
    const result = await api("/api/text/detect", {
      method: "POST",
      body: JSON.stringify({
        name: elements.editorFileName.value,
        content: state.editor.getValue().slice(0, 60_000),
      }),
    });
    setLanguage(result.language);
  } catch {
    /* A detecção não impede a edição. */
  }
}

function setLanguage(language) {
  state.language = language || "plaintext";
  state.editor?.setOption("mode", codeMirrorMode(state.language));
  elements.editorLanguage.textContent = languageDisplayName(state.language);
  elements.editorLanguageCode.textContent = languageShortCode(state.language);
  document.body.dataset.language = state.language;
}

async function api(url, options = {}) {
  const { headers, ...rest } = options;
  const response = await fetch(url, {
    ...rest,
    headers: { "Content-Type": "application/json", ...headers },
  });
  if (response.status === 204) return null;
  const result = await response.json();
  if (response.status === 401) {
    window.location.replace("/login");
    throw new Error("Sua sessão expirou.");
  }
  if (!response.ok)
    throw new Error(result.error || "Não foi possível concluir.");
  return result;
}

function showError(message) {
  elements.editorError.textContent = message;
}

function showToast(message) {
  elements.editorToast.querySelector("p").textContent = message;
  elements.editorToast.classList.remove("hidden");
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / 1024 ** exponent).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} ${units[exponent]}`;
}

function codeMirrorMode(language) {
  return (
    {
      plaintext: null,
      markdown: "gfm",
      javascript: "javascript",
      typescript: { name: "javascript", typescript: true },
      json: { name: "javascript", json: true },
      html: "htmlmixed",
      xml: "xml",
      css: "css",
      scss: "text/x-scss",
      sass: "text/x-sass",
      less: "text/x-less",
      bash: "shell",
      powershell: "powershell",
      python: "python",
      ruby: "ruby",
      php: "application/x-httpd-php",
      java: "text/x-java",
      c: "text/x-csrc",
      cpp: "text/x-c++src",
      csharp: "text/x-csharp",
      go: "go",
      rust: "rust",
      sql: "text/x-sql",
      yaml: "yaml",
      ini: "properties",
      properties: "properties",
      dockerfile: "dockerfile",
      lua: "lua",
      r: "r",
      perl: "perl",
      dos: "shell",
      graphql: "javascript",
    }[language] ?? null
  );
}

function languageFromFilename(name) {
  const extension = name.toLowerCase().split(".").pop();
  return (
    {
      md: "markdown",
      markdown: "markdown",
      js: "javascript",
      mjs: "javascript",
      cjs: "javascript",
      jsx: "javascript",
      ts: "typescript",
      tsx: "typescript",
      json: "json",
      html: "html",
      htm: "html",
      css: "css",
      scss: "scss",
      sass: "sass",
      less: "less",
      xml: "xml",
      svg: "xml",
      yaml: "yaml",
      yml: "yaml",
      ps1: "powershell",
      psm1: "powershell",
      sh: "bash",
      bash: "bash",
      py: "python",
      rb: "ruby",
      php: "php",
      java: "java",
      c: "c",
      h: "c",
      cpp: "cpp",
      hpp: "cpp",
      cs: "csharp",
      go: "go",
      rs: "rust",
      sql: "sql",
      lua: "lua",
      r: "r",
      pl: "perl",
    }[extension] || "plaintext"
  );
}

function languageDisplayName(language) {
  return (
    {
      plaintext: "Texto simples",
      markdown: "Markdown",
      javascript: "JavaScript",
      typescript: "TypeScript",
      json: "JSON",
      html: "HTML",
      xml: "XML",
      css: "CSS",
      scss: "SCSS",
      sass: "Sass",
      less: "Less",
      bash: "Shell / Bash",
      powershell: "PowerShell",
      python: "Python",
      ruby: "Ruby",
      php: "PHP",
      java: "Java",
      c: "C",
      cpp: "C++",
      csharp: "C#",
      go: "Go",
      rust: "Rust",
      sql: "SQL",
      yaml: "YAML",
      ini: "INI / TOML",
      properties: "Properties",
      dockerfile: "Dockerfile",
      lua: "Lua",
      r: "R",
      perl: "Perl",
      graphql: "GraphQL",
      dos: "Batch",
    }[language] || String(language || "Texto simples")
  );
}

function languageShortCode(language) {
  return (
    {
      plaintext: "TXT",
      markdown: "MD",
      javascript: "JS",
      typescript: "TS",
      powershell: "PS1",
      python: "PY",
      csharp: "C#",
      dockerfile: "DOCKER",
    }[language] ||
    String(language || "TXT")
      .toUpperCase()
      .slice(0, 6)
  );
}
