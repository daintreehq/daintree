/* eslint-disable @typescript-eslint/no-explicit-any -- window.electron is untyped in Playwright evaluate() */
import type { Page } from "@playwright/test";
import type { MicProcessing } from "./voiceReplayConfig";
import type { MicTrackProcessing, SessionTiming } from "./voiceReplayScore";

/** One voice event as the renderer saw it, stamped with `performance.now()`. */
export type ReplayEvent =
  | { t: number; kind: "status"; sessionId: string; status: string }
  | { t: number; kind: "delta"; sessionId: string; text: string }
  | { t: number; kind: "complete"; sessionId: string; text: string }
  | { t: number; kind: "ended"; sessionId: string; reason: string }
  | { t: number; kind: "error"; sessionId: string; message: string };

export interface ReplayCapture {
  events: ReplayEvent[];
  /** When each getUserMedia call resolved. */
  micOpens: number[];
  /** What each opened track reported running, beside `micOpens`. */
  micProcessing: MicTrackProcessing[];
}

/**
 * Records every voice event with the session it belongs to, and when the
 * microphone opened, on the renderer's clock. Install it on the project view's
 * page: main sends a session's events only to the view that started it. With
 * `micProcessing: "off"` it also turns Chromium's processing off in every
 * microphone request the app makes, keeping the rest of the request.
 */
export async function installReplayCapture(
  page: Page,
  { micProcessing = "default" }: { micProcessing?: MicProcessing } = {}
): Promise<void> {
  await page.evaluate((processingOff) => {
    const w = window as any;
    if (w.__voiceReplay__) return;
    const capture = {
      events: [] as unknown[],
      micOpens: [] as number[],
      micProcessing: [] as unknown[],
    };
    w.__voiceReplay__ = capture;
    const push = (event: Record<string, unknown>) =>
      capture.events.push({ t: performance.now(), ...event });
    const v = w.electron.voiceInput;
    v.onStatus((p: { sessionId: string; status: string }) =>
      push({ kind: "status", sessionId: p.sessionId, status: p.status })
    );
    v.onTranscriptionDelta((p: { sessionId: string; text: string }) =>
      push({ kind: "delta", sessionId: p.sessionId, text: p.text })
    );
    v.onTranscriptionComplete((p: { sessionId: string; text: string }) =>
      push({ kind: "complete", sessionId: p.sessionId, text: p.text })
    );
    v.onSessionEnded((p: { sessionId: string; reason: string }) =>
      push({ kind: "ended", sessionId: p.sessionId, reason: p.reason })
    );
    v.onError((p: { sessionId: string; error: { message?: string } | string }) =>
      push({
        kind: "error",
        sessionId: p.sessionId,
        message: typeof p.error === "string" ? p.error : (p.error?.message ?? "unknown error"),
      })
    );
    const media = navigator.mediaDevices;
    const getUserMedia = media.getUserMedia.bind(media);
    media.getUserMedia = async (constraints?: MediaStreamConstraints) => {
      const audio = constraints?.audio;
      const asked =
        processingOff && audio
          ? {
              ...constraints,
              audio: {
                ...(typeof audio === "object" ? audio : {}),
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
              },
            }
          : constraints;
      const stream = await getUserMedia(asked);
      capture.micOpens.push(performance.now());
      const track = stream.getAudioTracks()[0];
      const reported: MediaTrackSettings = track?.getSettings?.() ?? {};
      capture.micProcessing.push({
        echoCancellation: reported.echoCancellation,
        noiseSuppression: reported.noiseSuppression,
        autoGainControl: reported.autoGainControl,
      });
      return stream;
    };
  }, micProcessing === "off");
}

export async function readReplayCapture(page: Page): Promise<ReplayCapture> {
  return await page.evaluate(
    () => JSON.parse(JSON.stringify((window as any).__voiceReplay__)) as ReplayCapture
  );
}

/** The renderer's clock now, for stamping a key press in the same timebase as the capture. */
export async function rendererNow(page: Page): Promise<number> {
  return await page.evaluate(() => performance.now());
}

