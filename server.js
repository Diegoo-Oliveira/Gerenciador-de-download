const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const express = require("express");
const helmet = require("helmet");
const { AuthService } = require("./src/auth-service");
const { CatalogStore } = require("./src/catalog-store");
const { DocumentConverter } = require("./src/document-converter");
const { ImageConverter } = require("./src/image-converter");
const { createRateLimit } = require("./src/public-tool-security");
const {
  detectLanguage,
  isTextCandidate,
  mimeTypeForText,
  probeTextFile,
  readTextFile,
  writeTextFile,
} = require("./src/text-service");
const { UploadManager, UploadError } = require("./src/upload-manager");
const { receiveSingleFile } = require("./src/tool-upload");

loadEnv(path.join(__dirname, ".env"));

const app = express();
const PORT = numberFromEnv("PORT", 3000);
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || "";
const SESSION_SECRET =
  process.env.SESSION_SECRET || "desenvolvimento-troque-este-segredo";
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";
const MAX_FILE_SIZE_GB = numberFromEnv("MAX_FILE_SIZE_GB", 50);
const MAX_EDITABLE_TEXT_MB = numberFromEnv("MAX_EDITABLE_TEXT_MB", 5);
const MAX_EDITABLE_TEXT_BYTES = Math.round(MAX_EDITABLE_TEXT_MB * 1024 * 1024);
const MAX_PUBLIC_TEXT_PREVIEW_MB = numberFromEnv(
  "MAX_PUBLIC_TEXT_PREVIEW_MB",
  1,
);
const MAX_PUBLIC_TEXT_PREVIEW_BYTES = Math.round(
  MAX_PUBLIC_TEXT_PREVIEW_MB * 1024 * 1024,
);
const MAX_DOCUMENT_CONVERSION_MB = numberFromEnv("MAX_DOCUMENT_CONVERSION_MB", 10);
const MAX_IMAGE_CONVERSION_MB = numberFromEnv("MAX_IMAGE_CONVERSION_MB", 12);
const MAX_DOCUMENT_CONVERSION_BYTES = Math.round(
  MAX_DOCUMENT_CONVERSION_MB * 1024 * 1024,
);
const MAX_IMAGE_CONVERSION_BYTES = Math.round(
  MAX_IMAGE_CONVERSION_MB * 1024 * 1024,
);
const UPLOAD_CHUNK_SIZE_MB = numberFromEnv("UPLOAD_CHUNK_SIZE_MB", 8);
const UPLOAD_CONCURRENCY = Math.max(
  1,
  Math.min(Math.floor(numberFromEnv("UPLOAD_CONCURRENCY", 3)), 6),
);
const UPLOAD_SESSION_TTL_HOURS = numberFromEnv("UPLOAD_SESSION_TTL_HOURS", 72);
const LOGIN_MAX_ATTEMPTS_PER_IP = Math.max(
  1,
  Math.min(100, Math.floor(numberFromEnv("LOGIN_MAX_ATTEMPTS_PER_IP", 5))),
);
const LOGIN_MAX_ATTEMPTS_PER_ACCOUNT = Math.max(
  LOGIN_MAX_ATTEMPTS_PER_IP,
  Math.min(
    200,
    Math.floor(numberFromEnv("LOGIN_MAX_ATTEMPTS_PER_ACCOUNT", 10)),
  ),
);
const LOGIN_ATTEMPT_WINDOW_MINUTES = Math.max(
  1,
  Math.min(
    24 * 60,
    Math.floor(numberFromEnv("LOGIN_ATTEMPT_WINDOW_MINUTES", 15)),
  ),
);
const LOGIN_ATTEMPT_WINDOW_MS = LOGIN_ATTEMPT_WINDOW_MINUTES * 60 * 1000;
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const STORAGE_DIR = path.resolve(
  process.env.STORAGE_DIR || path.join(__dirname, "storage"),
);
const UPLOAD_DIR = path.join(STORAGE_DIR, "uploads");
const CHUNK_DIR = path.join(STORAGE_DIR, "chunks");
const METADATA_FILE = path.join(STORAGE_DIR, "files.json");
const USERS_FILE = path.join(STORAGE_DIR, "users.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const CODEMIRROR_DIR = path.join(__dirname, "node_modules", "codemirror");
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SESSION_COOKIE = COOKIE_SECURE
  ? "__Host-vaultkeep_session"
  : "vaultkeep_session";
const fileEditLocks = new Map();

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(CHUNK_DIR, { recursive: true });

const catalogStore = new CatalogStore(METADATA_FILE);
const authService = new AuthService({
  usersFile: USERS_FILE,
  sessionSecret: SESSION_SECRET,
  sessionDurationMs: SESSION_DURATION_MS,
  bootstrapUsername: ADMIN_USERNAME,
  bootstrapPasswordHash: ADMIN_PASSWORD_HASH,
});
const uploadManager = new UploadManager({
  chunkRoot: CHUNK_DIR,
  uploadRoot: UPLOAD_DIR,
  chunkSize: Math.round(UPLOAD_CHUNK_SIZE_MB * 1024 * 1024),
  maxFileSize: Math.round(MAX_FILE_SIZE_GB * 1024 * 1024 * 1024),
  sessionTtlMs: UPLOAD_SESSION_TTL_HOURS * 60 * 60 * 1000,
});
const documentConverter = new DocumentConverter();
const imageConverter = new ImageConverter();
const documentToolRateLimit = createRateLimit({
  limit: 12,
  windowMs: 15 * 60 * 1000,
});
const imageToolRateLimit = createRateLimit({
  limit: 20,
  windowMs: 15 * 60 * 1000,
});

app.set("trust proxy", isLoopbackAddress);
app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "blob:"],
      },
    },
    crossOriginResourcePolicy: { policy: "same-origin" },
  }),
);
app.use(express.json({ limit: `${Math.ceil(MAX_EDITABLE_TEXT_MB) + 1}mb` }));
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
app.use("/api", verifySameOriginMutation);
app.use(
  "/vendor/codemirror",
  express.static(CODEMIRROR_DIR, { maxAge: "7d", immutable: true }),
);
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

