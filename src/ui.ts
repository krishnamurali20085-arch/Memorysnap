export type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

export function el(tag: string, attrs: Attrs = {}, ...children: (Node | string | null | undefined)[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === "class") {
      node.className = String(value);
    } else if (value === true) {
      node.setAttribute(key, "");
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
}

let toastTimer: number | undefined;
export function toast(message: string, ms = 2600) {
  document.querySelector(".toast")?.remove();
  window.clearTimeout(toastTimer);
  const t = el("div", { class: "toast" }, message);
  document.body.append(t);
  toastTimer = window.setTimeout(() => t.remove(), ms);
}

export function modal(title: string, ...children: (Node | null | undefined)[]): { close: () => void } {
  const back = el("div", { class: "modal-back" });
  const box = el("div", { class: "modal" }, el("h2", {}, title), ...children);
  const close = () => back.remove();
  back.addEventListener("click", (e) => {
    if (e.target === back) close();
  });
  back.append(box);
  document.body.append(back);
  return { close };
}

export function confirmDialog(title: string, message: string, confirmLabel = "Confirm"): Promise<boolean> {
  return new Promise((resolve) => {
    const m = modal(title, el("p", { class: "sub" }, message));
    const row = el(
      "div",
      { class: "row", style: "margin-top:1rem" },
      el("button", { class: "btn ghost grow", onClick: () => { m.close(); resolve(false); } }, "Cancel"),
      el("button", { class: "btn danger grow", onClick: () => { m.close(); resolve(true); } }, confirmLabel),
    );
    const box = document.querySelector(".modal");
    box?.append(row);
  });
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
