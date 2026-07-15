const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const argon2 = require("argon2");
const ExcelJS = require("exceljs");
const mammoth = require("mammoth");
const sharp = require("sharp");
const {
  generateSecurePassword,
  generateSecurePin,
  isTrivialPin,
  passwordStrength,
} = require("../public/password-generator");

const projectRoot = path.resolve(__dirname, "..");
const storageDirectory = path.join(projectRoot, "test-storage-tmp");
const fixturePath = path.join(projectRoot, ".test-large.iso");
const port = 3187;
const baseUrl = `http://127.0.0.1:${port}`;
let server;

run()
  .then(() => cleanup())
  .catch((error) => {
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
  for (let index = 0; index < 250; index += 1) {
    const generatedPassword = generateSecurePassword({
      length: 32,
      prefix: "VK-",
      uppercase: true,
      lowercase: true,
      numbers: true,
      symbols: true,
    });
    const randomPart = generatedPassword.slice(3);
    assert.equal(generatedPassword.length, 32);
    assert.match(generatedPassword, /^VK-/);
    assert.match(randomPart, /[A-Z]/);
    assert.match(randomPart, /[a-z]/);
    assert.match(randomPart, /[0-9]/);
    assert.match(randomPart, /[^A-Za-z0-9]/);

    const pin = generateSecurePin(8);
    assert.match(pin, /^\d{8}$/);
    assert.equal(isTrivialPin(pin), false);
  }
  assert.throws(
    () =>
      generateSecurePassword({
        length: 8,
        prefix: "",
        uppercase: false,
        lowercase: false,
        numbers: false,
        symbols: false,
      }),
    /Selecione ao menos um grupo/,
  );
  assert.ok(
    passwordStrength({
      mode: "password",
      length: 24,
      prefix: "VK-",
      uppercase: true,
      lowercase: true,
      numbers: true,
      symbols: true,
    }).entropy > 100,
  );
  assert.equal(
    passwordStrength({
      mode: "password",
      length: 32,
      prefix: "",
      uppercase: false,
      lowercase: true,
      numbers: false,
      symbols: false,
    }).label,
    "Composição limitada",
  );

  fs.rmSync(storageDirectory, { recursive: true, force: true });
  const fixture = Buffer.alloc(3 * 1024 * 1024 + 321_123);
  for (let index = 0; index < fixture.length; index += 1)
    fixture[index] = (index * 31 + 7) % 256;
  fs.writeFileSync(fixturePath, fixture);

  const adminPassword = "integration-secret-2026";
  const adminPasswordHash = await argon2.hash(adminPassword, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });
  const secondHashForSamePassword = await argon2.hash(adminPassword, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });
  assert.notEqual(adminPasswordHash, secondHashForSamePassword);
  assert.equal(await argon2.verify(adminPasswordHash, adminPassword), true);

  server = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      STORAGE_DIR: storageDirectory,
      ADMIN_USERNAME: "integration-admin",
      ADMIN_PASSWORD_HASH: adminPasswordHash,
      SESSION_SECRET: "integration-session-secret-with-enough-entropy",
      COOKIE_SECURE: "true",
      LOGIN_MAX_ATTEMPTS_PER_IP: "5",
      LOGIN_MAX_ATTEMPTS_PER_ACCOUNT: "10",
      LOGIN_ATTEMPT_WINDOW_MINUTES: "15",
      UPLOAD_CHUNK_SIZE_MB: "1",
      UPLOAD_CONCURRENCY: "3",
      MAX_FILE_SIZE_GB: "2",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (data) => process.stderr.write(data));
  await waitForServer();

  const homeResponse = await fetch(baseUrl);
  assert.equal(homeResponse.status, 200);
  const homeHtml = await homeResponse.text();
  assert.match(homeHtml, /id="guestHome"/);
  assert.match(homeHtml, /id="username"/);
  assert.match(homeHtml, /public-header\.css\?v=4/);
  assert.match(homeHtml, /href="\/tools\/passwords"/);
  assert.doesNotMatch(homeHtml, /Arquivos privados permanecem invisíveis/i);
  assert.match(homeHtml, /public-site-header/);
  assert.match(
    homeResponse.headers.get("content-security-policy"),
    /default-src 'self'/,
  );
  assert.equal(homeResponse.headers.get("x-content-type-options"), "nosniff");
  assert.equal(homeResponse.headers.get("x-frame-options"), "SAMEORIGIN");

  const unknownLogin = await jsonRequest("/api/login", {
    method: "POST",
    body: JSON.stringify({
      username: "usuario-inexistente",
      password: "senha-incorreta",
    }),
  });
  assert.equal(unknownLogin.response.status, 401);
  assert.equal(unknownLogin.body.error, "Usuário ou senha inválidos.");

  const loginResponse = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "integration-admin",
      password: adminPassword,
    }),
  });
  assert.equal(loginResponse.status, 200);
  const loginBody = await loginResponse.json();
  assert.equal(loginBody.user.username, "integration-admin");
  assert.equal(Object.hasOwn(loginBody, "token"), false);
  const setCookie = loginResponse.headers.get("set-cookie");
  assert.match(setCookie, /^__Host-vaultkeep_session=/);
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  const cookie = setCookie.split(";")[0];
  const authHeaders = { Cookie: cookie };

  const usersCatalog = JSON.parse(
    fs.readFileSync(path.join(storageDirectory, "users.json"), "utf8"),
  );
  assert.equal(usersCatalog.users[0].username, "integration-admin");
  assert.match(usersCatalog.users[0].passwordHash, /^\$argon2id\$/);
  assert.equal(JSON.stringify(usersCatalog).includes(adminPassword), false);

  const tamperedCookie = `${cookie.slice(0, -1)}x`;
  const tamperedSession = await fetch(`${baseUrl}/api/files`, {
    headers: { Cookie: tamperedCookie },
  });
  assert.equal(tamperedSession.status, 401);

  const unauthorized = await fetch(`${baseUrl}/api/files`);
  assert.equal(unauthorized.status, 401);

  const details = {
    name: "arquivo-grande.iso",
    size: fixture.length,
    mimeType: "application/x-iso9660-image",
    lastModified: 1_725_000_000_000,
    fingerprint: sha256(fixture),
  };
  const created = await jsonRequest("/api/uploads", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(details),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.totalChunks, 4);

  await sendChunk(created.body, 0, fixture, authHeaders);
  const invalidHash = await sendChunk(
    created.body,
    1,
    fixture,
    authHeaders,
    "0".repeat(64),
    false,
  );
  assert.equal(invalidHash.status, 422);
  await sendChunk(created.body, 2, fixture, authHeaders);

  const resumed = await jsonRequest("/api/uploads", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(details),
  });
  assert.equal(resumed.response.status, 200);
  assert.equal(resumed.body.resumed, true);
  assert.deepEqual(resumed.body.uploadedChunks, [0, 2]);

  await Promise.all(
    [1, 3].map((index) => sendChunk(created.body, index, fixture, authHeaders)),
  );
  const completed = await jsonRequest(
    `/api/uploads/${created.body.id}/complete`,
    {
      method: "POST",
      headers: authHeaders,
      body: "{}",
    },
  );
  assert.equal(completed.response.status, 201);
  assert.equal(completed.body.file.sha256, sha256(fixture));
  assert.equal(completed.body.file.visibility, "private");

  const emptyPublicLibrary = await jsonRequest("/api/public-library");
  assert.equal(emptyPublicLibrary.response.status, 200);
  assert.equal(emptyPublicLibrary.body.files.length, 0);
  const privateIdor = await fetch(
    `${baseUrl}/api/public-library/files/${completed.body.file.id}/download`,
  );
  assert.equal(privateIdor.status, 404);

  const download = await fetch(
    `${baseUrl}/api/files/${completed.body.file.id}/download`,
    { headers: authHeaders },
  );
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("accept-ranges"), "bytes");
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), fixture);

  const rangeStart = 1024 * 1024;
  const rangeEnd = rangeStart + 65_535;
  const ranged = await fetch(
    `${baseUrl}/api/files/${completed.body.file.id}/download`,
    {
      headers: { ...authHeaders, Range: `bytes=${rangeStart}-${rangeEnd}` },
    },
  );
  assert.equal(ranged.status, 206);
  assert.equal(
    ranged.headers.get("content-range"),
    `bytes ${rangeStart}-${rangeEnd}/${fixture.length}`,
  );
  assert.deepEqual(
    Buffer.from(await ranged.arrayBuffer()),
    fixture.subarray(rangeStart, rangeEnd + 1),
  );

  const catalog = await jsonRequest("/api/files", { headers: authHeaders });
  assert.ok(
    catalog.body.files.some((file) => file.id === completed.body.file.id),
  );

  const folderCreated = await jsonRequest("/api/folders", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name: "Scripts", parentId: null }),
  });
  assert.equal(folderCreated.response.status, 201);
  const folderId = folderCreated.body.folder.id;

  const markdownFixture = Buffer.from(
    "# Manual do bunker\n\n```js\nconst online = true;\n```\n",
  );
  const markdownUpload = await jsonRequest("/api/uploads", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      name: "manual.md",
      size: markdownFixture.length,
      mimeType: "text/markdown",
      lastModified: 1_725_000_000_001,
      fingerprint: sha256(markdownFixture),
      folderId,
    }),
  });
  await sendChunk(markdownUpload.body, 0, markdownFixture, authHeaders);
  const markdownCompleted = await jsonRequest(
    `/api/uploads/${markdownUpload.body.id}/complete`,
    { method: "POST", headers: authHeaders, body: "{}" },
  );
  assert.equal(markdownCompleted.body.file.editable, true);
  const markdownContent = await jsonRequest(
    `/api/files/${markdownCompleted.body.file.id}/content`,
    { headers: authHeaders },
  );
  assert.equal(markdownContent.body.language, "markdown");
  const markdownDeleted = await fetch(
    `${baseUrl}/api/files/${markdownCompleted.body.file.id}`,
    { method: "DELETE", headers: authHeaders },
  );
  assert.equal(markdownDeleted.status, 204);

  const unknownText = Buffer.from("registro textual com extensão incomum\n");
  const unknownUpload = await uploadSmallFixture(
    "registro.vaultdata",
    unknownText,
    folderId,
    authHeaders,
  );
  assert.equal(unknownUpload.file.editable, true);
  const binaryDisguisedAsText = Buffer.from([0, 1, 2, 3, 0, 255, 128]);
  const binaryUpload = await uploadSmallFixture(
    "binario-disfarcado.txt",
    binaryDisguisedAsText,
    folderId,
    authHeaders,
  );
  assert.equal(binaryUpload.file.editable, false);
  for (const id of [unknownUpload.file.id, binaryUpload.file.id]) {
    const deleted = await fetch(`${baseUrl}/api/files/${id}`, {
      method: "DELETE",
      headers: authHeaders,
    });
    assert.equal(deleted.status, 204);
  }

  const textCreated = await jsonRequest("/api/text-files", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      name: "backup.ps1",
      folderId,
      content: "Get-ChildItem -Force\n",
    }),
  });
  assert.equal(textCreated.response.status, 201);
  assert.equal(textCreated.body.file.editable, true);
  const textId = textCreated.body.file.id;

  const privateContent = await fetch(`${baseUrl}/api/files/${textId}/content`);
  assert.equal(privateContent.status, 401);
  const openedText = await jsonRequest(`/api/files/${textId}/content`, {
    headers: authHeaders,
  });
  assert.equal(openedText.body.language, "powershell");
  assert.equal(openedText.body.content, "Get-ChildItem -Force\n");
  const detectedText = await jsonRequest("/api/text/detect", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      name: "arquivo.js",
      content: "function bunker() { return true; }",
    }),
  });
  assert.equal(detectedText.body.language, "javascript");

  const editedText = await jsonRequest(`/api/files/${textId}/content`, {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({
      content: "Get-Process | Sort-Object CPU\n",
      revision: openedText.body.revision,
    }),
  });
  assert.equal(editedText.response.status, 200);
  const staleEdit = await jsonRequest(`/api/files/${textId}/content`, {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({
      content: "stale",
      revision: openedText.body.revision,
    }),
  });
  assert.equal(staleEdit.response.status, 409);

  const nonEmptyDelete = await fetch(`${baseUrl}/api/folders/${folderId}`, {
    method: "DELETE",
    headers: authHeaders,
  });
  assert.equal(nonEmptyDelete.status, 409);
  const folderListing = await jsonRequest(`/api/files?folderId=${folderId}`, {
    headers: authHeaders,
  });
  assert.equal(folderListing.body.breadcrumbs.at(-1).name, "Scripts");
  assert.ok(folderListing.body.files.some((file) => file.id === textId));

  const filePublishedBehindPrivateFolder = await jsonRequest(
    `/api/files/${textId}`,
    {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ visibility: "public" }),
    },
  );
  assert.equal(filePublishedBehindPrivateFolder.body.file.visibility, "public");
  const stillHiddenLibrary = await jsonRequest("/api/public-library");
  assert.equal(stillHiddenLibrary.body.folders.length, 0);
  const blockedByPrivateParent = await fetch(
    `${baseUrl}/api/public-library/files/${textId}/download`,
  );
  assert.equal(blockedByPrivateParent.status, 404);
  const previewBlockedByPrivateParent = await fetch(
    `${baseUrl}/api/public-library/files/${textId}/content`,
  );
  assert.equal(previewBlockedByPrivateParent.status, 404);

  const folderPublished = await jsonRequest(`/api/folders/${folderId}`, {
    method: "PATCH",
    headers: authHeaders,
    body: JSON.stringify({ visibility: "public" }),
  });
  assert.equal(folderPublished.body.folder.visibility, "public");
  const privateNested = await jsonRequest("/api/text-files", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      name: "segredo.txt",
      folderId,
      visibility: "private",
      content: "não deve vazar\n",
    }),
  });
  const literalPublicHtml = await jsonRequest("/api/text-files", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      name: "literal.html",
      folderId,
      visibility: "public",
      content: '<script>window.naoExecutar = true</script>\n<p>somente texto</p>\n',
    }),
  });
  const rootPublicLibrary = await jsonRequest("/api/public-library");
  assert.ok(
    rootPublicLibrary.body.folders.some((folder) => folder.id === folderId),
  );
  const publicFolderLibrary = await jsonRequest(
    `/api/public-library?folderId=${folderId}`,
  );
  const listedPublicText = publicFolderLibrary.body.files.find(
    (file) => file.id === textId,
  );
  assert.ok(listedPublicText);
  assert.equal(listedPublicText.previewable, true);
  assert.equal(
    publicFolderLibrary.body.files.some(
      (file) => file.id === privateNested.body.file.id,
    ),
    false,
  );
  const literalPreview = await jsonRequest(
    `/api/public-library/files/${literalPublicHtml.body.file.id}/content`,
  );
  assert.equal(literalPreview.response.status, 200);
  assert.equal(
    literalPreview.body.content,
    '<script>window.naoExecutar = true</script>\n<p>somente texto</p>\n',
  );
  const nestedPrivateIdor = await fetch(
    `${baseUrl}/api/public-library/files/${privateNested.body.file.id}/download`,
  );
  assert.equal(nestedPrivateIdor.status, 404);
  const nestedPrivatePreview = await fetch(
    `${baseUrl}/api/public-library/files/${privateNested.body.file.id}/content`,
  );
  assert.equal(nestedPrivatePreview.status, 404);
  const privateNestedDeleted = await fetch(
    `${baseUrl}/api/files/${privateNested.body.file.id}`,
    { method: "DELETE", headers: authHeaders },
  );
  assert.equal(privateNestedDeleted.status, 204);
  const literalPublicDeleted = await fetch(
    `${baseUrl}/api/files/${literalPublicHtml.body.file.id}`,
    { method: "DELETE", headers: authHeaders },
  );
  assert.equal(literalPublicDeleted.status, 204);
  const libraryDownload = await fetch(
    `${baseUrl}/api/public-library/files/${textId}/download`,
  );
  assert.equal(libraryDownload.status, 200);
  assert.equal(await libraryDownload.text(), "Get-Process | Sort-Object CPU\n");
  const libraryPreview = await jsonRequest(
    `/api/public-library/files/${textId}/content`,
  );
  assert.equal(libraryPreview.response.status, 200);
  assert.equal(libraryPreview.body.content, "Get-Process | Sort-Object CPU\n");
  assert.equal(libraryPreview.body.language, "powershell");
  assert.match(libraryPreview.response.headers.get("cache-control"), /no-store/);

  const csrfAttempt = await fetch(`${baseUrl}/api/files/${textId}`, {
    method: "PATCH",
    headers: {
      ...authHeaders,
      Origin: "https://ataque.example",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ visibility: "private" }),
  });
  assert.equal(csrfAttempt.status, 403);

  const share = await jsonRequest(`/api/files/${textId}/share`, {
    method: "POST",
    headers: authHeaders,
    body: "{}",
  });
  assert.equal(share.response.status, 201);
  const publicToken = new URL(share.body.url).pathname.split("/").pop();
  const publicInfo = await jsonRequest(`/api/public/${publicToken}`);
  assert.equal(publicInfo.body.file.name, "backup.ps1");
  const publicPage = await fetch(`${baseUrl}/s/${publicToken}`);
  assert.equal(publicPage.status, 200);
  const publicDownload = await fetch(
    `${baseUrl}/api/public/${publicToken}/download`,
  );
  assert.equal(publicDownload.status, 200);
  assert.equal(await publicDownload.text(), "Get-Process | Sort-Object CPU\n");

  const moved = await jsonRequest(`/api/files/${textId}`, {
    method: "PATCH",
    headers: authHeaders,
    body: JSON.stringify({ folderId: null, name: "processos.ps1" }),
  });
  assert.equal(moved.body.file.folderId, null);
  assert.equal(moved.body.file.name, "processos.ps1");
  const rootPublished = await jsonRequest("/api/public-library");
  assert.ok(rootPublished.body.files.some((file) => file.id === textId));
  const folderDeleted = await fetch(`${baseUrl}/api/folders/${folderId}`, {
    method: "DELETE",
    headers: authHeaders,
  });
  assert.equal(folderDeleted.status, 204);

  const madePrivate = await jsonRequest(`/api/files/${textId}`, {
    method: "PATCH",
    headers: authHeaders,
    body: JSON.stringify({ visibility: "private" }),
  });
  assert.equal(madePrivate.body.file.visibility, "private");
  const revokedLibraryDownload = await fetch(
    `${baseUrl}/api/public-library/files/${textId}/download`,
  );
  assert.equal(revokedLibraryDownload.status, 404);
  const revokedLibraryPreview = await fetch(
    `${baseUrl}/api/public-library/files/${textId}/content`,
  );
  assert.equal(revokedLibraryPreview.status, 404);

  const revoked = await fetch(`${baseUrl}/api/files/${textId}/share`, {
    method: "DELETE",
    headers: authHeaders,
  });
  assert.equal(revoked.status, 204);
  const revokedInfo = await fetch(`${baseUrl}/api/public/${publicToken}`);
  assert.equal(revokedInfo.status, 404);

  const codeMirrorAsset = await fetch(
    `${baseUrl}/vendor/codemirror/lib/codemirror.js`,
  );
  assert.equal(codeMirrorAsset.status, 200);
  const editorPage = await fetch(`${baseUrl}/editor`);
  assert.equal(editorPage.status, 200);
  const editorHtml = await editorPage.text();
  assert.match(editorHtml, /id="editorWorkspace"|class="editor-workspace"/);
  assert.doesNotMatch(editorHtml, /show-hint|Ctrl \+ Espaço/);
  const editorScript = await fetch(`${baseUrl}/editor.js`);
  assert.equal(editorScript.status, 200);
  assert.doesNotMatch(await editorScript.text(), /showAutocomplete|LANGUAGE_COMPLETIONS/);
  assert.equal((await fetch(`${baseUrl}/editor.css`)).status, 200);
  const publicAppScript = await fetch(`${baseUrl}/app.js`);
  assert.equal(publicAppScript.status, 200);
  const publicAppSource = await publicAppScript.text();
  assert.match(publicAppSource, /publicPreviewContent\.textContent = data\.content/);
  assert.doesNotMatch(publicAppSource, /publicPreviewContent\.innerHTML/);

  const documentToolPage = await fetch(`${baseUrl}/tools/pdf`);
  assert.equal(documentToolPage.status, 200);
  const documentToolHtml = await documentToolPage.text();
  assert.match(documentToolHtml, /id="documentForm"/);
  assert.match(documentToolHtml, /\.docx/);
  assert.match(documentToolHtml, /id="toolSessionAction"/);
  assert.match(documentToolHtml, /public-header\.css\?v=4/);
  assert.match(documentToolHtml, /href="\/tools\/passwords"/);
  const imageToolPage = await fetch(`${baseUrl}/tools/images`);
  assert.equal(imageToolPage.status, 200);
  const imageToolHtml = await imageToolPage.text();
  assert.match(imageToolHtml, /id="imageForm"/);
  assert.match(imageToolHtml, /image\/svg\+xml/);
  assert.match(imageToolHtml, /id="toolSessionAction"/);
  assert.match(imageToolHtml, /href="\/tools\/passwords"/);
  const passwordToolPage = await fetch(`${baseUrl}/tools/passwords`);
  assert.equal(passwordToolPage.status, 200);
  const passwordToolHtml = await passwordToolPage.text();
  assert.match(passwordToolHtml, /id="passwordOutput"/);
  assert.match(passwordToolHtml, /id="passwordLength"[^>]+min="8"[^>]+max="32"/);
  assert.match(passwordToolHtml, /id="passwordLengthMinimum">8/);
  assert.match(passwordToolHtml, /id="passwordLengthMaximum">32/);
  assert.doesNotMatch(passwordToolHtml, /PROCESSAMENTO LOCAL/);
  assert.match(passwordToolHtml, /id="pinMode"/);
  assert.match(passwordToolHtml, /id="passwordPrefix"/);
  assert.match(passwordToolHtml, /id="toolSessionAction"/);
  assert.match(passwordToolHtml, /public-header\.css\?v=4/);
  const passwordToolScript = await fetch(`${baseUrl}/password-generator.js`);
  assert.equal(passwordToolScript.status, 200);
  const passwordToolSource = await passwordToolScript.text();
  assert.match(passwordToolSource, /cryptoSource\.getRandomValues/);
  assert.match(passwordToolSource, /passwordLengthMinimum\.textContent = pin \? "4" : "8"/);
  assert.match(passwordToolSource, /passwordLengthMaximum\.textContent = pin \? "16" : "32"/);
  assert.doesNotMatch(passwordToolSource, /\bfetch\s*\(/);
  assert.doesNotMatch(passwordToolSource, /localStorage|sessionStorage/);
  assert.equal((await fetch(`${baseUrl}/password-generator.css`)).status, 200);
  const sharedHeaderCss = await fetch(`${baseUrl}/public-header.css?v=4`);
  assert.equal(sharedHeaderCss.status, 200);
  const sharedHeaderSource = await sharedHeaderCss.text();
  assert.match(sharedHeaderSource, /\.public-site-header/);
  assert.match(sharedHeaderSource, /\.public-site-brand-mark/);
  const toolHeaderScript = await fetch(`${baseUrl}/tool-header.js`);
  assert.equal(toolHeaderScript.status, 200);
  const toolHeaderSource = await toolHeaderScript.text();
  assert.match(toolHeaderSource, /fetch\("\/api\/session"/);
  assert.match(toolHeaderSource, /label\.textContent = "Administrar"/);
  assert.match(toolHeaderSource, /action\.href = "\/admin"/);
  assert.match(toolHeaderSource, /activeTool\.scrollIntoView/);
  const converterCss = await fetch(`${baseUrl}/converter.css`);
  assert.equal(converterCss.status, 200);
  const converterCssSource = await converterCss.text();
  assert.match(converterCssSource, /\.tool-information\s*\{[^}]*repeat\(2,/s);
  assert.match(converterCssSource, /\.converter-layout\s*\{[^}]*minmax\(0, 1fr\)/s);

  const capabilities = await jsonRequest("/api/tools/documents/capabilities");
  assert.equal(capabilities.response.status, 200);
  assert.ok(capabilities.body.inputs.includes("pdf"));
  assert.ok(capabilities.body.inputs.includes("docx"));
  assert.ok(capabilities.body.inputs.includes("xlsx"));
  assert.ok(capabilities.body.outputs.includes("docx"));
  assert.ok(capabilities.body.outputs.includes("md"));
  const imageCapabilities = await jsonRequest("/api/tools/images/capabilities");
  assert.equal(imageCapabilities.response.status, 200);
  assert.ok(imageCapabilities.body.inputs.includes("svg"));
  assert.ok(imageCapabilities.body.outputs.includes("gif"));
  assert.ok(imageCapabilities.body.outputs.includes("svg"));

  const fakePdf = await convertToolFile(
    "/api/tools/documents/convert",
    Buffer.from("isto não é um pdf"),
    "falso.pdf",
    { target: "txt" },
    "application/pdf",
  );
  assert.equal(fakePdf.status, 415);

  const oversizedDocument = await convertToolFile(
    "/api/tools/documents/convert",
    Buffer.alloc(capabilities.body.maxBytes + 1, 65),
    "grande.txt",
    { target: "json" },
    "text/plain",
  );
  assert.equal(oversizedDocument.status, 413);

  const structuredJson = Buffer.from(
    JSON.stringify({
      clientes: [
        { id: 1, nome: "Ana", ativo: true },
        { id: 2, nome: "Bruno", ativo: false },
      ],
      origem: "integração",
    }),
  );
  const jsonToXlsx = await convertToolFile(
    "/api/tools/documents/convert",
    structuredJson,
    "dados.json",
    { target: "xlsx" },
    "application/json",
  );
  assert.equal(jsonToXlsx.status, 200);
  assert.match(jsonToXlsx.headers.get("content-type"), /spreadsheetml/);
  assert.match(jsonToXlsx.headers.get("cache-control"), /no-store/);
  const convertedWorkbook = new ExcelJS.Workbook();
  await convertedWorkbook.xlsx.load(Buffer.from(await jsonToXlsx.arrayBuffer()));
  assert.ok(convertedWorkbook.getWorksheet("clientes"));
  assert.equal(convertedWorkbook.getWorksheet("clientes").getCell("B2").value, "Ana");

  const jsonToPdf = await convertToolFile(
    "/api/tools/documents/convert",
    structuredJson,
    "dados.json",
    { target: "pdf" },
    "application/json",
  );
  assert.equal(jsonToPdf.status, 200);
  const generatedPdf = Buffer.from(await jsonToPdf.arrayBuffer());
  assert.equal(generatedPdf.subarray(0, 5).toString(), "%PDF-");

  const pdfToText = await convertToolFile(
    "/api/tools/documents/convert",
    generatedPdf,
    "dados.pdf",
    { target: "txt" },
    "application/pdf",
  );
  assert.equal(
    pdfToText.status,
    200,
    pdfToText.status === 200 ? undefined : await pdfToText.text(),
  );
  assert.match(await pdfToText.text(), /Ana/);

  const pdfToDocx = await convertToolFile(
    "/api/tools/documents/convert",
    generatedPdf,
    "dados.pdf",
    { target: "docx" },
    "application/pdf",
  );
  assert.equal(
    pdfToDocx.status,
    200,
    pdfToDocx.status === 200 ? undefined : await pdfToDocx.text(),
  );
  assert.match(pdfToDocx.headers.get("content-type"), /wordprocessingml/);
  const generatedDocx = Buffer.from(await pdfToDocx.arrayBuffer());
  assert.equal(generatedDocx.subarray(0, 4).toString("hex"), "504b0304");
  const docxText = await mammoth.extractRawText({ buffer: generatedDocx });
  assert.match(docxText.value, /Ana/);

  const docxToMarkdown = await convertToolFile(
    "/api/tools/documents/convert",
    generatedDocx,
    "dados.docx",
    { target: "md" },
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  assert.equal(docxToMarkdown.status, 200);
  assert.match(await docxToMarkdown.text(), /Ana/);

  const yamlToXml = await convertToolFile(
    "/api/tools/documents/convert",
    Buffer.from("clientes:\n  - nome: Ana\n    ativo: true\n", "utf8"),
    "dados.yaml",
    { target: "xml" },
    "application/yaml",
  );
  assert.equal(yamlToXml.status, 200);
  assert.match(await yamlToXml.text(), /<\?xml|<vaultkeep/);

  const unsafeXml = await convertToolFile(
    "/api/tools/documents/convert",
    Buffer.from('<!DOCTYPE x [<!ENTITY a "segredo">]><x>&a;</x>', "utf8"),
    "inseguro.xml",
    { target: "json" },
    "application/xml",
  );
  assert.equal(unsafeXml.status, 422);

  const sourceImage = await sharp({
    create: { width: 80, height: 80, channels: 3, background: "#ffffff" },
  })
    .composite([
      {
        input: {
          create: { width: 30, height: 30, channels: 3, background: "#14527f" },
        },
        left: 25,
        top: 25,
      },
    ])
    .png()
    .toBuffer();
  const imageToWebp = await convertToolFile(
    "/api/tools/images/convert",
    sourceImage,
    "amostra.png",
    { format: "webp", quality: "80", removeBackground: "false" },
    "image/png",
  );
  assert.equal(imageToWebp.status, 200);
  assert.equal((await sharp(Buffer.from(await imageToWebp.arrayBuffer())).metadata()).format, "webp");

  const imageToGif = await convertToolFile(
    "/api/tools/images/convert",
    sourceImage,
    "amostra.png",
    { format: "gif", quality: "80", removeBackground: "false" },
    "image/png",
  );
  assert.equal(imageToGif.status, 200);
  assert.equal(
    (await sharp(Buffer.from(await imageToGif.arrayBuffer())).metadata()).format,
    "gif",
  );

  const imageToSvg = await convertToolFile(
    "/api/tools/images/convert",
    sourceImage,
    "amostra.png",
    { format: "svg", quality: "90", removeBackground: "false" },
    "image/png",
  );
  assert.equal(imageToSvg.status, 200);
  const generatedImageSvg = Buffer.from(await imageToSvg.arrayBuffer());
  assert.match(generatedImageSvg.toString("utf8"), /<svg[^>]+>[\s\S]*data:image\/png;base64,/);
  assert.equal((await sharp(generatedImageSvg).metadata()).format, "svg");

  const safeSourceSvg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#f2c94c"/><circle cx="40" cy="40" r="20" fill="#082842"/></svg>',
    "utf8",
  );
  const svgToPng = await convertToolFile(
    "/api/tools/images/convert",
    safeSourceSvg,
    "seguro.svg",
    { format: "png", quality: "90", removeBackground: "false" },
    "image/svg+xml",
  );
  assert.equal(svgToPng.status, 200);
  assert.equal((await sharp(Buffer.from(await svgToPng.arrayBuffer())).metadata()).format, "png");

  const unsafeSvg = await convertToolFile(
    "/api/tools/images/convert",
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><script>alert(1)</script></svg>',
      "utf8",
    ),
    "inseguro.svg",
    { format: "png", removeBackground: "false" },
    "image/svg+xml",
  );
  assert.equal(unsafeSvg.status, 422);

  const withoutBackground = await convertToolFile(
    "/api/tools/images/convert",
    sourceImage,
    "amostra.png",
    { format: "png", quality: "90", removeBackground: "true", tolerance: "40" },
    "image/png",
  );
  assert.equal(withoutBackground.status, 200);
  const transparent = await sharp(Buffer.from(await withoutBackground.arrayBuffer()))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(transparent.data[3], 0);
  const centerAlpha = transparent.data[(40 * transparent.info.width + 40) * 4 + 3];
  assert.equal(centerAlpha, 255);

  const disguisedSvg = await convertToolFile(
    "/api/tools/images/convert",
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'),
    "falsa.png",
    { format: "webp", removeBackground: "false" },
    "image/png",
  );
  assert.equal(disguisedSvg.status, 415);

  const rejectedCrossSiteTool = await fetch(
    `${baseUrl}/api/tools/documents/convert`,
    { method: "POST", headers: { Origin: "https://origem-maliciosa.example" } },
  );
  assert.equal(rejectedCrossSiteTool.status, 403);

  const traversalAttempt = await fetch(
    `${baseUrl}/api/files?folderId=..%2F..%2Fsegredos`,
    { headers: authHeaders },
  );
  assert.equal(traversalAttempt.status, 400);
  const configurationProbe = await fetch(`${baseUrl}/api/config`);
  assert.equal(configurationProbe.status, 404);

  const malformedLogin = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(malformedLogin.status, 400);
  assert.equal(
    (await malformedLogin.json()).error,
    "Requisição inválida.",
  );

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const failed = await jsonRequest("/api/login", {
      method: "POST",
      body: JSON.stringify({
        username: "integration-admin",
        password: `incorreta-${attempt}`,
      }),
    });
    assert.equal(failed.response.status, 401);
  }
  const rateLimited = await jsonRequest("/api/login", {
    method: "POST",
    body: JSON.stringify({
      username: "integration-admin",
      password: "ainda-incorreta",
    }),
  });
  assert.equal(rateLimited.response.status, 429);
  assert.ok(Number(rateLimited.response.headers.get("retry-after")) > 0);
  assert.equal(rateLimited.response.headers.get("ratelimit-remaining"), "0");

  for (let attempt = 5; attempt < 10; attempt += 1) {
    const distributedFailure = await jsonRequest("/api/login", {
      method: "POST",
      headers: { "X-Forwarded-For": `203.0.113.${attempt}` },
      body: JSON.stringify({
        username: "integration-admin",
        password: `distribuida-incorreta-${attempt}`,
      }),
    });
    assert.equal(distributedFailure.response.status, 401);
  }
  const distributedRateLimited = await jsonRequest("/api/login", {
    method: "POST",
    headers: { "X-Forwarded-For": "203.0.113.200" },
    body: JSON.stringify({
      username: "integration-admin",
      password: "distribuida-ainda-incorreta",
    }),
  });
  assert.equal(distributedRateLimited.response.status, 429);
  assert.ok(
    Number(distributedRateLimited.response.headers.get("retry-after")) > 0,
  );

  const logout = await fetch(`${baseUrl}/api/logout`, {
    method: "POST",
    headers: authHeaders,
  });
  assert.equal(logout.status, 204);
  const sessionAfterLogout = await jsonRequest("/api/session", {
    headers: authHeaders,
  });
  assert.equal(sessionAfterLogout.body.authenticated, false);
  console.log(
    "OK: autenticação, CSRF, permissões, chunks, Range, editor, conversores, gerador seguro e compartilhamento.",
  );
}

