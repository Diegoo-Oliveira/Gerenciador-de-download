const PASSWORD_CHARACTER_GROUPS = Object.freeze({
  uppercase: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  lowercase: "abcdefghijklmnopqrstuvwxyz",
  numbers: "0123456789",
  symbols: "!@#$%^&*()-_=+[]{};:,.?/|~",
});

function generateSecurePassword(options, cryptoSource = globalThis.crypto) {
  const length = integerBetween(options.length, 8, 32, "A senha");
  const prefix = validatePrefix(options.prefix || "");
  const prefixCharacters = Array.from(prefix);
  const pools = Object.entries(PASSWORD_CHARACTER_GROUPS)
    .filter(([name]) => Boolean(options[name]))
    .map(([, characters]) => characters);
  if (!pools.length)
    throw new Error("Selecione ao menos um grupo de caracteres.");

  const randomLength = length - prefixCharacters.length;
  if (randomLength < pools.length)
    throw new Error(
      `O prefixo deve deixar pelo menos ${pools.length} posições aleatórias na senha.`,
    );
  const combinedPool = pools.join("");
  const randomCharacters = pools.map(
    (pool) => pool[secureRandomIndex(pool.length, cryptoSource)],
  );
  while (randomCharacters.length < randomLength) {
    randomCharacters.push(
      combinedPool[secureRandomIndex(combinedPool.length, cryptoSource)],
    );
  }
  secureShuffle(randomCharacters, cryptoSource);
  return `${prefixCharacters.join("")}${randomCharacters.join("")}`;
}

function generateSecurePin(length, cryptoSource = globalThis.crypto) {
  const cleanLength = integerBetween(length, 4, 16, "O PIN");
  for (let attempt = 0; attempt < 64; attempt += 1) {
    let pin = "";
    while (pin.length < cleanLength) {
      pin += PASSWORD_CHARACTER_GROUPS.numbers[
        secureRandomIndex(PASSWORD_CHARACTER_GROUPS.numbers.length, cryptoSource)
      ];
    }
    if (!isTrivialPin(pin)) return pin;
  }
  throw new Error("Não foi possível gerar um PIN seguro. Tente novamente.");
}

function passwordStrength(options) {
  if (options.mode === "pin") {
    const length = integerBetween(options.length, 4, 16, "O PIN");
    const entropy = length * Math.log2(10);
    if (length < 6)
      return { label: "PIN básico", level: "weak", percent: 25, entropy };
    if (length < 8)
      return { label: "PIN moderado", level: "medium", percent: 48, entropy };
    if (length < 12)
      return { label: "PIN forte", level: "strong", percent: 72, entropy };
    return { label: "PIN muito forte", level: "very-strong", percent: 100, entropy };
  }

  const prefixLength = Array.from(validatePrefix(options.prefix || "")).length;
  const poolSize = Object.entries(PASSWORD_CHARACTER_GROUPS)
    .filter(([name]) => Boolean(options[name]))
    .reduce((total, [, characters]) => total + characters.length, 0);
  const randomLength = Math.max(0, Number(options.length) - prefixLength);
  const entropy = poolSize > 0 ? randomLength * Math.log2(poolSize) : 0;
  const recommendedComposition =
    Boolean(options.uppercase || options.lowercase) &&
    Boolean(options.numbers) &&
    Boolean(options.symbols);
  if (!recommendedComposition && entropy >= 40)
    return {
      label: "Composição limitada",
      level: "medium",
      percent: Math.min(55, entropy),
      entropy,
    };
  if (entropy < 40)
    return { label: "Fraca", level: "weak", percent: Math.max(8, entropy), entropy };
  if (entropy < 60)
    return { label: "Razoável", level: "medium", percent: entropy, entropy };
  if (entropy < 80)
    return { label: "Forte", level: "strong", percent: entropy, entropy };
  return {
    label: "Muito forte",
    level: "very-strong",
    percent: Math.min(100, entropy),
    entropy,
  };
}

function secureRandomIndex(maximum, cryptoSource) {
  if (!Number.isInteger(maximum) || maximum < 1)
    throw new Error("Conjunto de caracteres inválido.");
  if (!cryptoSource?.getRandomValues)
    throw new Error("Este navegador não oferece geração criptográfica segura.");
  const range = 0x1_0000_0000;
  const ceiling = Math.floor(range / maximum) * maximum;
  const random = new Uint32Array(1);
  do cryptoSource.getRandomValues(random);
  while (random[0] >= ceiling);
  return random[0] % maximum;
}

function secureShuffle(values, cryptoSource) {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = secureRandomIndex(index + 1, cryptoSource);
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }
}

function validatePrefix(value) {
  const prefix = String(value || "");
  if (Array.from(prefix).length > 16)
    throw new Error("O prefixo pode ter no máximo 16 caracteres.");
  if (/[\u0000-\u0020\u007f]/u.test(prefix))
    throw new Error("O prefixo não pode conter espaços ou caracteres de controle.");
  return prefix;
}

function integerBetween(value, minimum, maximum, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum)
    throw new Error(`${label} deve ter entre ${minimum} e ${maximum} caracteres.`);
  return number;
}

function isTrivialPin(pin) {
  if (new Set(pin).size === 1) return true;
  const sequences = [
    "012345678901234567890123456789",
    "123456789012345678901234567890",
    "987654321098765432109876543210",
  ];
  return sequences.some((sequence) => sequence.includes(pin));
}

