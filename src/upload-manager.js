const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const fsp = fs.promises;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class UploadError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "UploadError";
    this.status = status;
  }
}

class UploadManager {
  constructor(options) {
    this.chunkRoot = options.chunkRoot;
    this.uploadRoot = options.uploadRoot;
    this.chunkSize = options.chunkSize;
    this.maxFileSize = options.maxFileSize;
    this.sessionTtlMs = options.sessionTtlMs;
    fs.mkdirSync(this.chunkRoot, { recursive: true });
    fs.mkdirSync(this.uploadRoot, { recursive: true });
  }

  async initialize(input) {
    const name = cleanFilename(input.name);
    const size = Number(input.size);
    const lastModified = Number(input.lastModified) || 0;
    const mimeType = String(input.mimeType || "application/octet-stream").slice(
      0,
      150,
    );
    const clientFingerprint = String(input.fingerprint || "").toLowerCase();
    const folderId = input.folderId || null;
    const visibility = input.visibility === "public" ? "public" : "private";
    const extension = path.extname(name).toLowerCase();

    if (!name || name.length > 255)
      throw new UploadError("Nome de arquivo inválido.");
    if (!Number.isSafeInteger(size) || size <= 0)
      throw new UploadError("Tamanho de arquivo inválido.");
    if (!/^[a-f0-9]{64}$/.test(clientFingerprint))
      throw new UploadError("Identificação do arquivo inválida.");
    if (size > this.maxFileSize) {
      throw new UploadError(
        `O arquivo excede o limite de ${formatGigabytes(this.maxFileSize)}.`,
        413,
      );
    }

    const fingerprint = crypto
      .createHash("sha256")
      .update(
        `${name}\0${size}\0${lastModified}\0${clientFingerprint}\0${folderId || "root"}\0${visibility}`,
      )
      .digest("hex");
    const existing = await this.findActiveSession(fingerprint);
    if (existing) return { ...(await this.status(existing.id)), resumed: true };

    const id = crypto.randomUUID();
    const sessionDirectory = this.sessionPath(id);
    const session = {
      id,
      fileId: crypto.randomUUID(),
      fingerprint,
      name,
      storedName: `${crypto.randomUUID()}${extension}`,
      size,
      mimeType,
      folderId,
      visibility,
      lastModified,
      chunkSize: this.chunkSize,
      totalChunks: Math.ceil(size / this.chunkSize),
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await fsp.mkdir(sessionDirectory, { recursive: false });
    await this.writeSession(session);
    return {
      ...this.publicSession(session),
      uploadedChunks: [],
      resumed: false,
    };
  }

  async status(id) {
    const session = await this.readSession(id);
    const uploadedChunks =
      session.status === "active"
        ? await this.listValidChunks(session)
        : Array.from({ length: session.totalChunks }, (_, index) => index);
    return { ...this.publicSession(session), uploadedChunks };
  }

  async receiveChunk(id, indexValue, request) {
    const session = await this.readSession(id);
    if (session.status !== "active")
      throw new UploadError("Este upload já foi finalizado.", 409);

    const index = Number(indexValue);
    if (!Number.isInteger(index) || index < 0 || index >= session.totalChunks) {
      throw new UploadError("Índice de bloco inválido.");
    }
    const expectedSize = this.expectedChunkSize(session, index);
    const declaredSize = Number(request.headers["content-length"]);
    if (!Number.isSafeInteger(declaredSize) || declaredSize !== expectedSize) {
      throw new UploadError(
        `O bloco ${index} deveria ter ${expectedSize} bytes.`,
      );
    }
    const expectedHash = String(
      request.headers["x-chunk-sha256"] || "",
    ).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
      throw new UploadError("O hash SHA-256 do bloco é obrigatório.");
    }

    const finalPath = path.join(this.sessionPath(id), `${index}.part`);
    if (await fileHasSize(finalPath, expectedSize)) {
      request.resume();
      return { index, received: expectedSize, alreadyUploaded: true };
    }

    const lockPath = path.join(this.sessionPath(id), `${index}.lock`);
    let lock;
    try {
      lock = await fsp.open(lockPath, "wx");
    } catch (error) {
      if (error.code === "EEXIST")
        throw new UploadError("Este bloco já está sendo recebido.", 409);
      throw error;
    }

    const temporaryPath = path.join(
      this.sessionPath(id),
      `${index}.${crypto.randomUUID()}.tmp`,
    );
    let fileHandle;
    try {
      fileHandle = await fsp.open(temporaryPath, "wx");
      const hash = crypto.createHash("sha256");
      let received = 0;

      for await (const chunk of request) {
        received += chunk.length;
        if (received > expectedSize)
          throw new UploadError("O bloco recebido é maior que o esperado.");
        hash.update(chunk);
        await writeAll(fileHandle, chunk);
      }
      await fileHandle.sync();
      await fileHandle.close();
      fileHandle = null;

      if (received !== expectedSize)
        throw new UploadError("O bloco chegou incompleto.", 422);
      if (!safeEqual(hash.digest("hex"), expectedHash)) {
        throw new UploadError(
          "Falha de integridade no bloco. Tente enviá-lo novamente.",
          422,
        );
      }

      await removeIfExists(finalPath);
      await fsp.rename(temporaryPath, finalPath);
      return { index, received, alreadyUploaded: false };
    } finally {
      if (fileHandle) await fileHandle.close().catch(() => {});
      await removeIfExists(temporaryPath);
      if (lock) await lock.close().catch(() => {});
      await removeIfExists(lockPath);
    }
  }

