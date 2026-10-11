import { uploadBlob } from "../api";
import { enqueue, pump } from "../outbox";
import { getGeo } from "../geo";
import { audioDurationMs, photoThumb, pickFile, videoThumb } from "../media";
import { getDisplayName, getAlbum, getSettings, saveSettings } from "../store";
import { el, modal, toast } from "../ui";

type FlashMode = "auto" | "on" | "off";

async function deliver(
  albumId: string,
  kind: "photo" | "video" | "audio",
  blob: Blob,
  extra: { thumb?: Blob; width?: number; height?: number; durationMs?: number },
  onDone: () => void,
) {
  const entry = getAlbum(albumId);
  if (!entry) {
    toast("Album not found on this device");
    return;
  }
  const uploaderToken = entry.uploaderToken;
  const uploader = getDisplayName();
  const geo = await getGeo();
  const geoExtra = geo ? { lat: geo.lat, lon: geo.lon, place: geo.place ?? undefined } : {};
  if (getSettings().syncEnabled && navigator.onLine) {
    try {
      await uploadBlob(albumId, kind, blob, {
        thumbBlob: extra.thumb,
        width: extra.width,
        height: extra.height,
        durationMs: extra.durationMs,
        uploaderToken,
        uploader,
        ...geoExtra,
      });
      toast(kind === "photo" ? "📸 Shared!" : kind === "video" ? "🎬 Video shared!" : "🎵 Audio shared!");
      onDone();
      return;
    } catch (e) {
      toast(`Upload failed (${e instanceof Error ? e.message : "network"}) — queued`);
    }
  }
  await enqueue({
    qid: crypto.randomUUID(),
    albumId,
    kind,
    blob,
    thumb: extra.thumb,
    width: extra.width,
    height: extra.height,
    durationMs: extra.durationMs,
    uploaderToken,
    uploader,
    lat: geo?.lat,
    lon: geo?.lon,
    place: geo?.place ?? undefined,
    attempts: 0,
    createdAt: Date.now(),
  });
  toast("Saved to queue — will sync automatically");
  pump();
}

export async function uploadFlow(albumId: string, onDone: () => void) {
  const kindChoice = el("div", { class: "seg" });
  let kind: "photo" | "video" | "audio" = "photo";
  const options: [string, "photo" | "video" | "audio"][] = [
    ["📷 Photo", "photo"],
    ["🎬 Video", "video"],
    ["🎵 Audio", "audio"],
  ];
  const buttons = options.map(([label, value]) => {
    const b = el("button", { class: value === kind ? "on" : "" }, label);
    b.addEventListener("click", () => {
      kind = value;
      buttons.forEach((x, i) => x.classList.toggle("on", options[i][1] === kind));
    });
    return b;
  });
  kindChoice.append(...buttons);
  const progress = el("div", { class: "progress", style: "display:none;margin-top:0.9rem" }, el("i"));
  const pick = el("button", { class: "btn block", style: "margin-top:0.9rem" }, "Choose file") as HTMLButtonElement;
  const m = modal("Add files", kindChoice, el("p", { class: "sub" }, "Files upload straight to storage — no size limit."), progress, pick);
  void toast("No size limit — big videos are fine", 2000);
  pick.addEventListener("click", async () => {
    const accept = kind === "photo" ? "image/*" : kind === "video" ? "video/*" : "audio/*";
    const file = await pickFile(accept);
    if (!file) return;
    m.close();
    toast(`Uploading ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)…`, 6000);
    let extra: { thumb?: Blob; width?: number; height?: number; durationMs?: number } = {};
    if (kind === "photo") {
      const t = await photoThumb(file).catch(() => null);
      if (t) extra = { thumb: t.blob, width: t.width, height: t.height };
    } else if (kind === "video") {
      const t = await videoThumb(file).catch(() => null);
      if (t) extra = { thumb: t.blob, width: t.width, height: t.height, durationMs: t.durationMs };
    } else {
      extra = { durationMs: await audioDurationMs(file) };
    }
    await deliver(albumId, kind, file, extra, onDone);
  });
}

// Kept for the outbox type: geo fields ride along with queued uploads.