function initializePasswordGenerator() {
  const elements = Object.fromEntries(
    [
      "passwordOutput",
      "copyPassword",
      "regeneratePassword",
      "passwordLength",
      "passwordLengthValue",
      "passwordLengthLabel",
      "passwordLengthMinimum",
      "passwordLengthMaximum",
      "passwordOptions",
      "prefixOption",
      "passwordPrefix",
      "useUppercase",
      "useLowercase",
      "useNumbers",
      "useSymbols",
      "passwordStrength",
      "passwordStrengthLabel",
      "passwordEntropy",
      "passwordStatus",
      "passwordMode",
      "pinMode",
    ].map((id) => [id, document.querySelector(`#${id}`)]),
  );
  if (!elements.passwordOutput) return;

  const state = { mode: "password", passwordLength: 16, pinLength: 6 };
  const optionInputs = [
    elements.useUppercase,
    elements.useLowercase,
    elements.useNumbers,
    elements.useSymbols,
  ];

  elements.passwordLength.addEventListener("input", () => {
    const value = Number(elements.passwordLength.value);
    if (state.mode === "password") state.passwordLength = value;
    else state.pinLength = value;
    generateAndRender();
  });
  optionInputs.forEach((input) => input.addEventListener("change", generateAndRender));
  elements.passwordPrefix.addEventListener("input", generateAndRender);
  elements.regeneratePassword.addEventListener("click", generateAndRender);
  elements.copyPassword.addEventListener("click", copyGeneratedSecret);
  elements.passwordMode.addEventListener("click", () => selectMode("password"));
  elements.pinMode.addEventListener("click", () => selectMode("pin"));

  selectMode("password");

  function selectMode(mode) {
    state.mode = mode;
    const pin = mode === "pin";
    elements.passwordMode.classList.toggle("active", !pin);
    elements.pinMode.classList.toggle("active", pin);
    elements.passwordMode.setAttribute("aria-selected", String(!pin));
    elements.pinMode.setAttribute("aria-selected", String(pin));
    elements.passwordOptions.classList.toggle("hidden", pin);
    elements.prefixOption.classList.toggle("hidden", pin);
    elements.passwordLength.min = pin ? "4" : "8";
    elements.passwordLength.max = pin ? "16" : "32";
    elements.passwordLength.value = String(pin ? state.pinLength : state.passwordLength);
    elements.passwordLengthMinimum.textContent = pin ? "4" : "8";
    elements.passwordLengthMaximum.textContent = pin ? "16" : "32";
    elements.passwordLengthLabel.textContent = pin
      ? "Número de dígitos do PIN"
      : "Número de caracteres da senha";
    elements.copyPassword.textContent = pin ? "Copiar PIN" : "Copiar senha";
    generateAndRender();
  }

  function currentOptions() {
    return {
      mode: state.mode,
      length: Number(elements.passwordLength.value),
      prefix: state.mode === "password" ? elements.passwordPrefix.value : "",
      uppercase: elements.useUppercase.checked,
      lowercase: elements.useLowercase.checked,
      numbers: elements.useNumbers.checked,
      symbols: elements.useSymbols.checked,
    };
  }

  function generateAndRender() {
    const options = currentOptions();
    elements.passwordLengthValue.textContent = String(options.length);
    elements.passwordStatus.textContent = "";
    try {
      const value =
        options.mode === "pin"
          ? generateSecurePin(options.length)
          : generateSecurePassword(options);
      elements.passwordOutput.value = value;
      elements.copyPassword.disabled = false;
      const strength = passwordStrength(options);
      elements.passwordStrength.value = Math.round(strength.percent);
      elements.passwordStrength.dataset.level = strength.level;
      elements.passwordStrengthLabel.textContent = strength.label;
      elements.passwordStrengthLabel.dataset.level = strength.level;
      elements.passwordEntropy.textContent = `≈ ${Math.round(strength.entropy)} bits aleatórios`;
      if (
        options.mode === "password" &&
        (!(options.uppercase || options.lowercase) ||
          !options.numbers ||
          !options.symbols)
      ) {
        elements.passwordStatus.textContent =
          "Para o padrão forte, mantenha letras, números e símbolos selecionados.";
      }
    } catch (error) {
      elements.passwordOutput.value = "";
      elements.copyPassword.disabled = true;
      elements.passwordStrength.value = 0;
      elements.passwordStrengthLabel.textContent = "Configuração incompleta";
      elements.passwordStrengthLabel.dataset.level = "weak";
      elements.passwordEntropy.textContent = "";
      elements.passwordStatus.textContent = error.message;
    }
  }

  async function copyGeneratedSecret() {
    const value = elements.passwordOutput.value;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      elements.passwordOutput.focus();
      elements.passwordOutput.select();
      if (!document.execCommand("copy")) {
        elements.passwordStatus.textContent =
          "Não foi possível copiar automaticamente. Selecione a senha manualmente.";
        return;
      }
      window.getSelection()?.removeAllRanges();
    }
    const secretName = state.mode === "pin" ? "PIN" : "Senha";
    elements.passwordStatus.textContent = `${secretName} copiado com segurança.`;
    elements.copyPassword.textContent = "Copiada ✓";
    clearTimeout(copyGeneratedSecret.timer);
    copyGeneratedSecret.timer = setTimeout(() => {
      elements.copyPassword.textContent =
        state.mode === "pin" ? "Copiar PIN" : "Copiar senha";
    }, 1600);
  }
}

if (typeof document !== "undefined") initializePasswordGenerator();

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    PASSWORD_CHARACTER_GROUPS,
    generateSecurePassword,
    generateSecurePin,
    isTrivialPin,
    passwordStrength,
    secureRandomIndex,
    validatePrefix,
  };
}