app.post("/api/login", async (req, res) => {
  const credentials =
    req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body
      : {};
  const rateLimitBuckets = loginRateLimitBuckets(req, credentials.username);
  const rateLimit = loginRateLimitStatus(rateLimitBuckets);
  if (rateLimit.blocked) {
    res.set({
      "RateLimit-Limit": String(rateLimit.limit),
      "RateLimit-Remaining": "0",
      "Retry-After": String(rateLimit.retryAfter),
    });
    return res
      .status(429)
      .json({ error: "Muitas tentativas. Aguarde antes de tentar novamente." });
  }
  const user = await authService.verifyCredentials(
    credentials.username,
    credentials.password,
  );
  if (!user) {
    recordLoginFailure(rateLimitBuckets);
    return res.status(401).json({ error: "Usuário ou senha inválidos." });
  }
  clearLoginFailures(rateLimitBuckets);
  const token = authService.createSession(user);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "strict",
    maxAge: SESSION_DURATION_MS,
    path: "/",
  });
  return res.json({ authenticated: true, user: clientUser(user) });
});

app.post("/api/logout", (req, res) => {
  authService.revoke(sessionToken(req));
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "strict",
    path: "/",
  });
  res.status(204).end();
});

app.get("/api/session", (req, res) => {
  const user = authenticatedUser(req);
  res.json({
    authenticated: Boolean(user),
    user: user ? clientUser(user) : null,
  });
});

app.get("/api/tools/documents/capabilities", (_req, res) => {
  res.json(documentConverter.capabilities(MAX_DOCUMENT_CONVERSION_BYTES));
});

app.post(
  "/api/tools/documents/convert",
  documentToolRateLimit,
  async (req, res, next) => {
    try {
      const upload = await receiveSingleFile(req, {
        maxBytes: MAX_DOCUMENT_CONVERSION_BYTES,
        allowedFields: ["target"],
      });
      const result = await documentConverter.convert({
        buffer: upload.buffer,
        filename: upload.filename,
        target: upload.fields.target,
      });
      return sendConversion(res, result);
    } catch (error) {
      return next(error);
    }
  },
);

app.get("/api/tools/images/capabilities", (_req, res) => {
  res.json(imageConverter.capabilities(MAX_IMAGE_CONVERSION_BYTES));
});

app.post(
  "/api/tools/images/convert",
  imageToolRateLimit,
  async (req, res, next) => {
    try {
      const upload = await receiveSingleFile(req, {
        maxBytes: MAX_IMAGE_CONVERSION_BYTES,
        allowedFields: [
          "format",
          "quality",
          "width",
          "height",
          "removeBackground",
          "tolerance",
        ],
      });
      const result = await imageConverter.convert({
        buffer: upload.buffer,
        filename: upload.filename,
        ...upload.fields,
      });
      return sendConversion(res, result);
    } catch (error) {
      return next(error);
    }
  },
);

app.get("/api/public-library", (req, res) => {
  const catalog = catalogStore.read();
  const folderId = normalizeFolderId(req.query.folderId);
  if (folderId && !isFolderPublic(catalog, folderId)) {
    return res.status(404).json({ error: "Pasta pública não encontrada." });
  }
  const folders = catalog.folders
    .filter(
      (folder) =>
        (folder.parentId || null) === folderId &&
        isFolderPublic(catalog, folder.id),
    )
    .sort((left, right) => left.name.localeCompare(right.name, "pt-BR"))
    .map(publicFolder);
  const files = catalog.files
    .filter(
      (file) =>
        (file.folderId || null) === folderId &&
        fileExists(file) &&
        isFilePublic(catalog, file),
    )
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
    .map(publicLibraryFile);
  res.json({
    currentFolderId: folderId,
    breadcrumbs: publicBreadcrumbsFor(catalog, folderId),
    folders,
    files,
  });
});