/** The first microphone open at or after `since`, or null while there is none yet. */
export function micOpenedAfter(capture: ReplayCapture, since: number): number | null {
  return capture.micOpens.find((t) => t >= since) ?? null;
}

const PROCESSING_KEYS = ["echoCancellation", "noiseSuppression", "autoGainControl"] as const;

/** What the first microphone opened at or after `since` reported running. */
export function micProcessingAfter(
  capture: ReplayCapture,
  since: number
): MicTrackProcessing | null {
  const index = capture.micOpens.findIndex((t) => t >= since);
  return index < 0 ? null : (capture.micProcessing[index] ?? null);
}

/**
 * Why the session's microphone didn't run with the processing the config
 * turned off, or null. Only a track that reports each one off counts: one it
 * doesn't report may have been ignored. The default arm is whatever Chromium
 * does, so it has nothing to miss.
 */
export function micProcessingMismatch(
  capture: ReplayCapture,
  since: number,
  asked: MicProcessing
): string | null {
  if (asked !== "off") return null;
  const reported = micProcessingAfter(capture, since);
  if (!reported) return null;
  const on = PROCESSING_KEYS.filter((key) => reported[key] === true);
  if (on.length > 0) return `microphone processing stayed on: ${on.join(", ")}`;
  const unreported = PROCESSING_KEYS.filter((key) => reported[key] !== false);
  return unreported.length > 0
    ? `microphone processing unconfirmed: ${unreported.join(", ")} not reported`
    : null;
}

/** The session started at `startAt`: the first session id seen after the press. */
export function sessionIdAfter(capture: ReplayCapture, startAt: number): string | null {
  return capture.events.find((event) => event.t >= startAt)?.sessionId ?? null;
}

export interface ReplaySessionMarks {
  startAt: number;
  stopAt: number | null;
  /** When the clip was due to end: the planned stop. */
  plannedStopAt: number | null;
  audioMs: number;
}

export interface DerivedSession {
  sessionId: string | null;
  hypothesis: string;
  timing: SessionTiming;
  statuses: string[];
  endReason: string | null;
  errors: string[];
}

/**
 * Reduces the capture to one session: its final transcripts joined in arrival
 * order (each complete is a segment, not a running total) and its timings
 * relative to the start press.
 */
export function deriveSession(capture: ReplayCapture, marks: ReplaySessionMarks): DerivedSession {
  const sessionId = sessionIdAfter(capture, marks.startAt);
  const events = sessionId ? capture.events.filter((e) => e.sessionId === sessionId) : [];
  const since = (t: number | null | undefined) =>
    t === null || t === undefined ? null : Math.round(t - marks.startAt);
  const after = (t: number | null | undefined, from: number | null) =>
    t === null || t === undefined || from === null ? null : Math.round(t - from);

  const completes = events.filter(
    (e): e is Extract<ReplayEvent, { kind: "complete" }> => e.kind === "complete"
  );
  const finals = completes.filter((e) => e.text.trim().length > 0);
  const firstDelta = events.find((e) => e.kind === "delta" && e.text.trim().length > 0);
  const recording = events.find((e) => e.kind === "status" && e.status === "recording");
  const ended = events.find(
    (e): e is Extract<ReplayEvent, { kind: "ended" }> => e.kind === "ended"
  );

  return {
    sessionId,
    hypothesis: finals
      .map((e) => e.text.trim())
      .join(" ")
      .replace(/\s+/g, " "),
    timing: {
      micOpenMs: since(micOpenedAfter(capture, marks.startAt)),
      recordingMs: since(recording?.t),
      firstDeltaMs: since(firstDelta?.t),
      firstFinalMs: since(finals[0]?.t),
      stopMs: since(marks.stopAt),
      stopLateMs: after(marks.stopAt, marks.plannedStopAt),
      stopToLastFinalMs: after(finals.at(-1)?.t, marks.stopAt),
      stopToEndedMs: after(ended?.t, marks.stopAt),
      audioMs: marks.audioMs,
    },
    statuses: events.flatMap((e) => (e.kind === "status" ? [e.status] : [])),
    endReason: ended?.reason ?? null,
    errors: events.flatMap((e) => (e.kind === "error" ? [e.message] : [])),
  };
}
