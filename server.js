const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const express = require('express');
const helmet = require('helmet');
const { UploadManager, UploadError } = require('./src/upload-manager');

loadEnv(path.join(__dirname, '.env'));

const app = express();
const PORT = numberFromEnv('PORT', 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const SESSION_SECRET = process.env.SESSION_SECRET || 'desenvolvimento-troque-este-segredo';
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const MAX_FILE_SIZE_GB = numberFromEnv('MAX_FILE_SIZE_GB', 50);
const UPLOAD_CHUNK_SIZE_MB = numberFromEnv('UPLOAD_CHUNK_SIZE_MB', 8);
const UPLOAD_CONCURRENCY = Math.max(1, Math.min(Math.floor(numberFromEnv('UPLOAD_CONCURRENCY', 3)), 6));
const UPLOAD_SESSION_TTL_HOURS = numberFromEnv('UPLOAD_SESSION_TTL_HOURS', 72);
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR || path.join(__dirname, 'storage'));
const UPLOAD_DIR = path.join(STORAGE_DIR, 'uploads');
const CHUNK_DIR = path.join(STORAGE_DIR, 'chunks');
const METADATA_FILE = path.join(STORAGE_DIR, 'files.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ALLOWED_EXTENSIONS = new Set(['.zip', '.rar', '.7z', '.iso']);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(CHUNK_DIR, { recursive: true });

const uploadManager = new UploadManager({
  chunkRoot: CHUNK_DIR,
  uploadRoot: UPLOAD_DIR,
  chunkSize: Math.round(UPLOAD_CHUNK_SIZE_MB * 1024 * 1024),
  maxFileSize: Math.round(MAX_FILE_SIZE_GB * 1024 * 1024 * 1024),
  sessionTtlMs: UPLOAD_SESSION_TTL_HOURS * 60 * 60 * 1000,
  allowedExtensions: ALLOWED_EXTENSIONS,
});

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
    },
  },
  crossOriginResourcePolicy: { policy: 'same-origin' },
}));
app.use(express.json({ limit: '32kb' }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.post('/api/login', loginRateLimit, (req, res) => {
  const submitted = String(req.body.password || '');
  if (!safeEqual(submitted, ADMIN_PASSWORD)) return res.status(401).json({ error: 'Senha incorreta.' });

  const expiresAt = Date.now() + SESSION_DURATION_MS;
  res.cookie('personal_cloud_session', signSession(expiresAt), {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'strict',
    maxAge: SESSION_DURATION_MS,
    path: '/',
  });
  return res.json({ authenticated: true });
});

app.post('/api/logout', (_req, res) => {
  res.clearCookie('personal_cloud_session', { path: '/' });
  res.status(204).end();
});

app.get('/api/session', (req, res) => res.json({ authenticated: isAuthenticated(req) }));

app.get('/api/files', requireAuth, (_req, res) => {
  const files = readMetadata()
    .filter((file) => fs.existsSync(path.join(UPLOAD_DIR, file.storedName)))
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
  res.json({
    files,
    upload: {
      maxFileSizeGb: MAX_FILE_SIZE_GB,
      chunkSizeMb: UPLOAD_CHUNK_SIZE_MB,
      concurrency: UPLOAD_CONCURRENCY,
    },
  });
});

app.post('/api/uploads', requireAuth, async (req, res) => {
  const session = await uploadManager.initialize(req.body || {});
  return res.status(session.resumed ? 200 : 201).json({ ...session, concurrency: UPLOAD_CONCURRENCY });
});

app.get('/api/uploads/:id', requireAuth, async (req, res) => {
  res.json(await uploadManager.status(req.params.id));
});

app.put('/api/uploads/:id/chunks/:index', requireAuth, async (req, res) => {
  if (req.headers['content-type'] !== 'application/octet-stream') {
    throw new UploadError('O bloco deve usar application/octet-stream.', 415);
  }
  const result = await uploadManager.receiveChunk(req.params.id, req.params.index, req);
  res.status(result.alreadyUploaded ? 200 : 201).json(result);
});

app.post('/api/uploads/:id/complete', requireAuth, async (req, res) => {
  const file = await uploadManager.finalize(req.params.id, async (newFile) => {
    const metadata = readMetadata();
    if (!metadata.some((item) => item.id === newFile.id)) {
      metadata.push(newFile);
      writeMetadata(metadata);
    }
  });
  res.status(201).json({ file });
});

app.delete('/api/uploads/:id', requireAuth, async (req, res) => {
  await uploadManager.cancel(req.params.id);
  res.status(204).end();
});

app.get('/api/files/:id/download', requireAuth, (req, res, next) => {
  const metadata = readMetadata();
  const file = metadata.find((item) => item.id === req.params.id);
  if (!file) return res.status(404).json({ error: 'Arquivo não encontrado.' });

  const absolutePath = path.join(UPLOAD_DIR, file.storedName);
  if (!fs.existsSync(absolutePath)) return res.status(404).json({ error: 'O arquivo não existe mais no disco.' });

  res.set({ 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store' });
  res.attachment(file.name);
  return res.sendFile(absolutePath, { acceptRanges: true }, (error) => {
    if (error && !res.headersSent) next(error);
  });
});

app.delete('/api/files/:id', requireAuth, (req, res) => {
  const metadata = readMetadata();
  const index = metadata.findIndex((item) => item.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Arquivo não encontrado.' });

  const [file] = metadata.splice(index, 1);
  const absolutePath = path.join(UPLOAD_DIR, file.storedName);
  if (fs.existsSync(absolutePath)) fs.unlinkSync(absolutePath);
  writeMetadata(metadata);
  return res.status(204).end();
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));

app.use((error, _req, res, _next) => {
  if (!(error instanceof UploadError)) console.error(error);
  return res.status(error.status || 500).json({ error: error.message || 'Erro interno do servidor.' });
});

uploadManager.cleanupExpired().catch(console.error);
setInterval(() => uploadManager.cleanupExpired().catch(console.error), 60 * 60 * 1000).unref();

app.listen(PORT, () => {
  console.log(`VaultKeep disponível em http://localhost:${PORT}`);
  console.log(`Uploads: blocos de ${UPLOAD_CHUNK_SIZE_MB} MB, ${UPLOAD_CONCURRENCY} em paralelo, limite de ${MAX_FILE_SIZE_GB} GB.`);
  if (ADMIN_PASSWORD === 'admin' || SESSION_SECRET.startsWith('desenvolvimento-')) {
    console.warn('ATENÇÃO: configure ADMIN_PASSWORD e SESSION_SECRET no .env antes de publicar.');
  }
});

function loadEnv(filename) {
  if (!fs.existsSync(filename)) return;
  for (const rawLine of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

function readMetadata() {
  try { return JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function writeMetadata(files) {
  const temporaryFile = `${METADATA_FILE}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(files, null, 2));
  fs.renameSync(temporaryFile, METADATA_FILE);
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '')
    .split(';')
    .map((part) => part.trim().split('=').map(decodeURIComponent))
    .filter(([key]) => key));
}

function signSession(expiresAt) {
  const payload = String(expiresAt);
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function isAuthenticated(req) {
  const token = parseCookies(req).personal_cloud_session;
  if (!token) return false;
  const [expiresAt, signature] = token.split('.');
  if (!expiresAt || !signature || Number(expiresAt) < Date.now()) return false;
  return safeEqual(signature, signSession(expiresAt).split('.')[1]);
}

function requireAuth(req, res, next) {
  return isAuthenticated(req) ? next() : res.status(401).json({ error: 'Faça login para continuar.' });
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const loginAttempts = new Map();
function loginRateLimit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const attempts = (loginAttempts.get(key) || []).filter((time) => now - time < 15 * 60 * 1000);
  if (attempts.length >= 10) return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos.' });
  attempts.push(now);
  loginAttempts.set(key, attempts);
  next();
}