export async function openCamera(albumId: string, onDone: () => void) {
  const settings = getSettings();
  let mode: "photo" | "video" | "audio" = "photo";
  let flashMode: FlashMode = "auto";
  let manual = false;
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let recChunks: Blob[] = [];
  let soundOn = false;
  let torchOn = false;
  let soundHandle: { stop: () => void } | null = null;
  let orientationHandler: ((e: DeviceOrientationEvent) => void) | null = null;

  const screen = el("div", { class: "camera-screen" });
  const video = el("video", { class: "feed", autoplay: true, playsinline: true, muted: true }) as HTMLVideoElement;
  const audioFace = el(
    "div",
    { class: "grow", style: "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1rem" },
    el("div", { style: "font-size:3.5rem" }, "🎙️"),
    el("div", { class: "sub" }, "Audio recorder"),
  );
  const levelMeter = el("div", { class: "level-meter", style: "width:70%;max-width:320px;display:none" }, el("i"));
  const top = el("div", { class: "cam-top" });
  const bottom = el("div", { class: "cam-bottom" });
  const flashOverlay = el("div", { class: "flash-overlay" });

  const closeBtn = el("button", { class: "icon-btn", style: "background:rgba(0,0,0,0.5)" }, "✕");
  const modeSeg = el("div", { class: "seg", style: "background:rgba(0,0,0,0.5);width:min(300px,80%)" });
  const modeBtns = (["Photo", "Video", "Audio"] as const).map((m) => {
    const b = el("button", { class: m === "Photo" ? "on" : "" }, m);
    b.addEventListener("click", () => {
      mode = m.toLowerCase() as typeof mode;
      modeBtns.forEach((x, i) => x.classList.toggle("on", (["photo", "video", "audio"] as const)[i] === mode));
      void startStream();
    });
    return b;
  });
  modeSeg.append(...modeBtns);
  top.append(closeBtn, modeSeg);

  const flashBtn = el("button", { class: "icon-btn", style: "background:rgba(0,0,0,0.5)" }, "⚡A");
  const soundBtn = el("button", { class: "icon-btn", style: "background:rgba(0,0,0,0.5)" }, "🔇");
  const manualBtn = el("button", { class: "icon-btn", style: "background:rgba(0,0,0,0.5)" }, "✋");
  const sensText = el("span", { style: "font-size:0.75rem;color:var(--text-dim)" }, `${settings.sensitivity} dB`);
  const sensSlider = el("input", { type: "range", min: "40", max: "100", step: "1", value: String(settings.sensitivity), style: "width:140px" }) as HTMLInputElement;
  sensSlider.addEventListener("input", () => {
    const v = Number(sensSlider.value);
    saveSettings({ sensitivity: v });
    sensText.textContent = `${v} dB`;
    sensSlider.style.setProperty("--fill", `${((v - 40) / 60) * 100}%`);
  });
  sensSlider.style.setProperty("--fill", `${((settings.sensitivity - 40) / 60) * 100}%`);

  const shutter = el("button", { class: "shutter" }, el("div", { class: "inner" }));
  const side = el("div", { class: "row", style: "width:100%;justify-content:space-between;align-items:center" }, flashBtn, soundBtn, manualBtn);
  bottom.append(levelMeter, side, el("div", { class: "row", style: "gap:0.5rem" }, sensText, sensSlider), shutter);

  screen.append(video, audioFace, top, bottom, flashOverlay);

  function screenFlash() {
    if (!getSettings().screenFlash) return;
    flashOverlay.classList.add("on");
    setTimeout(() => flashOverlay.classList.remove("on"), 110);
  }

  async function ensureAudioStream() {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  }

  async function startStream() {
    stopStream();
    try {
      if (mode === "audio") {
        video.style.display = "none";
        audioFace.style.display = "flex";
        stream = await ensureAudioStream();
      } else {
        video.style.display = "";
        audioFace.style.display = "none";
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "environment",
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: mode === "video",
        });
        video.srcObject = stream;
        await video.play().catch(() => {});
      }
    } catch (e) {
      toast(e instanceof Error && e.message.includes("denied") ? "Camera/microphone permission denied" : "Camera unavailable");
    }
  }

  function stopStream() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  async function capturePhoto() {
    if (!stream || mode !== "photo" || !video.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    if (torchOn) {
      /* torch stays on during capture via track constraint */
    }
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/jpeg", 0.85),
    );
    screenFlash();
    const t = await photoThumb(blob).catch(() => null);
    await deliver(albumId, "photo", blob, t ? { thumb: t.blob, width: t.width, height: t.height } : {}, onDone);
  }

  function startRecording() {
    if (!stream) return;
    recChunks = [];
    const candidates =
      mode === "video"
        ? ["video/mp4;codecs=avc1", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
        : ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
    const mimeType = candidates.find((c) => MediaRecorder.isTypeSupported(c));
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    recorder.ondataavailable = (e) => {
      if (e.data.size) recChunks.push(e.data);
    };
    recorder.onstop = async () => {
      shutter.classList.remove("rec");
      const type = recorder?.mimeType || (mode === "video" ? "video/webm" : "audio/webm");
      const blob = new Blob(recChunks, { type });
      recChunks = [];
      screenFlash();
      if (mode === "video") {
        const t = await videoThumb(blob).catch(() => null);
        await deliver(
          albumId,
          "video",
          blob,
          t ? { thumb: t.blob, width: t.width, height: t.height, durationMs: t.durationMs } : {},
          onDone,
        );
      } else {
        await deliver(albumId, "audio", blob, { durationMs: await audioDurationMs(blob) }, onDone);
      }
    };
    recorder.start();
    shutter.classList.add("rec");
    if (mode === "video") toast("Recording…", 2000);
  }

  function stopRecording() {
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }

  async function toggleTorch() {
    const track = stream?.getVideoTracks()[0];
    if (!track) return;
    const caps = track.getCapabilities?.() as MediaTrackCapabilities & { torch?: boolean };
    if (!caps?.torch) {
      toast("Torch not supported on this device");
      return;
    }
    torchOn = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: torchOn }] } as unknown as MediaTrackConstraints);
      flashBtn.textContent = torchOn ? "💡" : flashMode === "auto" ? "⚡A" : flashMode === "on" ? "⚡" : "⚡✕";
    } catch {
      toast("Could not control flash");
    }
  }

  flashBtn.addEventListener("click", () => {
    flashMode = flashMode === "auto" ? "on" : flashMode === "on" ? "off" : "auto";
    flashBtn.textContent = flashMode === "auto" ? "⚡A" : flashMode === "on" ? "⚡" : "⚡✕";
    if (flashMode === "off" && torchOn) void toggleTorch();
  });

  soundBtn.addEventListener("click", async () => {
    if (soundOn) {
      soundHandle?.stop();
      soundHandle = null;
      soundOn = false;
      soundBtn.textContent = "🔇";
      levelMeter.style.display = "none";
      return;
    }
    if (mode !== "photo") {
      toast("Sound shutter works in Photo mode");
      return;
    }
    try {
      const { startSoundShutter } = await import("../shutter");
      soundHandle = await startSoundShutter(
        () => getSettings().sensitivity,
        () => void capturePhoto(),
        (norm, firing) => {
          const fill = levelMeter.firstElementChild as HTMLElement;
          fill.style.width = `${Math.round(norm * 100)}%`;
          if (firing) fill.style.background = "var(--pink)";
          else fill.style.background = "";
        },
      );
      soundOn = true;
      soundBtn.textContent = "🔊";
      levelMeter.style.display = "";
      toast("Sound shutter on — laugh or clap!");
    } catch {
      toast("Microphone permission needed for sound shutter");
    }
  });

  async function toggleManual() {
    manual = !manual;
    manualBtn.textContent = manual ? "🖐️" : "✋";
    shutter.classList.toggle("free", manual);
    if (manual) {
      try {
        const doe = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
        if (typeof doe.requestPermission === "function") {
          const res = await doe.requestPermission();
          if (res !== "granted") {
            manual = false;
            shutter.classList.remove("free");
            manualBtn.textContent = "✋";
            toast("Motion permission denied");
            return;
          }
        }
      } catch {
        /* desktop / unsupported */
      }
      orientationHandler = (e: DeviceOrientationEvent) => {
        const gamma = Math.max(-45, Math.min(45, e.gamma ?? 0)); // left-right tilt
        const pct = (gamma + 45) / 90; // 0..1
        const leftPct = 6 + pct * 62;
        shutter.style.left = `${leftPct}%`;
        shutter.style.bottom = `calc(${14 + Math.abs(gamma) / 6}% + env(safe-area-inset-bottom))`;
      };
      window.addEventListener("deviceorientation", orientationHandler);
      toast("Tilt your phone — the shutter follows your thumb");
    } else if (orientationHandler) {
      window.removeEventListener("deviceorientation", orientationHandler);
      orientationHandler = null;
      shutter.style.left = "";
      shutter.style.bottom = "";
    }
  }
  manualBtn.addEventListener("click", () => void toggleManual());

  shutter.addEventListener("click", () => {
    if (mode === "photo") void capturePhoto();
    else if (recorder && recorder.state === "recording") stopRecording();
    else startRecording();
  });

  closeBtn.addEventListener("click", () => teardown());

  function teardown() {
    if (recorder && recorder.state !== "recording") {
      /* noop */
    }
    stopRecording();
    soundHandle?.stop();
    if (orientationHandler) window.removeEventListener("deviceorientation", orientationHandler);
    stopStream();
    screen.remove();
    document.body.style.overflow = "";
  }

  document.body.style.overflow = "hidden";
  document.body.append(screen);
  void startStream();
}
