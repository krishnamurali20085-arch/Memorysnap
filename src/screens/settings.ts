import { clearOutboxAndCache } from "../outbox";
import { getSettings, saveSettings, getDisplayName, setDisplayName, getUser, clearUser } from "../store";
import { api } from "../api";
import { askPermission, permissionStatus } from "./onboarding";
import { el, toast } from "../ui";

export function renderSettings(root: HTMLElement) {
  const s = getSettings();

  const screen = el(
    "div",
    { class: "screen" },
    el("h1", {}, "Settings"),
    el("p", { class: "sub" }, "Adjust shooting environment and app behavior"),
  );

  // Display & font size
  const fontLabel = el("h2", {}, `Font Size: ${s.fontSize}: ${["Tiny", "Small", "Standard (Comfortable)", "Large", "Largest"][s.fontSize - 1]}`);
  const fontSlider = el("input", { type: "range", min: "1", max: "5", step: "1", value: String(s.fontSize) }) as HTMLInputElement;
  const preview = el(
    "div",
    { class: "card", style: "background:var(--bg-elev)" },
    el("strong", {}, "[Font Size Preview]"),
    el("div", { style: "margin-top:0.3rem" }, "Share real-time party memories and candid smiles with everyone!"),
  );
  fontSlider.addEventListener("input", () => {
    const v = Number(fontSlider.value) as 1 | 2 | 3 | 4 | 5;
    saveSettings({ fontSize: v });
    const label = ["Tiny", "Small", "Standard (Comfortable)", "Large", "Largest"][v - 1];
    fontLabel.textContent = `Font Size: ${v}: ${label}`;
  });
  screen.append(
    el("div", { class: "section-title" }, "🔤 Display & Font Size"),
    el("div", { class: "card" }, fontLabel, el("p", { class: "sub" }, "Adjust the font size across the entire application in 5 levels."), fontSlider, preview),
  );

  // Sound shutter
  const sensValue = el("span", { style: "font-weight:700" }, `Default Sensitivity: ${s.sensitivity} dB`);
  const sensSlider = el("input", { type: "range", min: "40", max: "100", step: "1", value: String(s.sensitivity) }) as HTMLInputElement;
  sensSlider.style.setProperty("--fill", `${((s.sensitivity - 40) / 60) * 100}%`);
  sensSlider.addEventListener("input", () => {
    const v = Number(sensSlider.value);
    saveSettings({ sensitivity: v });
    sensValue.textContent = `Default Sensitivity: ${v} dB`;
    sensSlider.style.setProperty("--fill", `${((v - 40) / 60) * 100}%`);
  });

  const flashSwitch = el("button", { class: `switch${s.screenFlash ? " on" : ""}`, role: "switch", "aria-checked": String(s.screenFlash) });
  flashSwitch.addEventListener("click", () => {
    const next = !getSettings().screenFlash;
    saveSettings({ screenFlash: next });
    flashSwitch.classList.toggle("on", next);
    flashSwitch.setAttribute("aria-checked", String(next));
  });

  screen.append(
    el("div", { class: "section-title" }, "🎙️ Sound Shutter Settings"),
    el(
      "div",
      { class: "card" },
      sensValue,
      el("p", { class: "sub" }, "Sound pressure threshold to auto-trigger the camera shutter on laughter and cheers."),
      sensSlider,
      el("div", { class: "row between", style: "margin-top:1rem" },
        el("div", { class: "grow" }, el("strong", {}, "Screen Flash on Capture"), el("p", { class: "sub", style: "margin:0.2rem 0 0" }, "Flashes the screen white when an auto-photo is captured.")),
        flashSwitch,
      ),
    ),
  );

  // Network & storage
  const syncSwitch = el("button", { class: `switch${s.syncEnabled ? " on" : ""}`, role: "switch", "aria-checked": String(s.syncEnabled) });
  syncSwitch.addEventListener("click", () => {
    const next = !getSettings().syncEnabled;
    saveSettings({ syncEnabled: next });
    syncSwitch.classList.toggle("on", next);
    syncSwitch.setAttribute("aria-checked", String(next));
    if (next) {
      import("../outbox").then((m) => m.pump());
    }
    toast(next ? "Real-time sync on" : "Sync paused — captures stay queued");
  });

  const clearBtn = el("button", { class: "btn ghost small" }, "Clear");
  clearBtn.addEventListener("click", async () => {
    await clearOutboxAndCache();
    toast("Local cache and upload queue cleared");
  });

  screen.append(
    el("div", { class: "section-title" }, "☁️ Network & Storage"),
    el(
      "div",
      { class: "card" },
      el("div", { class: "row between" },
        el("div", { class: "grow" }, el("strong", {}, "Real-time Cloud Sync"), el("p", { class: "sub", style: "margin:0.2rem 0 0" }, "Automatically syncs locally queued captures when returning online.")),
        syncSwitch,
      ),
      el("div", { class: "row between", style: "margin-top:1rem" },
        el("div", { class: "grow" }, el("strong", {}, "Clear Local Cache"), el("p", { class: "sub", style: "margin:0.2rem 0 0" }, "Clears the offline queue and cached files. Uploaded album media stays online forever.")),
        clearBtn,
      ),
    ),
  );

  // Permissions
  const perms: [string, "camera" | "mic" | "location" | "motion", string][] = [
    ["📷 Camera & photos", "camera", "Take photos/videos for the album"],
    ["🎙️ Microphone", "mic", "Record audio, video sound, sound shutter"],
    ["📍 Location", "location", "Add place to each photo's info"],
    ["🔄 Motion (iPhone)", "motion", "Tilt-follow shutter button"],
  ];
  const permRows = el("div");
  for (const [label, key, hint] of perms) {
    const statusText = el("span", { class: "sub", style: "margin:0" }, "…");
    void permissionStatus(key).then((s) => {
      statusText.textContent = s === "granted" ? "✅ Granted" : s === "denied" ? "❌ Blocked" : s === "prompt" ? "⏸ Not asked yet" : "—";
    });
    const btn = el("button", { class: "btn ghost small" }, "Ask") as HTMLButtonElement;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await askPermission(key);
      void permissionStatus(key).then((s) => {
        statusText.textContent = s === "granted" ? "✅ Granted" : s === "denied" ? "❌ Blocked" : s === "prompt" ? "⏸ Not asked yet" : "—";
        btn.disabled = false;
      });
    });
    permRows.append(
      el("div", { class: "row between", style: "padding:0.5rem 0;border-bottom:1px solid var(--border)" },
        el("div", { class: "grow" }, el("strong", {}, label), el("div", { class: "sub", style: "margin:0.1rem 0 0" }, hint)),
        el("div", { class: "row", style: "gap:0.5rem" }, statusText, btn),
      ),
    );
  }
  screen.append(
    el("div", { class: "section-title" }, "🔐 Permissions"),
    el("div", { class: "card" }, permRows),
  );

  // Profile
  const nameInput = el("input", { type: "text", value: getDisplayName(), maxlength: "24", autocapitalize: "none" }) as HTMLInputElement;
  nameInput.addEventListener("change", () => {
    const v = nameInput.value.trim().replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 24);
    nameInput.value = v;
    if (v.length >= 3) {
      setDisplayName(v);
      toast("Username saved — used on your uploads");
    } else {
      toast("Username: 3-24 letters/numbers");
    }
  });
  const user = getUser();
  const accountCard = user
    ? el(
        "div",
        { class: "card" },
        el("div", { class: "row between" },
          el("div", {}, el("strong", {}, `Signed in as ${user.phone}`), el("p", { class: "sub", style: "margin:0.2rem 0 0" }, "Your albums follow this number — reinstall-safe.")),
          (() => {
            const b = el("button", { class: "btn ghost small" }, "Log out") as HTMLButtonElement;
            b.addEventListener("click", async () => {
              try { await api.logout(); } catch { /* best effort */ }
              clearUser();
              toast("Logged out");
              root.replaceChildren();
              renderSettings(root);
            });
            return b;
          })(),
        ),
      )
    : el(
        "div",
        { class: "card" },
        el("strong", {}, "Not logged in"),
        el("p", { class: "sub", style: "margin:0.3rem 0 0.8rem" }, "Log in from the Albums tab so your albums survive reinstalls and new phones."),
      );
  screen.append(
    el("div", { class: "section-title" }, "👤 You"),
    accountCard,
    el("div", { class: "card" }, el("div", { class: "field" }, el("label", {}, "Display name shown on your uploads"), nameInput)),
  );

  root.append(screen);
}
