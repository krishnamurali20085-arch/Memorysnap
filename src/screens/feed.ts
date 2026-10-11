import { api, type AlbumMeta, type MediaItem } from "../api";
import { downloadAllZip, downloadItem } from "../zip";
import { onOutboxChange, outboxCount, pump } from "../outbox";
import { getSettings } from "../store";
import { el, fmtTime, toast } from "../ui";
import { openDetail } from "./detail";
import { openCamera } from "./camera";

export function renderFeed(root: HTMLElement, albumId: string) {
  const screen = el("div", { class: "screen no-nav" });
  const header = el("div");
  const actions = el("div", { class: "row wrap", style: "gap:0.5rem;margin-bottom:0.9rem" });
  const statusRow = el("div", { class: "row", style: "gap:0.5rem;margin-bottom:0.6rem;font-size:0.82rem;color:var(--text-dim)" });
  const grid = el("div", { class: "grid" });
  const empty = el("div", { class: "empty" });
  screen.append(header, actions, statusRow, grid, empty);

  let items: MediaItem[] = [];
  let cursor = 0;
  let meta: AlbumMeta | null = null;
  let stopped = false;
  let queued = 0;
  let pollFailed = false;

  const syncDot = el("span", { class: "sync-dot" });
  const syncText = el("span", {}, "Live");
  const queueText = el("span", {});
  statusRow.append(syncDot, syncText, queueText);

  function setSyncState() {
    const s = getSettings();
    if (!s.syncEnabled) {
      syncDot.className = "sync-dot off";
      syncText.textContent = "Sync off";
    } else if (!navigator.onLine || pollFailed) {
      syncDot.className = "sync-dot warn";
      syncText.textContent = navigator.onLine ? "Reconnecting…" : "Offline — queued";
    } else {
      syncDot.className = "sync-dot";
      syncText.textContent = "Live";
    }
    queueText.textContent = queued > 0 ? ` · ${queued} waiting to upload` : "";
  }

  function renderHeader() {
    header.replaceChildren(
      el(
        "div",
        { class: "row between" },
        el(
          "div",
          {},
          el("h1", {}, meta?.name ?? "Album"),
          el("p", { class: "sub", style: "margin-bottom:0.2rem" }, `Invite code: ${meta?.code ?? "…"}`),
        ),
        el("button", { class: "icon-btn", style: "font-size:1.2rem", onClick: () => void openShare() }, "🔗"),
      ),
      el(
        "div",
        { class: "row wrap", style: "gap:0.4rem;margin-top:0.6rem" },
        el("span", { class: "pill" }, "🔒 Never expires"),
        el("span", { class: "pill pink" }, "Real-time sharing"),
        el("span", { class: "pill yellow" }, `Delete: ${meta?.deletePolicy ?? "everyone"}`),
        meta?.isHost ? el("span", { class: "pill green" }, "You are the host") : null,
      ),
    );
  }

  function renderActions() {
    actions.replaceChildren(
      el("button", { class: "btn small", onClick: () => void openCameraScreen() }, "📷 Shoot"),
      el("button", { class: "btn small ghost", onClick: () => void uploadFiles() }, "➕ Add files"),
      el("button", { class: "btn small ghost", onClick: () => void downloadAll() }, "⬇️ All"),
    );
  }

  function renderGrid() {
    grid.replaceChildren();
    const sorted = [...items].sort((a, b) => b.createdAt - a.createdAt);
    for (const item of sorted) {
      const tile = el("div", { class: "tile" });
      if (item.kind === "photo" && item.thumbUrl) {
        tile.append(el("img", { src: item.thumbUrl, loading: "lazy", alt: "" }));
      } else if (item.kind === "video" && item.thumbUrl) {
        tile.append(el("img", { src: item.thumbUrl, loading: "lazy", alt: "" }));
        tile.append(el("span", { class: "badge" }, "🎬"));
      } else if (item.kind === "video") {
        const v = el("video", { src: item.url, preload: "metadata", muted: true });
        tile.append(v);
        tile.append(el("span", { class: "badge" }, "🎬"));
      } else {
        tile.append(el("div", { class: "audio-face" }, "🎵"));
      }
      const dl = el("button", { class: "dl", title: "Download" }, "⬇️");
      dl.addEventListener("click", (e) => {
        e.stopPropagation();
        downloadItem(item);
      });
      tile.append(dl);
      tile.addEventListener("click", () => openDetail(item, { canDelete: canDelete(item), onDelete: () => handleDelete(item) }));
      grid.append(tile);
    }
    empty.replaceChildren();
    if (!items.length) {
      empty.append(
        el("div", { class: "big" }, "📸"),
        el("div", {}, "No moments yet — tap Shoot and make some noise"),
      );
    }
    if (queued > 0) {
      empty.append(el("div", { class: "sub", style: "margin-top:0.8rem" }, `${queued} item(s) waiting to sync`));
    }
  }

  function canDelete(item: MediaItem): boolean {
    if (!meta) return false;
    if (meta.isHost) return true;
    if (meta.deletePolicy === "everyone") return true;
    if (meta.deletePolicy === "uploader") {
      const mine = items.find((i) => i.id === item.id);
      return mine?.uploader === meta.name || !!meta;
    }
    return false;
  }

  async function handleDelete(item: MediaItem) {
    try {
      await api.deleteMedia(albumId, item.id);
      items = items.filter((i) => i.id !== item.id);
      renderGrid();
      toast("Deleted");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Delete failed");
    }
  }

  async function refreshMeta() {
    try {
      meta = await api.meta(albumId);
      renderHeader();
    } catch (e) {
      if (e instanceof Error && e.message.includes("Join")) {
        location.hash = "#/";
      }
    }
  }

  async function poll(initial = false) {
    if (stopped) return;
    try {
      if (initial) {
        const first = await api.feed(albumId, 0, 200);
        items = first.items;
        cursor = first.nextCursor;
      } else if (getSettings().syncEnabled) {
        const res = await api.feed(albumId, cursor, 100);
        if (res.items.length) {
          items = [...items, ...res.items];
          cursor = res.nextCursor;
        }
      } else {
        return;
      }
      pollFailed = false;
      renderGrid();
    } catch {
      pollFailed = true;
    }
    setSyncState();
  }

  async function refreshQueue() {
    queued = await outboxCount(albumId);
    setSyncState();
    renderGrid();
  }

  async function openCameraScreen() {
    await openCamera(albumId, () => {
      pump();
      void poll();
    });
  }

  async function uploadFiles() {
    const { uploadFlow } = await import("./camera");
    await uploadFlow(albumId, () => {
      pump();
      void poll();
    });
  }

  async function downloadAll() {
    const ready = items;
    if (!ready.length) {
      toast("Nothing to download yet");
      return;
    }
    toast(`Preparing ${ready.length} files…`, 5000);
    try {
      await downloadAllZip(ready);
      toast("Download started");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Zip failed");
    }
  }

  async function openShare() {
    if (!meta) return;
    const shareData = { title: meta.name, text: `Join my ForeverSnap album "${meta.name}" — code ${meta.code} (never expires!)` };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
        return;
      } catch {
        /* fall through to clipboard */
      }
    }
    try {
      await navigator.clipboard.writeText(`${shareData.text}`);
      toast("Invite text copied");
    } catch {
      toast(`Code: ${meta.code}`, 4000);
    }
  }

  const unsubQueue = onOutboxChange(() => {
    void refreshQueue();
    void poll();
  });

  void refreshMeta().then(() => void poll(true));
  void refreshQueue();
  renderActions();
  renderGrid();
  setSyncState();

  const pollTimer = window.setInterval(() => void poll(), 3000);
  const queueTimer = window.setInterval(() => void refreshQueue(), 5000);
  window.addEventListener("online", () => {
    setSyncState();
    pump();
    void poll();
  });
  window.addEventListener("offline", setSyncState);

  root.append(screen);

  return () => {
    stopped = true;
    unsubQueue();
    window.clearInterval(pollTimer);
    window.clearInterval(queueTimer);
  };
}
