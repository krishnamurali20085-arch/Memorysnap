import { el, toast } from "../ui";

const DONE_KEY = "fps:perms-onboarded";

export function onboardingDone(): boolean {
  return localStorage.getItem(DONE_KEY) === "1";
}

export function markOnboardingDone() {
  localStorage.setItem(DONE_KEY, "1");
}

type Perm = {
  key: string;
  icon: string;
  title: string;
  why: string;
  request: () => Promise<boolean>;
};

async function requestCamera(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}

async function requestMic(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}

async function requestLocation(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) return resolve(false);
    navigator.geolocation.getCurrentPosition(
      () => resolve(true),
      () => resolve(false),
      { timeout: 8000, maximumAge: 60000 },
    );
  });
}

async function requestMotion(): Promise<boolean> {
  try {
    const doe = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    if (typeof doe.requestPermission === "function") {
      return (await doe.requestPermission()) === "granted";
    }
    return true; // Android/desktop needs no explicit permission
  } catch {
    return false;
  }
}

const PERMISSIONS: Perm[] = [
  {
    key: "camera",
    icon: "📷",
    title: "Camera & photos",
    why: "So you can take photos and videos and share them live to the party album. Photos only leave your phone when you shoot inside an album.",
    request: requestCamera,
  },
  {
    key: "mic",
    icon: "🎙️",
    title: "Microphone",
    why: "Needed to record video sound, audio notes, and for the sound-activated shutter that snaps when the room cheers. The mic is only active while the camera screen is open.",
    request: requestMic,
  },
  {
    key: "location",
    icon: "📍",
    title: "Location",
    why: "Adds the place to each photo's info (username · time · date · place). Captured once per photo; deny it and photos still work, just without a place.",
    request: requestLocation,
  },
  {
    key: "motion",
    icon: "🔄",
    title: "Motion access (iPhone)",
    why: "Lets the shutter button follow your thumb as you tilt the phone in manual camera mode. Android needs no permission for this.",
    request: requestMotion,
  },
];

export async function runOnboarding(root: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    let index = 0;
    const screen = el("div", { class: "screen no-nav" });

    function render() {
      if (index >= PERMISSIONS.length) {
        markOnboardingDone();
        screen.replaceChildren(
          el("div", { class: "empty", style: "padding-top:4rem" },
            el("div", { class: "big" }, "🎉"),
            el("h2", {}, "You're all set!"),
            el("p", { class: "sub" }, "You can change any of these later in Settings."),
          ),
        );
        setTimeout(() => {
          screen.remove();
          resolve();
        }, 1200);
        return;
      }
      const p = PERMISSIONS[index];
      const status = el("div", { class: "sub", style: "min-height:1.2em" });
      screen.replaceChildren(
        el("div", { style: "padding-top:15vh;text-align:center" },
          el("div", { style: "font-size:3rem" }, p.icon),
          el("h1", { style: "margin-top:0.8rem" }, p.title),
          el("p", { class: "sub", style: "max-width:340px;margin:0.6rem auto 1.5rem" }, p.why),
          (() => {
            const allow = el("button", { class: "btn block", style: "max-width:340px;margin:0 auto" }, "Allow " + p.title.split(" ")[0]) as HTMLButtonElement;
            allow.addEventListener("click", async () => {
              allow.disabled = true;
              allow.replaceChildren(el("span", { class: "spin" }), "Waiting…");
              const granted = await p.request();
              status.textContent = granted ? "✅ Granted" : "❌ Denied — you can allow it later in Settings";
              if (!granted) {
                allow.replaceChildren("Try again");
                allow.disabled = false;
              }
              setTimeout(() => {
                index += 1;
                render();
              }, granted ? 500 : 1600);
            });
            return allow;
          })(),
          (() => {
            const skip = el("button", { class: "btn ghost block", style: "max-width:340px;margin:0.6rem auto 0" }, "Skip for now");
            skip.addEventListener("click", () => {
              index += 1;
              render();
            });
            return skip;
          })(),
          status,
        ),
      );
    }

    render();
    root.append(screen);
  });
}

export async function askPermission(perm: "camera" | "mic" | "location" | "motion"): Promise<boolean> {
  const p = PERMISSIONS.find((x) => x.key === perm);
  if (!p) return false;
  const granted = await p.request();
  toast(granted ? `${p.title}: granted` : `${p.title}: denied`, 2200);
  return granted;
}

export function permissionStatus(perm: "camera" | "mic" | "location" | "motion"): Promise<string> {
  const name = perm === "camera" ? "camera" : perm === "mic" ? "microphone" : perm === "location" ? "geolocation" : "accelerometer";
  if (!navigator.permissions) return Promise.resolve("unknown");
  return navigator.permissions
    .query({ name: name as PermissionName })
    .then((s) => s.state)
    .catch(() => "unknown");
}
