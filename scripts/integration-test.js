const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const storageDirectory = path.join(projectRoot, 'test-storage-tmp');
const fixturePath = path.join(projectRoot, '.test-large.iso');
const port = 3187;
const baseUrl = `http://127.0.0.1:${port}`;
let server;

run().then(() => cleanup()).catch((error) => {
  console.error(error);
  cleanup();
  process.exit(1);
});

function cleanup() {
  if (server) server.kill();
  fs.rmSync(storageDirectory, { recursive: true, force: true });
  fs.rmSync(fixturePath, { force: true });
}

async function run() {
  fs.rmSync(storageDirectory, { recursive: true, force: true });
  const fixture = Buffer.alloc((3 * 1024 * 1024) + 321_123);
  for (let index = 0; index < fixture.length; index += 1) fixture[index] = (index * 31 + 7) % 256;
  fs.writeFileSync(fixturePath, fixture);

  server = spawn(process.execPath, ['server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      STORAGE_DIR: storageDirectory,
      ADMIN_PASSWORD: 'integration-secret',
      SESSION_SECRET: 'integration-session-secret-with-enough-entropy',
      UPLOAD_CHUNK_SIZE_MB: '1',
      UPLOAD_CONCURRENCY: '3',
      MAX_FILE_SIZE_GB: '2',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (data) => process.stderr.write(data));
  await waitForServer();

  const loginResponse = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'integration-secret' }),
  });
  assert.equal(loginResponse.status, 200);
  const cookie = loginResponse.headers.get('set-cookie').split(';')[0];
  const authHeaders = { Cookie: cookie };

  const unauthorized = await fetch(`${baseUrl}/api/files`);
  assert.equal(unauthorized.status, 401);

  const details = {
    name: 'arquivo-grande.iso',
    size: fixture.length,
    mimeType: 'application/x-iso9660-image',
    lastModified: 1_725_000_000_000,
    fingerprint: sha256(fixture),
  };
  const created = await jsonRequest('/api/uploads', {
    method: 'POST', headers: authHeaders, body: JSON.stringify(details),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.totalChunks, 4);

  await sendChunk(created.body, 0, fixture, authHeaders);
  const invalidHash = await sendChunk(created.body, 1, fixture, authHeaders, '0'.repeat(64), false);
  assert.equal(invalidHash.status, 422);
  await sendChunk(created.body, 2, fixture, authHeaders);

  const resumed = await jsonRequest('/api/uploads', {
    method: 'POST', headers: authHeaders, body: JSON.stringify(details),
  });
  assert.equal(resumed.response.status, 200);
  assert.equal(resumed.body.resumed, true);
  assert.deepEqual(resumed.body.uploadedChunks, [0, 2]);

  await Promise.all([1, 3].map((index) => sendChunk(created.body, index, fixture, authHeaders)));
  const completed = await jsonRequest(`/api/uploads/${created.body.id}/complete`, {
    method: 'POST', headers: authHeaders, body: '{}',
  });
  assert.equal(completed.response.status, 201);
  assert.equal(completed.body.file.sha256, sha256(fixture));

  const download = await fetch(`${baseUrl}/api/files/${completed.body.file.id}/download`, { headers: authHeaders });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), fixture);

  const rangeStart = 1024 * 1024;
  const rangeEnd = rangeStart + 65_535;
  const ranged = await fetch(`${baseUrl}/api/files/${completed.body.file.id}/download`, {
    headers: { ...authHeaders, Range: `bytes=${rangeStart}-${rangeEnd}` },
  });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes ${rangeStart}-${rangeEnd}/${fixture.length}`);
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), fixture.subarray(rangeStart, rangeEnd + 1));

  const catalog = await jsonRequest('/api/files', { headers: authHeaders });
  assert.ok(catalog.body.files.some((file) => file.id === completed.body.file.id));
  console.log('OK: autenticação, chunks, hash, retomada, paralelismo, montagem e HTTP Range.');
}

async function sendChunk(session, index, fixture, authHeaders, forcedHash, expectSuccess = true) {
  const start = index * session.chunkSize;
  const chunk = fixture.subarray(start, Math.min(start + session.chunkSize, fixture.length));
  const response = await fetch(`${baseUrl}/api/uploads/${session.id}/chunks/${index}`, {
    method: 'PUT',
    headers: {
      ...authHeaders,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(chunk.length),
      'X-Chunk-SHA256': forcedHash || sha256(chunk),
    },
    body: chunk,
  });
  if (expectSuccess) assert.ok([200, 201].includes(response.status), await response.text());
  return response;
}

async function jsonRequest(route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const body = await response.json();
  return { response, body };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`O servidor encerrou com código ${server.exitCode}.`);
    try {
      const response = await fetch(`${baseUrl}/api/session`);
      if (response.ok) return;
    } catch { /* Aguarda a próxima tentativa. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('O servidor de teste não iniciou a tempo.');
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}