app.get("/api/public-library/files/:id/download", (req, res, next) => {
  const catalog = catalogStore.read();
  const file = catalog.files.find((item) => item.id === req.params.id);
  if (!file || !isFilePublic(catalog, file)) {
    return res.status(404).json({ error: "Arquivo público não encontrado." });
  }
  return deliverFile(file, res, next, "no-store");
});

app.get("/api/public-library/files/:id/content", async (req, res) => {
  const catalog = catalogStore.read();
  const file = catalog.files.find((item) => item.id === req.params.id);
  if (
    !file ||
    !isFilePublic(catalog, file) ||
    !fileExists(file) ||
    file.editable === false ||
    !isTextCandidate(file, MAX_PUBLIC_TEXT_PREVIEW_BYTES)
  ) {
    return res
      .status(404)
      .json({ error: "Arquivo público de texto não encontrado." });
  }

  let text;
  try {
    text = await readTextFile(
      absoluteFilePath(file),
      MAX_PUBLIC_TEXT_PREVIEW_BYTES,
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      return res
        .status(404)
        .json({ error: "Arquivo público de texto não encontrado." });
    }
    throw error;
  }
  const latestCatalog = catalogStore.read();
  const latestFile = latestCatalog.files.find((item) => item.id === file.id);
  if (
    !latestFile ||
    !isFilePublic(latestCatalog, latestFile) ||
    !fileExists(latestFile) ||
    latestFile.editable === false ||
    !isTextCandidate(latestFile, MAX_PUBLIC_TEXT_PREVIEW_BYTES)
  ) {
    return res
      .status(404)
      .json({ error: "Arquivo público de texto não encontrado." });
  }
  res.set({
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  return res.json({
    file: {
      id: latestFile.id,
      name: latestFile.name,
      size: latestFile.size,
      mimeType: latestFile.mimeType,
      updatedAt: latestFile.updatedAt || latestFile.createdAt,
    },
    content: text.content,
    encoding: text.encoding,
    language: detectLanguage(latestFile.name, text.content),
  });
});

app.get("/api/public/:token", (req, res) => {
  const file = findPublicFile(req.params.token);
  if (!file)
    return res
      .status(404)
      .json({ error: "Link público inválido ou desativado." });
  if (!fileExists(file))
    return res
      .status(404)
      .json({ error: "O arquivo não está mais disponível." });
  return res.json({
    file: {
      name: file.name,
      size: file.size,
      mimeType: file.mimeType,
      createdAt: file.createdAt,
    },
  });
});

app.get("/api/public/:token/download", (req, res, next) => {
  const file = findPublicFile(req.params.token);
  if (!file)
    return res
      .status(404)
      .json({ error: "Link público inválido ou desativado." });
  return deliverFile(file, res, next, "no-store");
});

app.get("/s/:token", (req, res, next) => {
  if (!PUBLIC_TOKEN_PATTERN.test(req.params.token))
    return res.status(404).send("Link inválido.");
  return res.sendFile(path.join(PUBLIC_DIR, "index.html"), (error) => {
    if (error && !res.headersSent) next(error);
  });
});

app.get(["/admin", "/login"], (_req, res, next) => {
  return res.sendFile(path.join(PUBLIC_DIR, "index.html"), (error) => {
    if (error && !res.headersSent) next(error);
  });
});

app.get("/tools/pdf", (_req, res, next) => {
  return res.sendFile(path.join(PUBLIC_DIR, "document-converter.html"), (error) => {
    if (error && !res.headersSent) next(error);
  });
});

app.get("/tools/images", (_req, res, next) => {
  return res.sendFile(path.join(PUBLIC_DIR, "image-converter.html"), (error) => {
    if (error && !res.headersSent) next(error);
  });
});

app.get("/tools/passwords", (_req, res, next) => {
  return res.sendFile(path.join(PUBLIC_DIR, "password-generator.html"), (error) => {
    if (error && !res.headersSent) next(error);
  });
});

app.get("/editor", (_req, res, next) => {
  return res.sendFile(path.join(PUBLIC_DIR, "editor.html"), (error) => {
    if (error && !res.headersSent) next(error);
  });
});

app.get("/api/files", requireAuth, (req, res) => {
  const catalog = catalogStore.read();
  const folderId = normalizeFolderId(req.query.folderId);
  assertFolderExists(catalog, folderId);
  const availableFiles = catalog.files.filter(fileExists);
  const files = availableFiles
    .filter((file) => (file.folderId || null) === folderId)
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
    .map(publicFile);
  const folders = catalog.folders
    .filter((folder) => (folder.parentId || null) === folderId)
    .sort((left, right) => left.name.localeCompare(right.name, "pt-BR"))
    .map((folder) => ({
      ...folder,
      visibility: visibilityOf(folder),
      publiclyAccessible: isFolderPublic(catalog, folder.id),
      itemCount:
        catalog.files.filter((file) => file.folderId === folder.id).length +
        catalog.folders.filter((child) => child.parentId === folder.id).length,
    }));
  res.json({
    files,
    folders,
    currentFolderId: folderId,
    currentFolder: folderId
      ? (() => {
          const folder = catalog.folders.find((item) => item.id === folderId);
          return {
            id: folder.id,
            name: folder.name,
            visibility: visibilityOf(folder),
            publiclyAccessible: isFolderPublic(catalog, folder.id),
          };
        })()
      : null,
    breadcrumbs: breadcrumbsFor(catalog, folderId),
    summary: {
      fileCount: availableFiles.length,
      totalBytes: availableFiles.reduce(
        (total, file) => total + Number(file.size || 0),
        0,
      ),
    },
    upload: {
      maxFileSizeGb: MAX_FILE_SIZE_GB,
      maxEditableTextMb: MAX_EDITABLE_TEXT_MB,
      chunkSizeMb: UPLOAD_CHUNK_SIZE_MB,
      concurrency: UPLOAD_CONCURRENCY,
    },
  });
});

app.get("/api/folders", requireAuth, (_req, res) => {
  const catalog = catalogStore.read();
  res.json({ folders: catalog.folders, tree: folderTree(catalog) });
});

app.post("/api/folders", requireAuth, (req, res) => {
  const catalog = catalogStore.read();
  const parentId = normalizeFolderId(req.body.parentId);
  assertFolderExists(catalog, parentId);
  const name = cleanFolderName(req.body.name);
  assertUniqueFolderName(catalog, name, parentId);
  const folder = {
    id: crypto.randomUUID(),
    name,
    parentId,
    visibility: cleanVisibility(req.body.visibility),
    createdAt: new Date().toISOString(),
  };
  catalog.folders.push(folder);
  catalogStore.write(catalog);
  res.status(201).json({ folder });
});

app.patch("/api/folders/:id", requireAuth, (req, res) => {
  const catalog = catalogStore.read();
  const folder = catalog.folders.find((item) => item.id === req.params.id);
  if (!folder) return res.status(404).json({ error: "Pasta não encontrada." });

  const nextName = Object.hasOwn(req.body, "name")
    ? cleanFolderName(req.body.name)
    : folder.name;
  const nextParentId = Object.hasOwn(req.body, "parentId")
    ? normalizeFolderId(req.body.parentId)
    : folder.parentId;
  const nextVisibility = Object.hasOwn(req.body, "visibility")
    ? cleanVisibility(req.body.visibility)
    : visibilityOf(folder);
  assertFolderExists(catalog, nextParentId);
  if (
    nextParentId === folder.id ||
    isFolderDescendant(catalog, nextParentId, folder.id)
  ) {
    throw httpError(
      "Uma pasta não pode ser movida para dentro dela mesma.",
      409,
    );
  }
  assertUniqueFolderName(catalog, nextName, nextParentId, folder.id);
  folder.name = nextName;
  folder.parentId = nextParentId;
  folder.visibility = nextVisibility;
  folder.updatedAt = new Date().toISOString();
  catalogStore.write(catalog);
  res.json({ folder });
});

app.delete("/api/folders/:id", requireAuth, (req, res) => {
  const catalog = catalogStore.read();
  const index = catalog.folders.findIndex((item) => item.id === req.params.id);
  if (index === -1)
    return res.status(404).json({ error: "Pasta não encontrada." });
  const hasContent =
    catalog.files.some((file) => file.folderId === req.params.id) ||
    catalog.folders.some((folder) => folder.parentId === req.params.id);
  if (hasContent)
    throw httpError("A pasta precisa estar vazia antes de ser excluída.", 409);
  catalog.folders.splice(index, 1);
  catalogStore.write(catalog);
  res.status(204).end();
});

app.post("/api/uploads", requireAuth, async (req, res) => {
  const catalog = catalogStore.read();
  const folderId = normalizeFolderId(req.body.folderId);
  assertFolderExists(catalog, folderId);
  const visibility = cleanVisibility(req.body.visibility);
  const session = await uploadManager.initialize({
    ...req.body,
    folderId,
    visibility,
  });
  return res
    .status(session.resumed ? 200 : 201)
    .json({ ...session, concurrency: UPLOAD_CONCURRENCY });
});

app.get("/api/uploads/:id", requireAuth, async (req, res) => {
  res.json(await uploadManager.status(req.params.id));
});

app.put("/api/uploads/:id/chunks/:index", requireAuth, async (req, res) => {
  if (req.headers["content-type"] !== "application/octet-stream") {
    throw new UploadError("O bloco deve usar application/octet-stream.", 415);
  }
  const result = await uploadManager.receiveChunk(
    req.params.id,
    req.params.index,
    req,
  );
  res.status(result.alreadyUploaded ? 200 : 201).json(result);
});

app.post("/api/uploads/:id/complete", requireAuth, async (req, res) => {
  const file = await uploadManager.finalize(req.params.id, async (newFile) => {
    newFile.editable = await probeTextFile(
      path.join(UPLOAD_DIR, newFile.storedName),
      newFile,
      MAX_EDITABLE_TEXT_BYTES,
    );
    const latestCatalog = catalogStore.read();
    if (!latestCatalog.files.some((item) => item.id === newFile.id)) {
      latestCatalog.files.push(newFile);
      catalogStore.write(latestCatalog);
    }
  });
  res.status(201).json({ file: publicFile(file) });
});

app.delete("/api/uploads/:id", requireAuth, async (req, res) => {
  await uploadManager.cancel(req.params.id);
  res.status(204).end();
});

app.post("/api/text-files", requireAuth, async (req, res) => {
  const catalog = catalogStore.read();
  const folderId = normalizeFolderId(req.body.folderId);
  assertFolderExists(catalog, folderId);
  const name = cleanFilename(req.body.name);
  if (typeof req.body.content !== "string")
    throw httpError("O conteúdo do arquivo é obrigatório.", 400);

  const extension = path.extname(name).toLowerCase();
  const storedName = `${crypto.randomUUID()}${extension}`;
  const absolutePath = path.join(UPLOAD_DIR, storedName);
  const written = await writeTextFile(
    absolutePath,
    req.body.content,
    "utf8",
    MAX_EDITABLE_TEXT_BYTES,
  );
  const file = {
    id: crypto.randomUUID(),
    name,
    storedName,
    folderId,
    visibility: cleanVisibility(req.body.visibility),
    size: written.size,
    mimeType: mimeTypeForText(name),
    sha256: written.sha256,
    editable: true,
    createdAt: new Date().toISOString(),
  };
  const latestCatalog = catalogStore.read();
  latestCatalog.files.push(file);
  catalogStore.write(latestCatalog);
  res.status(201).json({ file: publicFile(file) });
});

app.get("/api/files/:id/content", requireAuth, async (req, res) => {
  const file = findFile(req.params.id);
  const absolutePath = absoluteFilePath(file);
  const text = await readTextFile(absolutePath, MAX_EDITABLE_TEXT_BYTES);
  res.json({
    file: publicFile({ ...file, editable: true }),
    content: text.content,
    encoding: text.encoding,
    revision: text.revision,
    language: detectLanguage(file.name, text.content),
  });
});

app.put("/api/files/:id/content", requireAuth, async (req, res) => {
  if (typeof req.body.content !== "string")
    throw httpError("O conteúdo do arquivo é obrigatório.", 400);
  if (!/^[a-f0-9]{64}$/.test(String(req.body.revision || "")))
    throw httpError("A revisão do arquivo é obrigatória.", 400);
  const result = await withFileEditLock(req.params.id, async () => {
    const catalog = catalogStore.read();
    const file = catalog.files.find((item) => item.id === req.params.id);
    if (!file) throw httpError("Arquivo não encontrado.", 404);
    const absolutePath = absoluteFilePath(file);
    const current = await readTextFile(absolutePath, MAX_EDITABLE_TEXT_BYTES);
    if (!safeEqual(current.revision, req.body.revision)) {
      throw httpError(
        "O arquivo foi alterado em outra sessão. Reabra antes de salvar.",
        409,
      );
    }
    const written = await writeTextFile(
      absolutePath,
      req.body.content,
      current.encoding,
      MAX_EDITABLE_TEXT_BYTES,
    );
    const latestCatalog = catalogStore.read();
    const latestFile = latestCatalog.files.find(
      (item) => item.id === req.params.id,
    );
    if (!latestFile)
      throw httpError("O arquivo foi removido durante a edição.", 409);
    latestFile.size = written.size;
    latestFile.sha256 = written.sha256;
    latestFile.editable = true;
    latestFile.updatedAt = new Date().toISOString();
    catalogStore.write(latestCatalog);
    return {
      file: publicFile(latestFile),
      revision: written.sha256,
      language: detectLanguage(latestFile.name, req.body.content),
    };
  });
  res.json(result);
});

app.post("/api/text/detect", requireAuth, (req, res) => {
  if (typeof req.body.content !== "string")
    throw httpError("O conteúdo de texto é obrigatório.", 400);
  res.json({
    language: detectLanguage(
      cleanFilename(req.body.name || "arquivo.txt"),
      req.body.content.slice(0, 60_000),
    ),
  });
});

app.patch("/api/files/:id", requireAuth, (req, res) => {
  const catalog = catalogStore.read();
  const file = catalog.files.find((item) => item.id === req.params.id);
  if (!file) return res.status(404).json({ error: "Arquivo não encontrado." });
  if (Object.hasOwn(req.body, "name")) file.name = cleanFilename(req.body.name);
  if (Object.hasOwn(req.body, "folderId")) {
    const folderId = normalizeFolderId(req.body.folderId);
    assertFolderExists(catalog, folderId);
    file.folderId = folderId;
  }
  if (Object.hasOwn(req.body, "visibility")) {
    file.visibility = cleanVisibility(req.body.visibility);
  }
  file.updatedAt = new Date().toISOString();
  catalogStore.write(catalog);
  res.json({ file: publicFile(file) });
});

app.get("/api/files/:id/share", requireAuth, (req, res) => {
  const file = findFile(req.params.id);
  if (!file.publicToken) return res.json({ isPublic: false, url: null });
  res.json({ isPublic: true, url: publicUrl(req, file.publicToken) });
});

app.post("/api/files/:id/share", requireAuth, (req, res) => {
  const catalog = catalogStore.read();
  const file = catalog.files.find((item) => item.id === req.params.id);
  if (!file) return res.status(404).json({ error: "Arquivo não encontrado." });
  if (!file.publicToken) {
    file.publicToken = uniquePublicToken(catalog);
    file.publishedAt = new Date().toISOString();
    catalogStore.write(catalog);
  }
  res
    .status(201)
    .json({ isPublic: true, url: publicUrl(req, file.publicToken) });
});

app.delete("/api/files/:id/share", requireAuth, (req, res) => {
  const catalog = catalogStore.read();
  const file = catalog.files.find((item) => item.id === req.params.id);
  if (!file) return res.status(404).json({ error: "Arquivo não encontrado." });
  delete file.publicToken;
  delete file.publishedAt;
  catalogStore.write(catalog);
  res.status(204).end();
});

app.get("/api/files/:id/download", requireAuth, (req, res, next) => {
  const file = findFile(req.params.id);
  return deliverFile(file, res, next, "private, no-store");
});

app.delete("/api/files/:id", requireAuth, (req, res) => {
  const catalog = catalogStore.read();
  const index = catalog.files.findIndex((item) => item.id === req.params.id);
  if (index === -1)
    return res.status(404).json({ error: "Arquivo não encontrado." });
  const [file] = catalog.files.splice(index, 1);
  const absolutePath = absoluteFilePath(file);
  if (fs.existsSync(absolutePath)) fs.unlinkSync(absolutePath);
  catalogStore.write(catalog);
  res.status(204).end();
});

app.use("/api", (_req, res) =>
  res.status(404).json({ error: "Rota não encontrada." }),
);

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  const expected = error instanceof UploadError || error.expected === true;
  if (
    !expected &&
    status >= 500
  )
    console.error(error);
  res
    .status(status)
    .json({
      error: expected
        ? error.message
        : status >= 500
          ? "Erro interno do servidor."
          : "Requisição inválida.",
    });
});

