const Busboy = require("busboy");

function receiveSingleFile(req, { maxBytes, allowedFields = [] }) {
  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = Busboy({
        headers: req.headers,
        limits: {
          files: 1,
          fileSize: maxBytes,
          fields: allowedFields.length + 2,
          fieldSize: 8 * 1024,
          parts: allowedFields.length + 3,
        },
      });
    } catch {
      reject(toolError("Envie o arquivo como multipart/form-data.", 415));
      return;
    }

    const fields = {};
    const chunks = [];
    let file = null;
    let tooLarge = false;
    let invalidPart = false;

    parser.on("field", (name, value) => {
      if (!allowedFields.includes(name)) {
        invalidPart = true;
        return;
      }
      fields[name] = value;
    });

    parser.on("file", (name, stream, info) => {
      if (name !== "file" || file) {
        invalidPart = true;
        stream.resume();
        return;
      }
      file = {
        filename: info.filename,
        mimeType: info.mimeType,
        encoding: info.encoding,
      };
      stream.on("limit", () => {
        tooLarge = true;
      });
      stream.on("data", (chunk) => {
        if (!tooLarge) chunks.push(chunk);
      });
      stream.on("error", reject);
    });

    parser.on("filesLimit", () => {
      invalidPart = true;
    });
    parser.on("partsLimit", () => {
      invalidPart = true;
    });
    parser.on("error", () => {
      reject(toolError("Não foi possível interpretar o envio.", 400));
    });
    parser.on("close", () => {
      if (tooLarge)
        return reject(
          toolError(
            `O arquivo excede o limite público de ${formatMegabytes(maxBytes)}.`,
            413,
          ),
        );
      if (invalidPart)
        return reject(toolError("O formulário enviado é inválido.", 400));
      if (!file) return reject(toolError("Selecione um arquivo.", 400));
      const buffer = Buffer.concat(chunks);
      if (!buffer.length)
        return reject(toolError("O arquivo enviado está vazio.", 400));
      resolve({ ...file, buffer, fields });
    });

    req.pipe(parser);
  });
}

function toolError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  error.expected = true;
  return error;
}

function formatMegabytes(bytes) {
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
}

module.exports = { receiveSingleFile, toolError };
