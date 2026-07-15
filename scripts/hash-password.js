const { hashPassword } = require("../src/auth-service");

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

async function main() {
  let password = process.env.VAULTKEEP_PASSWORD || process.argv[2];
  if (!password) {
    if (!process.stdin.isTTY) {
      throw new Error(
        "Execute em um terminal interativo ou informe VAULTKEEP_PASSWORD pelo ambiente.",
      );
    }
    password = await readSecret("Nova senha administrativa: ");
    const confirmation = await readSecret("Confirme a senha: ");
    if (password !== confirmation) throw new Error("As senhas não coincidem.");
  } else if (process.argv[2]) {
    console.error(
      "Aviso: argumentos podem ficar no histórico do terminal. Prefira executar sem argumentos.",
    );
  }
  console.log(await hashPassword(password));
}

function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    let value = "";
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    function finish(error) {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    }

    function onData(character) {
      if (character === "\u0003")
        return finish(new Error("Operação cancelada."));
      if (character === "\r" || character === "\n") return finish();
      if (character === "\u007f" || character === "\b") {
        if (value) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }
      if (/^[^\u0000-\u001f\u007f]+$/.test(character)) {
        value += character;
        process.stdout.write("*".repeat([...character].length));
      }
    }

    process.stdin.on("data", onData);
  });
}