uploadManager.cleanupExpired().catch(console.error);
setInterval(
  () => {
    uploadManager.cleanupExpired().catch(console.error);
    authService.cleanupExpired();
    cleanupLoginFailures();
    documentToolRateLimit.cleanup();
    imageToolRateLimit.cleanup();
  },
  60 * 60 * 1000,
).unref();

startServer().catch((error) => {
  console.error(`Falha ao iniciar o VaultKeep: ${error.message}`);
  process.exitCode = 1;
});

async function startServer() {
  await authService.initialize();
  app.listen(PORT, () => {
    console.log(`VaultKeep disponível em http://localhost:${PORT}`);
    console.log(
      `Uploads: blocos de ${UPLOAD_CHUNK_SIZE_MB} MB, ${UPLOAD_CONCURRENCY} em paralelo, limite de ${MAX_FILE_SIZE_GB} GB.`,
    );
    console.log(
      `Conversores públicos: documentos até ${MAX_DOCUMENT_CONVERSION_MB} MB e imagens até ${MAX_IMAGE_CONVERSION_MB} MB.`,
    );
    console.log(
      `Login: bloqueio após ${LOGIN_MAX_ATTEMPTS_PER_IP} falhas por IP ou ${LOGIN_MAX_ATTEMPTS_PER_ACCOUNT} por conta em ${LOGIN_ATTEMPT_WINDOW_MINUTES} minutos.`,
    );
    if (!COOKIE_SECURE) {
      console.warn(
        "ATENÇÃO: COOKIE_SECURE=false. Use true quando o acesso externo estiver em HTTPS.",
      );
    }
  });
}

