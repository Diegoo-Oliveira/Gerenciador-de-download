const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const argon2 = require("argon2");

const ARGON2_OPTIONS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
});
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

class AuthService {
  constructor(options) {
    this.usersFile = options.usersFile;
    this.sessionSecret = options.sessionSecret;
    this.sessionDurationMs = options.sessionDurationMs;
    this.bootstrapUsername = normalizeUsername(options.bootstrapUsername);
    this.bootstrapPasswordHash = String(options.bootstrapPasswordHash || "");
    this.sessions = new Map();
    this.maxSessionsPerUser = options.maxSessionsPerUser || 8;
    fs.mkdirSync(path.dirname(this.usersFile), { recursive: true });
  }

  async initialize() {
    if (!isArgon2idHash(this.bootstrapPasswordHash)) {
      throw new Error(
        "ADMIN_PASSWORD_HASH precisa conter um hash Argon2id válido. Execute npm run password:hash.",
      );
    }
    if (argon2.needsRehash(this.bootstrapPasswordHash, ARGON2_OPTIONS)) {
      throw new Error(
        "ADMIN_PASSWORD_HASH usa parâmetros abaixo do padrão atual. Gere um novo hash com npm run password:hash.",
      );
    }
    const catalog = this.readUsers();
    let admin = catalog.users.find(
      (user) => normalizeUsername(user.username) === this.bootstrapUsername,
    );
    if (!admin) {
      admin = {
        id: crypto.randomUUID(),
        username: this.bootstrapUsername,
        passwordHash: this.bootstrapPasswordHash,
        role: "admin",
        active: true,
        createdAt: new Date().toISOString(),
      };
      catalog.users.push(admin);
      this.writeUsers(catalog);
    } else if (
      admin.passwordHash !== this.bootstrapPasswordHash ||
      admin.role !== "admin" ||
      admin.active !== true
    ) {
      admin.passwordHash = this.bootstrapPasswordHash;
      admin.role = "admin";
      admin.active = true;
      admin.updatedAt = new Date().toISOString();
      this.writeUsers(catalog);
    }
    this.dummyHash = await argon2.hash(crypto.randomBytes(32), ARGON2_OPTIONS);
  }

  async verifyCredentials(usernameValue, passwordValue) {
    const rawUsername = String(usernameValue || "");
    const password = String(passwordValue || "");
    const inputIsValid =
      rawUsername.length <= 64 &&
      password.length > 0 &&
      password.length <= 1024;
    const username = inputIsValid
      ? normalizeUsername(rawUsername, false)
      : null;
    const user = username
      ? this.readUsers().users.find(
          (candidate) =>
            candidate.active === true &&
            normalizeUsername(candidate.username) === username,
        )
      : null;
    const hash = user?.passwordHash || this.dummyHash;
    let matches = false;
    try {
      matches = await argon2.verify(
        hash,
        inputIsValid ? password : "entrada-invalida",
        { type: argon2.argon2id },
      );
    } catch {
      matches = false;
    }
    return matches && user ? publicUser(user) : null;
  }

  createSession(user) {
    this.cleanupExpired();
    const token = crypto.randomBytes(32).toString("base64url");
    const digest = this.tokenDigest(token);
    const now = Date.now();
    this.sessions.set(digest, {
      userId: user.id,
      createdAt: now,
      expiresAt: now + this.sessionDurationMs,
    });
    this.trimUserSessions(user.id);
    return token;
  }

  authenticate(token) {
    if (!SESSION_TOKEN_PATTERN.test(String(token || ""))) return null;
    const digest = this.tokenDigest(token);
    const session = this.sessions.get(digest);
    if (!session || session.expiresAt <= Date.now()) {
      if (session) this.sessions.delete(digest);
      return null;
    }
    const user = this.readUsers().users.find(
      (candidate) =>
        candidate.id === session.userId && candidate.active === true,
    );
    if (!user) {
      this.sessions.delete(digest);
      return null;
    }
    return publicUser(user);
  }

  revoke(token) {
    if (!SESSION_TOKEN_PATTERN.test(String(token || ""))) return;
    this.sessions.delete(this.tokenDigest(token));
  }

  cleanupExpired() {
    const now = Date.now();
    for (const [digest, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(digest);
    }
  }

  tokenDigest(token) {
    return crypto
      .createHmac("sha256", this.sessionSecret)
      .update(String(token))
      .digest("hex");
  }

  trimUserSessions(userId) {
    const sessions = [...this.sessions.entries()]
      .filter(([, session]) => session.userId === userId)
      .sort((left, right) => right[1].createdAt - left[1].createdAt);
    sessions
      .slice(this.maxSessionsPerUser)
      .forEach(([digest]) => this.sessions.delete(digest));
  }

  readUsers() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.usersFile, "utf8"));
      return {
        version: 1,
        users: Array.isArray(parsed.users) ? parsed.users : [],
      };
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, users: [] };
      throw error;
    }
  }

  writeUsers(catalog) {
    const temporary = `${this.usersFile}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(
      temporary,
      JSON.stringify({ version: 1, users: catalog.users }, null, 2),
      { mode: 0o600 },
    );
    fs.renameSync(temporary, this.usersFile);
    if (process.platform !== "win32") fs.chmodSync(this.usersFile, 0o600);
  }
}

async function hashPassword(password) {
  const value = String(password || "");
  if (value.length < 12) {
    throw new Error("A senha precisa ter pelo menos 12 caracteres.");
  }
  return argon2.hash(value, ARGON2_OPTIONS);
}

function normalizeUsername(value, strict = true) {
  const username = String(value || "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("pt-BR");
  if (!/^[a-z0-9._-]{3,64}$/.test(username)) {
    if (!strict) return null;
    throw new Error(
      "ADMIN_USERNAME deve ter de 3 a 64 caracteres: letras, números, ponto, traço ou sublinhado.",
    );
  }
  return username;
}

function isArgon2idHash(value) {
  return /^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$/.test(String(value));
}

function publicUser(user) {
  return { id: user.id, username: user.username, role: user.role };
}

module.exports = { AuthService, hashPassword };
