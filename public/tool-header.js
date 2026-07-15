initializeToolHeader();
revealActiveTool();

function revealActiveTool() {
  requestAnimationFrame(() => {
    const navigation = document.querySelector(".public-site-nav");
    const activeTool = navigation?.querySelector(".active");
    if (activeTool && navigation.scrollWidth > navigation.clientWidth)
      activeTool.scrollIntoView({ block: "nearest", inline: "center" });
  });
}

async function initializeToolHeader() {
  const user = document.querySelector("#toolSessionUser");
  const action = document.querySelector("#toolSessionAction");
  const label = document.querySelector("#toolSessionLabel");
  const arrow = document.querySelector("#toolSessionArrow");
  if (!user || !action || !label || !arrow) return;

  try {
    const response = await fetch("/api/session", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return;
    const session = await response.json();
    if (!session.authenticated || !session.user) return;

    user.textContent = `Operador: ${session.user.username}`;
    user.classList.remove("hidden");
    label.textContent = "Administrar";
    arrow.textContent = "→";
    action.href = "/admin";
    action.setAttribute("aria-label", "Abrir área administrativa");
  } catch {
    /* O cabeçalho continua como visitante se a sessão não puder ser consultada. */
  }
}