function loadEnv(filename) {
  if (!fs.existsSync(filename)) return;
  for (const rawLine of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

function publicFile(file) {
  return {
    id: file.id,
    name: file.name,
    folderId: file.folderId || null,
    size: file.size,
    mimeType: file.mimeType,
    sha256: file.sha256,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    visibility: visibilityOf(file),
    editable:
      typeof file.editable === "boolean"
        ? file.editable
        : isTextCandidate(file, MAX_EDITABLE_TEXT_BYTES),
    isShared: Boolean(file.publicToken),
  };
}

function publicFolder(folder) {
  return {
    id: folder.id,
    name: folder.name,
    parentId: folder.parentId || null,
    createdAt: folder.createdAt,
  };
}

function publicLibraryFile(file) {
  return {
    id: file.id,
    name: file.name,
    folderId: file.folderId || null,
    size: file.size,
    mimeType: file.mimeType,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    previewable:
      file.editable !== false &&
      isTextCandidate(file, MAX_PUBLIC_TEXT_PREVIEW_BYTES),
  };
}

function findFile(id) {
  const file = catalogStore.read().files.find((item) => item.id === id);
  if (!file) throw httpError("Arquivo não encontrado.", 404);
  return file;
}

function findPublicFile(token) {
  if (!PUBLIC_TOKEN_PATTERN.test(String(token))) return null;
  return (
    catalogStore.read().files.find((file) => file.publicToken === token) || null
  );
}

function fileExists(file) {
  return fs.existsSync(absoluteFilePath(file));
}

function absoluteFilePath(file) {
  return path.join(UPLOAD_DIR, path.basename(file.storedName));
}

function deliverFile(file, res, next, cacheControl) {
  const absolutePath = absoluteFilePath(file);
  if (!fs.existsSync(absolutePath))
    return res
      .status(404)
      .json({ error: "O arquivo não existe mais no disco." });
  res.set({
    "Accept-Ranges": "bytes",
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
  });
  res.attachment(file.name);
  return res.sendFile(absolutePath, { acceptRanges: true }, (error) => {
    if (error && !res.headersSent) next(error);
  });
}

function sendConversion(res, result) {
  res.attachment(result.filename);
  res.set({
    "Content-Type": result.mimeType,
    "Content-Length": String(result.buffer.length),
    "Cache-Control": "private, no-store, max-age=0",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
    "X-Conversion-Source": result.source,
    "X-Conversion-Target": result.target,
  });
  if (result.width) res.set("X-Image-Width", String(result.width));
  if (result.height) res.set("X-Image-Height", String(result.height));
  return res.send(result.buffer);
}

function normalizeFolderId(value) {
  if (value === undefined || value === null || value === "" || value === "root")
    return null;
  if (!UUID_PATTERN.test(String(value)))
    throw httpError("Identificador de pasta inválido.", 400);
  return String(value);
}

function assertFolderExists(catalog, folderId) {
  if (folderId && !catalog.folders.some((folder) => folder.id === folderId)) {
    throw httpError("Pasta não encontrada.", 404);
  }
}

function cleanFolderName(value) {
  const name = String(value || "")
    .replace(/[\u0000-\u001f\u007f/\\]/g, "")
    .trim();
  if (!name || name.length > 100 || name === "." || name === "..")
    throw httpError("Nome de pasta inválido.", 400);
  return name;
}

function cleanFilename(value) {
  const name = path
    .basename(String(value || "").replace(/[\u0000-\u001f\u007f]/g, ""))
    .trim();
  if (!name || name.length > 255 || name === "." || name === "..")
    throw httpError("Nome de arquivo inválido.", 400);
  return name;
}

function cleanVisibility(value) {
  return value === "public" ? "public" : "private";
}

function visibilityOf(item) {
  return item?.visibility === "public" ? "public" : "private";
}

function isFolderPublic(catalog, folderId) {
  let currentId = folderId;
  const visited = new Set();
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const folder = catalog.folders.find((item) => item.id === currentId);
    if (!folder || visibilityOf(folder) !== "public") return false;
    currentId = folder.parentId || null;
  }
  return currentId === null;
}

function isFilePublic(catalog, file) {
  return (
    visibilityOf(file) === "public" &&
    (!file.folderId || isFolderPublic(catalog, file.folderId))
  );
}

function assertUniqueFolderName(catalog, name, parentId, ignoredId = null) {
  if (
    catalog.folders.some(
      (folder) =>
        folder.id !== ignoredId &&
        (folder.parentId || null) === parentId &&
        folder.name.localeCompare(name, "pt-BR", { sensitivity: "accent" }) ===
          0,
    )
  ) {
    throw httpError("Já existe uma pasta com este nome neste local.", 409);
  }
}

function isFolderDescendant(catalog, candidateId, ancestorId) {
  let currentId = candidateId;
  const visited = new Set();
  while (currentId && !visited.has(currentId)) {
    if (currentId === ancestorId) return true;
    visited.add(currentId);
    currentId =
      catalog.folders.find((folder) => folder.id === currentId)?.parentId ||
      null;
  }
  return false;
}

function breadcrumbsFor(catalog, folderId) {
  const breadcrumbs = [];
  let currentId = folderId;
  const visited = new Set();
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const folder = catalog.folders.find((item) => item.id === currentId);
    if (!folder) break;
    breadcrumbs.unshift({ id: folder.id, name: folder.name });
    currentId = folder.parentId || null;
  }
  return [{ id: null, name: "Bunker" }, ...breadcrumbs];
}

