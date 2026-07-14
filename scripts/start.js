const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
loadEnv(path.join(projectRoot, '.env'));

const port = positiveInteger(process.env.PORT, 3000);
const origin = `http://localhost:${port}`;
const password = process.env.ADMIN_PASSWORD;
const sessionSecret = process.env.SESSION_SECRET;
const allowInsecureTunnel = process.env.ALLOW_INSECURE_TUNNEL === 'true';

if (!hasSecureConfiguration(password, sessionSecret) && !allowInsecureTunnel) {
  console.error([
    '',
    'TÚNEL NÃO INICIADO: configure credenciais seguras antes de publicar o VaultKeep.',
    'Copie .env.example para .env e altere ADMIN_PASSWORD e SESSION_SECRET.',
    'Para executar sem acesso externo, use: npm run local',
    '',
  ].join('\n'));
  process.exit(1);
}

if (allowInsecureTunnel) {
  console.warn('ATENÇÃO: túnel público iniciado em modo de teste com credenciais inseguras.');
}

const cloudflaredCheck = spawnSync('cloudflared', ['--version'], {
  windowsHide: true,
  encoding: 'utf8',
});
if (cloudflaredCheck.error || cloudflaredCheck.status !== 0) {
  console.error('Não foi possível executar cloudflared. Confirme se ele está instalado e disponível no PATH.');
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
  server = spawn(process.execPath, ['server.js'], {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  server.once('error', (error) => {
    console.error(`Não foi possível iniciar o servidor: ${error.message}`);
    shutdown(1);
  });
  server.once('exit', (code) => {
    if (!shuttingDown) {
      console.error(`O servidor encerrou inesperadamente com código ${code}.`);
      shutdown(code || 1);
    }
  });

  await waitForServer();
  console.log(`Servidor confirmado em ${origin}. Abrindo Cloudflare Tunnel...`);

  tunnel = spawn('cloudflared', ['tunnel', '--url', origin], {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  tunnel.once('error', (error) => {
    console.error(`Não foi possível iniciar o túnel: ${error.message}`);
    shutdown(1);
  });
  tunnel.once('exit', (code) => {
    if (!shuttingDown) {
      console.error(`O Cloudflare Tunnel encerrou inesperadamente com código ${code}.`);
      shutdown(code || 1);
    }
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null) throw new Error('o servidor encerrou antes de ficar disponível');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/session`);
      if (response.ok) return;
    } catch { /* Aguarda a próxima tentativa. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`a porta ${port} não respondeu dentro de 20 segundos`);
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (tunnel && tunnel.exitCode === null) tunnel.kill('SIGTERM');
  if (server && server.exitCode === null) server.kill('SIGTERM');
  setTimeout(() => process.exit(exitCode), 300);
}

process.once('SIGINT', () => shutdown(0));
process.once('SIGTERM', () => shutdown(0));

function hasSecureConfiguration(adminPassword, secret) {
  return Boolean(
    adminPassword
    && adminPassword !== 'admin'
    && adminPassword.length >= 10
    && secret
    && secret.length >= 32
    && !secret.startsWith('desenvolvimento-'),
  );
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

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