  async finalize(id, registerFile) {
    let session = await this.readSession(id);
    if (session.status === "completed") return session.file;

    const lockPath = path.join(this.sessionPath(id), "finalizing.lock");
    let lock;
    try {
      lock = await fsp.open(lockPath, "wx");
    } catch (error) {
      if (error.code === "EEXIST")
        throw new UploadError("O arquivo já está sendo finalizado.", 409);
      throw error;
    }

    const finalPath = path.join(this.uploadRoot, session.storedName);
    const temporaryPath = `${finalPath}.${crypto.randomUUID()}.assembling`;
    try {
      const uploadedChunks = await this.listValidChunks(session);
      if (uploadedChunks.length !== session.totalChunks) {
        const missing = session.totalChunks - uploadedChunks.length;
        throw new UploadError(
          `Ainda faltam ${missing} bloco${missing === 1 ? "" : "s"}.`,
          409,
        );
      }

      let sha256;
      if (await fileHasSize(finalPath, session.size)) {
        sha256 = await hashFile(finalPath);
      } else {
        sha256 = await this.assemble(session, temporaryPath);
        await fsp.rename(temporaryPath, finalPath);
      }

      const file = {
        id: session.fileId,
        name: session.name,
        storedName: session.storedName,
        size: session.size,
        mimeType: session.mimeType,
        folderId: session.folderId || null,
        visibility: session.visibility === "public" ? "public" : "private",
        sha256,
        createdAt: new Date().toISOString(),
      };
      await registerFile(file);

      session = {
        ...session,
        status: "completed",
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        file,
      };
      await this.writeSession(session);
      await this.removePartFiles(session);
      return file;
    } finally {
      await removeIfExists(temporaryPath);
      if (lock) await lock.close().catch(() => {});
      await removeIfExists(lockPath);
    }
  }

  async cancel(id) {
    await this.readSession(id);
    const target = this.sessionPath(id);
    await fsp.rm(target, { recursive: true, force: true });
  }