function publicBreadcrumbsFor(catalog, folderId) {
  return breadcrumbsFor(catalog, folderId).map(({ id, name }) => ({
    id,
    name,
  }));
}

function folderTree(catalog) {
  const result = [];
  function append(parentId, depth) {
    catalog.folders
      .filter((folder) => (folder.parentId || null) === parentId)
      .sort((left, right) => left.name.localeCompare(right.name, "pt-BR"))
      .forEach((folder) => {
        result.push({ ...folder, depth });
        append(folder.id, depth + 1);
      });
  }
  append(null, 0);
  return result;
}

function uniquePublicToken(catalog) {
  let token;
  do {
    token = crypto.randomBytes(32).toString("base64url");
  } while (catalog.files.some((file) => file.publicToken === token));
  return token;
}

function publicUrl(req, token) {
  return `${req.protocol}://${req.get("host")}/s/${token}`;
}

function parseCookies(req) {
  const cookies = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    try {
      const key = decodeURIComponent(part.slice(0, separator).trim());
      const value = decodeURIComponent(part.slice(separator + 1).trim());
      if (key) cookies[key] = value;
    } catch {
      /* Cookies malformados são ignorados. */
    }
  }
  return cookies;
}

function sessionToken(req) {
  return parseCookies(req)[SESSION_COOKIE] || "";
}