async function convertToolFile(route, buffer, filename, fields, mimeType) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType }), filename);
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  return fetch(`${baseUrl}${route}`, { method: "POST", body: form });
}

async function sendChunk(
  session,
  index,
  fixture,
  authHeaders,
  forcedHash,
  expectSuccess = true,
) {
  const start = index * session.chunkSize;
  const chunk = fixture.subarray(
    start,
    Math.min(start + session.chunkSize, fixture.length),
  );
  const response = await fetch(
    `${baseUrl}/api/uploads/${session.id}/chunks/${index}`,
    {
      method: "PUT",
      headers: {
        ...authHeaders,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(chunk.length),
        "X-Chunk-SHA256": forcedHash || sha256(chunk),
      },
      body: chunk,
    },
  );
  if (expectSuccess)
    assert.ok([200, 201].includes(response.status), await response.text());
  return response;
}

async function uploadSmallFixture(name, fixture, folderId, authHeaders) {
  const upload = await jsonRequest("/api/uploads", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      name,
      size: fixture.length,
      mimeType: "application/octet-stream",
      lastModified: Date.now(),
      fingerprint: sha256(fixture),
      folderId,
    }),
  });
  await sendChunk(upload.body, 0, fixture, authHeaders);
  const completed = await jsonRequest(
    `/api/uploads/${upload.body.id}/complete`,
    {
      method: "POST",
      headers: authHeaders,
      body: "{}",
    },
  );
  assert.equal(completed.response.status, 201);
  return completed.body;
}

async function jsonRequest(route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const body = await response.json();
  return { response, body };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (server.exitCode !== null)
      throw new Error(`O servidor encerrou com código ${server.exitCode}.`);
    try {
      const response = await fetch(`${baseUrl}/api/session`);
      if (response.ok) return;
    } catch {
      /* Aguarda a próxima tentativa. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("O servidor de teste não iniciou a tempo.");
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}
