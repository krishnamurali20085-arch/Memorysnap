import type { MediaItem } from "../api";
import { confirmDialog, el, fmtBytes, fmtTime } from "../ui";
import { downloadItem } from "../zip";

export function openDetail(item: MediaItem, opts: { canDelete: boolean; onDelete: () => void | Promise<void> }) {
  const view = el("div", { class: "detail-view" });
  const close = () => {
    view.remove();
    document.body.style.overflow = "";
  };

  let mediaNode: HTMLElement;
  if (item.kind === "photo") {
    mediaNode = el("img", { src: item.url, alt: "" });
  } else if (item.kind === "video") {
    mediaNode = el("video", { src: item.url, controls: true, playsinline: true, autoplay: true, poster: item.thumbUrl || undefined }) as HTMLElement;
  } else {
    const audio = el("audio", { src: item.url, controls: true, autoplay: true }) as HTMLAudioElement;
    mediaNode = el(
      "div",
      { class: "audio-full" },
      el("div", { class: "art" }, "🎵"),
      audio,
      el("div", { class: "sub" }, `${item.mime} · ${fmtBytes(item.size)}`),
    );
  }

  const when = new Date(item.createdAt);
  const dateLine = when.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" }) +
    " · " + when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const info = el(
    "div",
    { class: "grow", style: "min-width:0" },
    el("div", { style: "font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" }, `@${item.uploader}`),
    el("div", { class: "sub", style: "margin:0" }, `${dateLine} · ${fmtBytes(item.size)}${item.durationMs ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : ""}`),
    el("div", { class: "sub", style: "margin:0;color:var(--accent)" }, item.place ? `📍 ${item.place}` : item.lat != null ? `📍 ${item.lat.toFixed(4)}, ${item.lon!.toFixed(4)}` : "📍 Location not captured"),
  );

  const dlBtn = el("button", { class: "btn small" }, "⬇️ Download");
  dlBtn.addEventListener("click", () => downloadItem(item));

  const bar = el(
    "div",
    { class: "bar" },
    el("button", { class: "icon-btn", onClick: close }, "✕"),
    info,
    dlBtn,
    opts.canDelete
      ? el(
          "button",
          {
            class: "icon-btn",
            onClick: async () => {
              if (await confirmDialog("Delete this item?", "This removes it for everyone in the album.")) {
                close();
                await opts.onDelete();
              }
            },
          },
          "🗑️",
        )
      : null,
  );

  view.append(mediaNode, bar);
  view.addEventListener("click", (e) => {
    if (e.target === view) close();
  });
  document.body.style.overflow = "hidden";
  document.body.append(view);
}