function authenticatedUser(req) {
  return authService.authenticate(sessionToken(req));
}

function requireAuth(req, res, next) {
  const user = authenticatedUser(req);
  if (!user)
    return res.status(401).json({ error: "Faça login para continuar." });
  if (user.role !== "admin")
    return res.status(403).json({ error: "Permissão administrativa exigida." });
  req.user = user;
  return next();
}

function clientUser(user) {
  return { username: user.username, role: user.role };
}

function isLoopbackAddress(address) {
  const value = String(address || "").toLowerCase();
  return (
    value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1"
  );
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  error.expected = true;
  return error;
}

async function withFileEditLock(fileId, task) {
  while (fileEditLocks.has(fileId)) await fileEditLocks.get(fileId);
  let release;
  const lock = new Promise((resolve) => {
    release = resolve;
  });
  fileEditLocks.set(fileId, lock);
  try {
    return await task();
  } finally {
    if (fileEditLocks.get(fileId) === lock) fileEditLocks.delete(fileId);
    release();
  }
}

const loginAttempts = new Map();
function loginRateLimitBuckets(req, usernameValue) {
  const ip = String(req.ip || req.socket.remoteAddress || "desconhecido")
    .toLowerCase()
    .replace(/^::ffff:/, "");
  const account = String(usernameValue || "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("pt-BR")
    .slice(0, 128);
  const accountDigest = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(account || "conta-vazia")
    .digest("hex");
  return [
    { key: `ip:${ip}`, limit: LOGIN_MAX_ATTEMPTS_PER_IP },
    {
      key: `account:${accountDigest}`,
      limit: LOGIN_MAX_ATTEMPTS_PER_ACCOUNT,
    },
  ];
}

function recentLoginFailures(key) {
  const now = Date.now();
  const attempts = (loginAttempts.get(key) || []).filter(
    (time) => now - time < LOGIN_ATTEMPT_WINDOW_MS,
  );
  if (attempts.length) loginAttempts.set(key, attempts);
  else loginAttempts.delete(key);
  return attempts;
}

function loginRateLimitStatus(buckets) {
  const now = Date.now();
  const blockedBuckets = buckets
    .map((bucket) => ({
      ...bucket,
      attempts: recentLoginFailures(bucket.key),
    }))
    .filter((bucket) => bucket.attempts.length >= bucket.limit);
  if (!blockedBuckets.length) return { blocked: false };
  return {
    blocked: true,
    limit: Math.min(...blockedBuckets.map((bucket) => bucket.limit)),
    retryAfter: Math.max(
      1,
      ...blockedBuckets.map((bucket) =>
        Math.ceil(
          (bucket.attempts[0] + LOGIN_ATTEMPT_WINDOW_MS - now) / 1000,
        ),
      ),
    ),
  };
}

function recordLoginFailure(buckets) {
  const now = Date.now();
  for (const bucket of buckets) {
    loginAttempts.set(bucket.key, [...recentLoginFailures(bucket.key), now]);
  }
}

function clearLoginFailures(buckets) {
  for (const bucket of buckets) loginAttempts.delete(bucket.key);
}

function cleanupLoginFailures() {
  for (const key of loginAttempts.keys()) recentLoginFailures(key);
}

function verifySameOriginMutation(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const fetchSite = String(req.get("sec-fetch-site") || "").toLowerCase();
  if (fetchSite === "cross-site") {
    return res.status(403).json({ error: "Origem da requisição recusada." });
  }
  const origin = req.get("origin");
  if (!origin) return next();
  try {
    const expected = new URL(`${req.protocol}://${req.get("host")}`).origin;
    if (new URL(origin).origin !== expected) {
      return res.status(403).json({ error: "Origem da requisição recusada." });
    }
  } catch {
    return res.status(403).json({ error: "Origem da requisição recusada." });
  }
  return next();
}
