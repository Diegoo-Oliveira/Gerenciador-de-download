const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
loadEnv(path.join(projectRoot, ".env"));

const port = positiveInteger(process.env.PORT, 3000);
const origin = `http://localhost:${port}`;
const username = process.env.ADMIN_USERNAME;
const passwordHash = process.env.ADMIN_PASSWORD_HASH;
const sessionSecret = process.env.SESSION_SECRET;
const cookieSecure = process.env.COOKIE_SECURE === "true";
const allowInsecureTunnel = process.env.ALLOW_INSECURE_TUNNEL === "true";

if (
  !hasSecureConfiguration(
    username,
    passwordHash,
    sessionSecret,
    cookieSecure,
  ) &&
  !allowInsecureTunnel
) {
  console.error(
    [
      "",
      "TÚNEL NÃO INICIADO: configure credenciais seguras antes de publicar o VaultKeep.",
      "Configure ADMIN_USERNAME, ADMIN_PASSWORD_HASH e SESSION_SECRET no .env.",
      "Gere o hash da senha com: npm run password:hash",
      "Para o túnel HTTPS, configure também COOKIE_SECURE=true.",
      "Para executar sem acesso externo, use: npm run local",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

if (allowInsecureTunnel) {
  console.warn(
    "ATENÇÃO: túnel público iniciado em modo de teste com credenciais inseguras.",
  );
}

const cloudflaredCheck = spawnSync("cloudflared", ["--version"], {
  windowsHide: true,
  encoding: "utf8",
});
if (cloudflaredCheck.error || cloudflaredCheck.status !== 0) {
  console.error(
    "Não foi possível executar cloudflared. Confirme se ele está instalado e disponível no PATH.",
  );
  process.exit(1);
}

let server;
let tunnel;
let shuttingDown = false;

start().catch((error) => {
  console.error(`Falha ao iniciar o VaultKeep: ${error.message}`);
  shutdown(1);
});

async function start() {
  server = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  server.once("error", (error) => {
    console.error(`Não foi possível iniciar o servidor: ${error.message}`);
    shutdown(1);
  });
  server.once("exit", (code) => {
    if (!shuttingDown) {
      console.error(`O servidor encerrou inesperadamente com código ${code}.`);
      shutdown(code || 1);
    }
  });

  await waitForServer();
  console.log(`Servidor confirmado em ${origin}. Abrindo Cloudflare Tunnel...`);

  tunnel = spawn("cloudflared", ["tunnel", "--url", origin], {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  tunnel.once("error", (error) => {
    console.error(`Não foi possível iniciar o túnel: ${error.message}`);
    shutdown(1);
  });
  tunnel.once("exit", (code) => {
    if (!shuttingDown) {
      console.error(
        `O Cloudflare Tunnel encerrou inesperadamente com código ${code}.`,
      );
      shutdown(code || 1);
    }
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null)
      throw new Error("o servidor encerrou antes de ficar disponível");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/session`);
      if (response.ok) return;
    } catch {
      /* Aguarda a próxima tentativa. */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`a porta ${port} não respondeu dentro de 20 segundos`);
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (tunnel && tunnel.exitCode === null) tunnel.kill("SIGTERM");
  if (server && server.exitCode === null) server.kill("SIGTERM");
  setTimeout(() => process.exit(exitCode), 300);
}

process.once("SIGINT", () => shutdown(0));
process.once("SIGTERM", () => shutdown(0));

function hasSecureConfiguration(
  adminUsername,
  adminPasswordHash,
  secret,
  secureCookie,
) {
  return Boolean(
    /^[a-zA-Z0-9._-]{3,64}$/.test(adminUsername || "") &&
      /^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$/.test(adminPasswordHash || "") &&
      secret &&
      secret.length >= 32 &&
      !secret.startsWith("desenvolvimento-") &&
      secureCookie,
  );
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
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
