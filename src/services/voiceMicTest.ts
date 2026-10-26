import { isBluetoothMicLabel } from "./voiceMicDevices";

export type MicTestFailure = "denied" | "unavailable";

export interface MicTestSample {
  /** 0–1 on a decibel scale, so quiet speech still moves the meter. */
  level: number;
  /** Sound has reached the mic since the test began. */
  heardSound: boolean;
  /** The test has run `SILENCE_AFTER_MS` without ever hearing sound. */
  silent: boolean;
}

export interface MicTestOpened {
  /** The mic that actually opened, which can differ from the one asked for. */
  label: string;
  /** Set when a specific mic was requested but the browser opened another. */
  substituted: boolean;
  bluetooth: boolean;
}

export interface MicTestHandle {
  opened: MicTestOpened;
  stop: () => void;
}

export interface MicTestOptions {
  /** Empty for the system default. */
  deviceId: string;
  onSample: (sample: MicTestSample) => void;
  /** Called once if the stream ends or the test hits its time limit, after release. */
  onEnded: () => void;
}

export const SILENCE_AFTER_MS = 3000;
export const MAX_TEST_MS = 60_000;
const TICK_MS = 50;
// Roughly -54 dBFS peak: above the exact zeros a muted or profile-switching
// headset delivers, below a quiet room's noise floor.
const SOUND_PEAK = 0.002;
const FLOOR_DB = -60;

export function levelFromPeak(peak: number): number {
  if (!(peak > 0)) return 0;
  const db = 20 * Math.log10(peak);
  return Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB));
}

function isSpecific(deviceId: string): boolean {
  return deviceId !== "" && deviceId !== "default" && deviceId !== "communications";
}

/**
 * Opens the chosen mic and reports its level locally. Nothing is recorded or
 * sent anywhere; the stream is released by `stop`, the time limit, or the track
 * ending. Rejects with a `MicTestFailure`.
 */
export async function startMicTest(options: MicTestOptions): Promise<MicTestHandle> {
  const { deviceId, onSample, onEnded } = options;
  let stream: MediaStream;
  try {
    // `ideal`, as dictation asks, so the test falls back exactly where it would.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: isSpecific(deviceId) ? { deviceId: { ideal: deviceId } } : true,
      video: false,
    });
  } catch (err) {
    throw (
      err instanceof DOMException && err.name === "NotAllowedError" ? "denied" : "unavailable"
    ) satisfies MicTestFailure;
  }

  const track = stream.getAudioTracks()[0];
  const actualId = track?.getSettings?.().deviceId;
  const label = track?.label ?? "";
  const opened: MicTestOpened = {
    label,
    substituted: isSpecific(deviceId) && !!actualId && actualId !== deviceId,
    bluetooth: isBluetoothMicLabel(label),
  };

  let context: AudioContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let limit: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const release = () => {
    if (stopped) return false;
    stopped = true;
    if (timer) clearInterval(timer);
    if (limit) clearTimeout(limit);
    track?.removeEventListener?.("ended", onTrackEnded);
    stream.getTracks().forEach((t) => t.stop());
    void context?.close().catch(() => {});
    return true;
  };
  const onTrackEnded = () => {
    if (release()) onEnded();
  };

  try {
    context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);
    const startedAt = performance.now();
    let heardSound = false;

    timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buffer);
      let peak = 0;
      for (let i = 0; i < buffer.length; i++) peak = Math.max(peak, Math.abs(buffer[i]!));
      if (peak > SOUND_PEAK) heardSound = true;
      onSample({
        level: levelFromPeak(peak),
        heardSound,
        silent: !heardSound && performance.now() - startedAt >= SILENCE_AFTER_MS,
      });
    }, TICK_MS);
    limit = setTimeout(() => {
      if (release()) onEnded();
    }, MAX_TEST_MS);
    track?.addEventListener?.("ended", onTrackEnded);
  } catch {
    release();
    throw "unavailable" satisfies MicTestFailure;
  }

  return {
    opened,
    stop: () => {
      release();
    },
  };
}
