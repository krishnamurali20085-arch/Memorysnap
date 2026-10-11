export type ShutterHandle = {
  stop: () => void;
};

// Maps the app's 40..100 "dB" slider to an RMS threshold.
// Empirically: quiet room RMS ~0.005-0.02, loud cheer ~0.1-0.4.
function thresholdFromDb(db: number): number {
  const clamped = Math.min(100, Math.max(40, db));
  // 40 dB -> very sensitive (0.008), 100 dB -> deaf (0.5)
  return 0.008 * Math.pow(0.5 / 0.008, (clamped - 40) / 60);
}

export async function startSoundShutter(
  getSensitivityDb: () => number,
  onFire: () => void,
  onLevel?: (norm: number, firing: boolean) => void,
): Promise<ShutterHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);

  let cooldownUntil = 0;
  let stopped = false;
  let smoothed = 0;

  const tick = () => {
    if (stopped) return;
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    smoothed = smoothed * 0.7 + rms * 0.3;
    const now = Date.now();
    const firing = smoothed > thresholdFromDb(getSensitivityDb()) && now > cooldownUntil;
    if (firing) {
      cooldownUntil = now + 1500;
      onFire();
    }
    onLevel?.(Math.min(1, smoothed / 0.35), firing);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  return {
    stop: () => {
      stopped = true;
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}
