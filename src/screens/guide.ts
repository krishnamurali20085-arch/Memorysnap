import { el } from "../ui";

type Section = {
  tag: string;
  icon: string;
  title: string;
  body: string;
  steps: string[];
};

const SECTIONS: Section[] = [
  {
    tag: "Core Feature",
    icon: "🎙️",
    title: "1. Sound-Activated Auto Shutter",
    body: "The smartphone microphone automatically detects laughter, cheers, applause, or party poppers and snaps photos of natural smiles without touching the phone.",
    steps: [
      'Open an album and tap "Shoot", then grant camera/mic permissions.',
      "Place the smartphone on a stand in the center of the party or table.",
      "Tap the 🔇 button to arm the sound shutter and adjust the sensitivity slider (dB) to your room volume — it triggers automatically on loud moments!",
    ],
  },
  {
    tag: "Versatile",
    icon: "📷",
    title: "2. Free-Hand Dynamic Manual Camera",
    body: "Want to capture specific shots yourself? Use manual mode where the shutter button automatically moves to the most ergonomic thumb position as you tilt your phone.",
    steps: [
      'Tap "Shoot" to open the full-screen viewfinder, then tap ✋ for manual mode.',
      "Rotate portrait, landscape, or inverted — the shutter button stays under your thumb.",
      "Tap ⚡ to toggle flash modes (Auto, On, Off) with a single tap.",
    ],
  },
  {
    tag: "Media",
    icon: "🎬",
    title: "3. Photos, Videos & Audio — No Size Limit",
    body: "Record video and audio right in the camera, or upload existing files. Uploads go straight to storage, so there is no app-imposed size limit — only your device storage and cloud storage matter.",
    steps: [
      'Switch the camera between Photo, Video, and Audio modes.',
      'Use "Add files" in the album to upload existing videos or audio recordings.',
      "Large uploads keep syncing in the background, even if you leave the album.",
    ],
  },
  {
    tag: "Easy & Secure",
    icon: "👥",
    title: "4. Real-time Sharing & Access Security",
    body: "Invite friends using a 6-digit code. Set an optional access PIN and deletion permissions to keep your party memories safe.",
    steps: [
      "Share the generated 6-digit code so guests can join from their own devices.",
      "Set a PIN for private gatherings — only authenticated guests can view and shoot.",
      "Configure deletion permissions (Everyone, Host Only, or Uploader Only) to prevent accidental loss.",
    ],
  },
  {
    tag: "Privacy First",
    icon: "♾️",
    title: "5. Albums That Never Expire & Batch Download",
    body: "Every album lasts forever — no 24h or 48h timers, no auto-disappear. Your memories stay until YOU delete them. Download any single photo, video, or audio from its detail screen, or grab everything at once as a zip.",
    steps: [
      "Tap any item in the feed to open it full-screen, then tap Download.",
      "Use the ⬇️ button on a tile for a one-tap download.",
      'Tap "All" in the album to download the entire album as a zip file.',
    ],
  },
];

export function renderGuide(root: HTMLElement) {
  const screen = el(
    "div",
    { class: "screen" },
    el("h1", {}, "User Guide"),
    el("p", { class: "sub" }, "Master ForeverSnap in simple steps"),
    el(
      "div",
      { class: "card", style: "text-align:center" },
      el("div", { style: "font-size:1.8rem" }, "🎉"),
      el("h2", { style: "margin-top:0.4rem" }, "Get Started in 3 Easy Steps!"),
      el("p", { class: "sub", style: "margin-bottom:0" }, "1. Create Album → 2. Share Invite Code → 3. Start Shooting!"),
    ),
  );

  for (const s of SECTIONS) {
    screen.append(
      el(
        "div",
        { class: "card" },
        el("span", { class: "pill" }, s.tag),
        el(
          "div",
          { class: "row", style: "margin-top:0.6rem;align-items:flex-start" },
          el("div", { class: "icon-btn", style: "width:44px;height:44px;font-size:1.2rem" }, s.icon),
          el("h2", { class: "grow" }, s.title),
        ),
        el("p", { class: "sub", style: "margin-top:0.6rem" }, s.body),
        ...s.steps.map((step, i) => el("div", { class: "guide-step" }, el("div", { class: "n" }, String(i + 1)), el("div", {}, step))),
      ),
    );
  }

  root.append(screen);
}
