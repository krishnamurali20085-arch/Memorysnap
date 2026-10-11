import { api } from "../api";
import { clearUser, getAlbums, getDeviceId, getDisplayName, getUser, randomToken, removeAlbum, saveAlbum, saveUser, setDisplayName } from "../store";
import { confirmDialog, el, modal, toast } from "../ui";

export function renderAlbums(root: HTMLElement) {
  const list = el("div");
  const accountCard = el("div", { style: "margin-top:1rem" });
  const screen = el(
    "div",
    { class: "screen" },
    el(
      "div",
      { class: "row between" },
      el(
        "div",
        {},
        el("h1", {}, "ForeverSnap"),
        el("p", { class: "sub", style: "margin-bottom:0" }, "Party Albums & Live Feed — albums that never expire"),
      ),
    ),
    el(
      "div",
      { class: "row", style: "margin-top:1rem" },
      el("button", { class: "btn grow", onClick: () => (getUser() ? openCreate() : openLogin(() => openCreate())) }, "📷 Create Album"),
      el("button", { class: "btn ghost grow", onClick: () => openJoin() }, "👥 Join Album"),
    ),
    accountCard,
    el("h2", { style: "margin:1.2rem 0 0.7rem" }, "Albums"),
    list,
  );

  function renderAccount() {
    const user = getUser();
    accountCard.replaceChildren();
    if (!user) {
      accountCard.append(
        el(
          "div",
          { class: "card" },
          el("strong", {}, "⏮ Log in so you never lose your albums"),
          el("p", { class: "sub", style: "margin:0.3rem 0 0.8rem" }, "Log in with your phone number. If you uninstall or switch phones, log back in and all your albums come back."),
          el("button", { class: "btn small", onClick: () => openLogin(() => refresh()) }, "Log in / Sign up"),
        ),
      );
    } else {
      accountCard.append(
        el(
          "div",
          { class: "card" },
          el("div", { class: "row between" },
            el("div", {}, el("strong", {}, `Logged in as ${user.phone}`), el("p", { class: "sub", style: "margin:0.2rem 0 0" }, "Your albums are tied to this number.")),
            el("button", { class: "btn ghost small", onClick: () => void logout() }, "Log out"),
          ),
        ),
      );
    }
  }

  async function logout() {
    try {
      await api.logout();
    } catch {
      /* cookie cleared server-side best effort */
    }
    clearUser();
    toast("Logged out — albums stay on this device");
    renderAccount();
  }

  async function restoreAlbums(): Promise<number> {
    if (!getUser()) return 0;
    try {
      const { albums } = await api.myAlbums();
      let added = 0;
      for (const a of albums) {
        const existing = getAlbums()[a.id];
        if (!existing) added += 1;
        saveAlbum({
          id: a.id,
          code: a.code,
          name: a.name,
          deletePolicy: a.deletePolicy,
          hostToken: a.hostToken,
          uploaderToken: existing?.uploaderToken ?? randomToken(),
          displayName: getDisplayName(),
        });
      }
      return added;
    } catch {
      return 0;
    }
  }

  function openLogin(onDone?: () => void) {
    const phoneInput = el("input", { type: "tel", inputmode: "tel", placeholder: "Phone number (with country code)", maxlength: "20" }) as HTMLInputElement;
    const pinInput = el("input", { type: "password", inputmode: "numeric", placeholder: "4-8 digit PIN", maxlength: "8" }) as HTMLInputElement;
    const userInput = el("input", { type: "text", placeholder: "e.g. Krishna2008", maxlength: "24", autocapitalize: "none", autocomplete: "off" }) as HTMLInputElement;
    const err = el("div", { class: "sub", style: "color:var(--red);display:none" });
    const submit = el("button", { class: "btn block" }, "Log in") as HTMLButtonElement;
    const m = modal(
      "Log in",
      el("p", { class: "sub" }, "Your username is shown on every photo you take. New number? Your PIN creates the account — your albums follow your phone number even after reinstalling."),
      el("div", { class: "field" }, el("label", {}, "Phone number"), phoneInput),
      el("div", { class: "field" }, el("label", {}, "Username (required on first login)"), userInput),
      el("div", { class: "field" }, el("label", {}, "PIN"), pinInput),
      err,
      submit,
    );
    submit.addEventListener("click", async () => {
      const phone = phoneInput.value.trim();
      const pin = pinInput.value.trim();
      if (phone.replace(/\D/g, "").length < 7) {
        err.textContent = "Enter a valid phone number";
        err.style.display = "block";
        return;
      }
      if (!/^\d{4,8}$/.test(pin)) {
        err.textContent = "PIN must be 4-8 digits";
        err.style.display = "block";
        return;
      }
      const username = userInput.value.trim();
      if (username && !/^[A-Za-z0-9_.-]{3,24}$/.test(username)) {
        err.textContent = "Username: 3-24 letters, numbers, _ . -";
        err.style.display = "block";
        return;
      }
      submit.disabled = true;
      submit.replaceChildren(el("span", { class: "spin" }), "Logging in…");
      try {
        const res = await api.login(phone, pin, username || undefined);
        saveUser({ userId: res.userId, phone: res.phone, username: res.username, displayName: res.displayName });
        if (res.username) setDisplayName(res.username);
        const restored = await restoreAlbums();
        m.close();
        toast(restored > 0 ? `Logged in — restored ${restored} album${restored === 1 ? "" : "s"}` : "Logged in");
        renderAccount();
        void refresh();
        onDone?.();
      } catch (e) {
        err.textContent = e instanceof Error ? e.message : "Login failed";
        err.style.display = "block";
        submit.disabled = false;
        submit.replaceChildren("Log in");
      }
    });
  }

  async function refresh() {
    const albums = Object.values(getAlbums());
    list.replaceChildren();
    if (!albums.length) {
      list.append(
        el(
          "div",
          { class: "empty" },
          el("div", { class: "big" }, "🎉"),
          el("div", {}, "No albums yet — create one and share the 6-digit code"),
        ),
      );
      return;
    }
    for (const entry of albums) {
      const card = el(
        "div",
        { class: "card" },
        el(
          "div",
          { class: "row" },
          el("div", { class: "icon-btn", style: "width:48px;height:48px;font-size:1.3rem" }, "📸"),
          el(
            "div",
            { class: "grow" },
            el(
              "div",
              { class: "row", style: "gap:0.4rem" },
              el("strong", {}, entry.name),
              el("span", { class: "pill" }, "🔒 Forever"),
            ),
            el("div", { class: "sub", style: "margin:0.2rem 0 0" }, `Code: ${entry.code}`),
          ),
          el("button", { class: "icon-btn", onClick: () => void openMenu(entry.id) }, "›"),
        ),
      );
      card.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        location.hash = `#/a/${entry.id}`;
      });
      list.append(card);
    }
    void fetchMetas(albums.map((a) => a.id));
  }

  async function fetchMetas(ids: string[]) {
    for (const id of ids) {
      try {
        const meta = await api.meta(id);
        const entry = getAlbums()[id];
        if (entry && (meta.code !== entry.code || meta.deletePolicy !== entry.deletePolicy)) {
          saveAlbum({ ...entry, code: meta.code, deletePolicy: meta.deletePolicy });
        }
      } catch {
        /* offline or album gone; keep cached entry */
      }
    }
  }

  function openCreate() {
    const nameInput = el("input", { type: "text", placeholder: "Album name (e.g. Memories)", maxlength: "60" }) as HTMLInputElement;
    const pinInput = el("input", { type: "password", inputmode: "numeric", placeholder: "Optional 4-8 digit PIN", maxlength: "8" }) as HTMLInputElement;
    const policy = el("select", {},
      el("option", { value: "everyone" }, "Everyone can delete"),
      el("option", { value: "host" }, "Host only"),
      el("option", { value: "uploader" }, "Uploader only"),
    ) as HTMLSelectElement;
    const nameField = el("div", { class: "field" }, el("label", {}, "Album name"), nameInput);
    const pinField = el("div", { class: "field" }, el("label", {}, "Access PIN (optional)"), pinInput);
    const policyField = el("div", { class: "field" }, el("label", {}, "Deletion permissions"), policy);
    const err = el("div", { class: "sub", style: "color:var(--red);display:none" });
    const submit = el("button", { class: "btn block" }, "Create forever album") as HTMLButtonElement;
    const m = modal("Create Album", nameField, pinField, policyField, err, submit);
    submit.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      if (!name) {
        err.textContent = "Give the album a name";
        err.style.display = "block";
        return;
      }
      const pin = pinInput.value.trim();
      if (pin && !/^\d{4,8}$/.test(pin)) {
        err.textContent = "PIN must be 4-8 digits";
        err.style.display = "block";
        return;
      }
      submit.disabled = true;
      submit.replaceChildren(el("span", { class: "spin" }), "Creating…");
      try {
        const res = await api.createAlbum(name, pin || null, policy.value);
        saveAlbum({
          id: res.albumId,
          code: res.code,
          name: res.name,
          deletePolicy: res.deletePolicy,
          hostToken: res.hostToken,
          uploaderToken: randomToken(),
          displayName: getDisplayName(),
        });
        m.close();
        toast(`Album created — code ${res.code}`);
        location.hash = `#/a/${res.albumId}`;
      } catch (e) {
        err.textContent = e instanceof Error ? e.message : "Failed";
        err.style.display = "block";
        submit.disabled = false;
        submit.replaceChildren("Create forever album");
      }
    });
  }

  function openJoin() {
    const codeInput = el("input", {
      type: "tel",
      inputmode: "numeric",
      placeholder: "6-digit code",
      maxlength: "6",
      style: "letter-spacing:0.3em;text-align:center;font-size:1.3rem;font-weight:700",
    }) as HTMLInputElement;
    const pinInput = el("input", { type: "password", inputmode: "numeric", placeholder: "PIN (if the album has one)", maxlength: "8" }) as HTMLInputElement;
    const userInput = el("input", { type: "text", placeholder: "Your username (shown on your photos)", maxlength: "24", value: getUser() ? "" : getDisplayName() === "Guest" ? "" : getDisplayName(), autocapitalize: "none", autocomplete: "off" }) as HTMLInputElement;
    const err = el("div", { class: "sub", style: "color:var(--red);display:none" });
    const submit = el("button", { class: "btn block" }, "Join") as HTMLButtonElement;
    const m = modal("Join Album", el("div", { class: "field" }, codeInput), el("div", { class: "field" }, pinInput), el("div", { class: "field" }, el("label", {}, "Username (on your photos)"), userInput), err, submit);
    submit.addEventListener("click", async () => {
      const code = codeInput.value.replace(/\D/g, "");
      if (code.length !== 6) {
        err.textContent = "Enter the 6-digit code";
        err.style.display = "block";
        return;
      }
      const username = userInput.value.trim();
      if (username && !/^[A-Za-z0-9_.-]{3,24}$/.test(username)) {
        err.textContent = "Username: 3-24 letters, numbers, _ . -";
        err.style.display = "block";
        return;
      }
      if (username) setDisplayName(username);
      submit.disabled = true;
      submit.replaceChildren(el("span", { class: "spin" }), "Joining…");
      try {
        const res = await api.joinAlbum(code, pinInput.value.trim() || null, getDeviceId());
        saveAlbum({
          id: res.albumId,
          code,
          name: res.name,
          deletePolicy: res.deletePolicy,
          uploaderToken: randomToken(),
          displayName: getDisplayName(),
        });
        m.close();
        toast(`Joined ${res.name}`);
        location.hash = `#/a/${res.albumId}`;
      } catch (e) {
        err.textContent = e instanceof Error ? e.message : "Failed";
        err.style.display = "block";
        submit.disabled = false;
        submit.replaceChildren("Join");
      }
    });
  }

  async function openMenu(id: string) {
    const entry = getAlbums()[id];
    if (!entry) return;
    const m = modal(
      entry.name,
      el("p", { class: "sub" }, `Invite code: ${entry.code} — this album never expires.`),
      el(
        "div",
        { class: "field" },
        el("label", {}, "Your display name"),
        (() => {
          const input = el("input", { type: "text", value: getDisplayName(), maxlength: "40" }) as HTMLInputElement;
          input.addEventListener("change", () => {
            setDisplayName(input.value);
            toast("Name saved");
          });
          return input;
        })(),
      ),
      el("button", { class: "btn ghost block", style: "margin-bottom:0.6rem", onClick: () => { void copyCode(entry.code); } }, "Copy invite code"),
      entry.hostToken
        ? el(
            "button",
            {
              class: "btn danger block",
              style: "margin-bottom:0.6rem",
              onClick: async () => {
                if (!(await confirmDialog("Delete album forever?", `This permanently deletes "${entry.name}" and every photo, video and audio in it for EVERYONE. It cannot be undone.`))) return;
                try {
                  await api.deleteAlbum(id);
                  removeAlbum(id);
                  m.close();
                  toast("Album deleted forever");
                  void refresh();
                } catch (e) {
                  toast(e instanceof Error ? e.message : "Delete failed");
                }
              },
            },
            "🗑 Delete album forever",
          )
        : null,
      el(
        "button",
        {
          class: "btn danger block",
          onClick: async () => {
            if (await confirmDialog("Leave album?", "The album stays online forever; this only removes it from this device.")) {
              removeAlbum(id);
              m.close();
              toast("Removed from this device");
              void refresh();
            }
          },
        },
        "Remove from this device",
      ),
    );
  }

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      toast("Code copied");
    } catch {
      toast(`Code: ${code}`, 4000);
    }
  }

  renderAccount();
  void refresh();
  void restoreAlbums().then((added) => {
    if (added > 0) {
      toast(`Restored ${added} album${added === 1 ? "" : "s"} from your account`);
      void refresh();
    }
  });
  root.append(screen);
}
