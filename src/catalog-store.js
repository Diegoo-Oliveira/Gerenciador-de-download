const fs = require("node:fs");

class CatalogStore {
  constructor(filename) {
    this.filename = filename;
  }

  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filename, "utf8"));
      if (Array.isArray(parsed)) {
        return {
          version: 3,
          folders: [],
          files: parsed.map(normalizeFile),
        };
      }
      return {
        version: 3,
        folders: Array.isArray(parsed.folders)
          ? parsed.folders.map(normalizeFolder)
          : [],
        files: Array.isArray(parsed.files)
          ? parsed.files.map(normalizeFile)
          : [],
      };
    } catch (error) {
      if (error.code === "ENOENT")
        return { version: 3, folders: [], files: [] };
      throw error;
    }
  }

  write(catalog) {
    const temporary = `${this.filename}.tmp`;
    fs.writeFileSync(
      temporary,
      JSON.stringify(
        {
          version: 3,
          folders: catalog.folders,
          files: catalog.files,
        },
        null,
        2,
      ),
    );
    fs.renameSync(temporary, this.filename);
  }
}

function normalizeFile(file) {
  return {
    ...file,
    folderId: file.folderId || null,
    visibility: file.visibility === "public" ? "public" : "private",
  };
}

function normalizeFolder(folder) {
  return {
    ...folder,
    parentId: folder.parentId || null,
    visibility: folder.visibility === "public" ? "public" : "private",
  };
}

module.exports = { CatalogStore };
