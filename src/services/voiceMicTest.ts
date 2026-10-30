import {
  isBluetoothMicLabel,
  isMicPermissionDenial,
  openChosenMic,
  type OpenedMic,
} from "./voiceMicDevices";
import { MIC_LIVE_PEAK_THRESHOLD } from "./voiceStartDiagnostics";

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
  /** Set when a specific mic was requested but the system default opened instead. */
  substituted: boolean;
  bluetooth: boolean;
}

export interface MicTestHandle {
  opened: MicTestOpened;
  stop: () => void;
}

/** Why a test stopped on its own: its time limit, or the device stopped sending. */
export type MicTestEndReason = "time-limit" | "device-ended";

export interface MicTestOptions {
  /** Empty for the system default. */
  deviceId: string;
  /** The name saved with `deviceId`, to find the mic again if its id changed. */
  deviceLabel?: string;
  onSample: (sample: MicTestSample) => void;
  /** Called once if the stream ends or the test hits its time limit, after release. */
  onEnded: (reason: MicTestEndReason) => void;
  /**
   * False once the caller has moved on (stopped, hidden, or picked another mic),
   * so no second mic is opened and a late one is let go before it is measured.
   */
  isCurrent?: () => boolean;
}

export const SILENCE_AFTER_MS = 3000;
export const MAX_TEST_MS = 60_000;
const TICK_MS = 50;
// The same liveness bar dictation uses: above the exact zeros a muted or
// profile-switching headset delivers.
const SOUND_PEAK = MIC_LIVE_PEAK_THRESHOLD;
const FLOOR_DB = -60;

export function levelFromPeak(peak: number): number {
  if (!(peak > 0)) return 0;
  const db = 20 * Math.log10(peak);
  return Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB));
}

/**
 * Opens the chosen mic, by the same rules dictation does, and reports its level
 * locally. Nothing is recorded or sent anywhere; the stream is released by
 * `stop`, the time limit, or the track ending. Rejects with a `MicTestFailure`.
 */
export async function startMicTest(options: MicTestOptions): Promise<MicTestHandle> {
  const { deviceId, deviceLabel, onSample, onEnded, isCurrent } = options;
  let mic: OpenedMic;
  try {
    mic = await openChosenMic(deviceId, { canFallBack: isCurrent, chosenLabel: deviceLabel });
  } catch (err) {
    throw (isMicPermissionDenial(err) ? "denied" : "unavailable") satisfies MicTestFailure;
  }
  const { stream } = mic;
  if (isCurrent?.() === false) {
    stream.getTracks().forEach((t) => t.stop());
    throw "unavailable" satisfies MicTestFailure;
  }

  const track = stream.getAudioTracks()[0];
  const label = mic.label ?? "";
  const opened: MicTestOpened = {
    label,
    substituted: mic.substituted,
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
    if (release()) onEnded("device-ended");
  };

  try {
    context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);
    // Counted in ticks that ran with the context processing, so a suspended
    // context's frozen zeros never read as a silent mic.
    let runningMs = 0;
    let heardSound = false;
    void context.resume().catch(() => {});

    timer = setInterval(() => {
      if (context?.state !== "running") return;
      runningMs += TICK_MS;
      analyser.getFloatTimeDomainData(buffer);
      let peak = 0;
      for (let i = 0; i < buffer.length; i++) peak = Math.max(peak, Math.abs(buffer[i]!));
      if (peak > SOUND_PEAK) heardSound = true;
      onSample({
        level: levelFromPeak(peak),
        heardSound,
        silent: !heardSound && runningMs >= SILENCE_AFTER_MS,
      });
    }, TICK_MS);
    limit = setTimeout(() => {
      if (release()) onEnded("time-limit");
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
