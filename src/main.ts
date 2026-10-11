import "./style.css";
import { applyFontScale } from "./store";
import { renderAlbums } from "./screens/albums";
import { renderFeed } from "./screens/feed";
import { renderGuide } from "./screens/guide";
import { onboardingDone, runOnboarding } from "./screens/onboarding";
import { renderSettings } from "./screens/settings";

const app = document.getElementById("app")!;
let cleanup: (() => void) | null = null;

const NAV = [
  { hash: "#/", icon: "🏠", label: "Albums" },
  { hash: "#/guide", icon: "❓", label: "User Guide" },
  { hash: "#/settings", icon: "⚙️", label: "Settings" },
];

function currentRoute(): string {
  return location.hash || "#/";
}

function renderNav(active: string) {
  document.querySelector(".bottom-nav")?.remove();
  const nav = el_nav();
  const base = currentRoute().startsWith("#/a/") ? "#/" : currentRoute();
  for (const item of NAV) {
    const a = document.createElement("a");
    a.href = item.hash;
    if (item.hash === base) a.classList.add("active");
    a.append(
      Object.assign(document.createElement("span"), { className: "nav-ico", textContent: item.icon }),
      document.createElement("span"),
    );
    a.lastElementChild!.textContent = item.label;
    nav.append(a);
  }
  document.body.append(nav);
}

function el_nav(): HTMLElement {
  const nav = document.createElement("nav");
  nav.className = "bottom-nav";
  return nav;
}

async function route() {
  cleanup?.();
  cleanup = null;
  app.replaceChildren();
  const hash = currentRoute();

  if (!onboardingDone() && hash === "#/") {
    await runOnboarding(app);
    app.replaceChildren();
  }

  const albumMatch = hash.match(/^#\/a\/([0-9a-f-]+)/);

  if (albumMatch) {
    cleanup = renderFeed(app, albumMatch[1]) || null;
    renderNav("album");
    window.scrollTo(0, 0);
    return;
  }
  if (hash === "#/settings") {
    renderSettings(app);
    renderNav("#/settings");
  } else if (hash === "#/guide") {
    renderGuide(app);
    renderNav("#/guide");
  } else {
    renderAlbums(app);
    renderNav("#/");
  }
  window.scrollTo(0, 0);
}

window.addEventListener("hashchange", route);
applyFontScale();
if (!location.hash) location.hash = "#/";
route();