  async cleanupExpired() {
    const entries = await fsp
      .readdir(this.chunkRoot, { withFileTypes: true })
      .catch(() => []);
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
      try {
        const session = await this.readSession(entry.name);
        const directoryStat = await fsp.stat(this.sessionPath(entry.name));
        const reference = Math.max(
          new Date(session.updatedAt || session.createdAt).getTime(),
          directoryStat.mtimeMs,
        );
        if (now - reference > this.sessionTtlMs) await this.cancel(entry.name);
      } catch {
        /* Uma pasta inválida não deve interromper a limpeza das demais. */
      }
    }
  }

  async findActiveSession(fingerprint) {
    const entries = await fsp
      .readdir(this.chunkRoot, { withFileTypes: true })
      .catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
      try {
        const session = await this.readSession(entry.name);
        if (session.status === "active" && session.fingerprint === fingerprint)
          return session;
      } catch {
        /* Ignora sessões danificadas. */
      }
    }
    return null;
  }

  async listValidChunks(session) {
    const entries = await fsp.readdir(this.sessionPath(session.id), {
      withFileTypes: true,
    });
    const valid = [];
    for (const entry of entries) {
      const match = /^(\d+)\.part$/.exec(entry.name);
      if (!entry.isFile() || !match) continue;
      const index = Number(match[1]);
      if (
        index >= 0 &&
        index < session.totalChunks &&
        (await fileHasSize(
          path.join(this.sessionPath(session.id), entry.name),
          this.expectedChunkSize(session, index),
        ))
      ) {
        valid.push(index);
      }
    }
    return valid.sort((left, right) => left - right);
  }

  async assemble(session, target) {
    const targetHandle = await fsp.open(target, "wx");
    const hash = crypto.createHash("sha256");
    let total = 0;
    try {
      for (let index = 0; index < session.totalChunks; index += 1) {
        const partPath = path.join(
          this.sessionPath(session.id),
          `${index}.part`,
        );
        const input = fs.createReadStream(partPath, {
          highWaterMark: 1024 * 1024,
        });
        for await (const chunk of input) {
          hash.update(chunk);
          await writeAll(targetHandle, chunk);
          total += chunk.length;
        }
      }
      await targetHandle.sync();
    } finally {
      await targetHandle.close();
    }
    if (total !== session.size) {
      await removeIfExists(target);
      throw new UploadError(
        "O arquivo montado não corresponde ao tamanho original.",
        422,
      );
    }
    return hash.digest("hex");
  }

  async removePartFiles(session) {
    const directory = this.sessionPath(session.id);
    const entries = await fsp
      .readdir(directory, { withFileTypes: true })
      .catch(() => []);
    await Promise.all(
      entries
        .filter(
          (entry) => entry.isFile() && /\.(part|tmp|lock)$/.test(entry.name),
        )
        .map((entry) => removeIfExists(path.join(directory, entry.name))),
    );
  }

  expectedChunkSize(session, index) {
    return Math.min(
      session.chunkSize,
      session.size - index * session.chunkSize,
    );
  }

  sessionPath(id) {
    if (!UUID_PATTERN.test(String(id)))
      throw new UploadError("Sessão de upload inválida.");
    return path.join(this.chunkRoot, id);
  }

  async readSession(id) {
    try {
      return JSON.parse(
        await fsp.readFile(
          path.join(this.sessionPath(id), "session.json"),
          "utf8",
        ),
      );
    } catch (error) {
      if (error.code === "ENOENT")
        throw new UploadError("Sessão de upload não encontrada.", 404);
      throw error;
    }
  }

  async writeSession(session) {
    const filename = path.join(this.sessionPath(session.id), "session.json");
    const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
    await fsp.writeFile(temporary, JSON.stringify(session, null, 2));
    await removeIfExists(filename);
    await fsp.rename(temporary, filename);
  }

  publicSession(session) {
    return {
      id: session.id,
      name: session.name,
      size: session.size,
      chunkSize: session.chunkSize,
      totalChunks: session.totalChunks,
      status: session.status,
      createdAt: session.createdAt,
      file: session.file,
    };
  }
}

function cleanFilename(value) {
  return path
    .basename(String(value || "").replace(/[\u0000-\u001f\u007f]/g, ""))
    .trim();
}

async function fileHasSize(filename, size) {
  try {
    return (await fsp.stat(filename)).size === size;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function removeIfExists(filename) {
  try {
    await fsp.unlink(filename);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function hashFile(filename) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

async function writeAll(fileHandle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await fileHandle.write(
      buffer,
      offset,
      buffer.length - offset,
      null,
    );
    if (bytesWritten <= 0)
      throw new UploadError(
        "O disco não aceitou todos os bytes do arquivo.",
        507,
      );
    offset += bytesWritten;
  }
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function formatGigabytes(bytes) {
  return `${Math.round(bytes / 1024 ** 3)} GB`;
}

module.exports = { UploadManager, UploadError };
