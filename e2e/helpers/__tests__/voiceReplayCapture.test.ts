import type { Page } from "@playwright/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveSession,
  installReplayCapture,
  micProcessingAfter,
  micProcessingMismatch,
  readReplayCapture,
  type ReplayCapture,
} from "../voiceReplayCapture";

const capture: ReplayCapture = {
  micOpens: [50, 1_120],
  micProcessing: [{}, {}],
  events: [
    // An earlier session's tail must not leak into this one.
    { t: 90, kind: "complete", sessionId: "old", text: "stale words" },
    { t: 1_010, kind: "status", sessionId: "s1", status: "connecting" },
    { t: 1_400, kind: "status", sessionId: "s1", status: "recording" },
    { t: 1_450, kind: "complete", sessionId: "s1", text: "  " },
    { t: 1_600, kind: "delta", sessionId: "s1", text: " " },
    { t: 1_700, kind: "delta", sessionId: "s1", text: "Run npm" },
    { t: 2_500, kind: "complete", sessionId: "s1", text: " Run npm test. " },
    { t: 2_600, kind: "complete", sessionId: "s1", text: "" },
    { t: 3_900, kind: "status", sessionId: "s1", status: "finishing" },
    { t: 4_300, kind: "complete", sessionId: "s1", text: "Then  push." },
    { t: 4_400, kind: "complete", sessionId: "s1", text: "" },
    { t: 4_500, kind: "error", sessionId: "s1", message: "drain timed out" },
    { t: 4_600, kind: "ended", sessionId: "s1", reason: "stopped" },
  ],
};

describe("deriveSession", () => {
  it("joins the session's non-empty finals in order and times them from the press", () => {
    // Blank finals before the first and after the last real one time nothing.
    const session = deriveSession(capture, {
      startAt: 1_000,
      stopAt: 4_000,
      plannedStopAt: 3_990,
      audioMs: 2_870,
    });
    expect(session.sessionId).toBe("s1");
    expect(session.hypothesis).toBe("Run npm test. Then push.");
    expect(session.timing).toEqual({
      micOpenMs: 120,
      recordingMs: 400,
      firstDeltaMs: 700,
      firstFinalMs: 1_500,
      stopMs: 3_000,
      stopLateMs: 10,
      stopToLastFinalMs: 300,
      stopToEndedMs: 600,
      audioMs: 2_870,
    });
    expect(session.statuses).toEqual(["connecting", "recording", "finishing"]);
    expect(session.endReason).toBe("stopped");
    expect(session.errors).toEqual(["drain timed out"]);
  });

  it("reports a last final before the stop as negative and a missing end as null", () => {
    const early: ReplayCapture = {
      micOpens: [10],
      micProcessing: [{}],
      events: [
        { t: 20, kind: "status", sessionId: "s2", status: "recording" },
        { t: 500, kind: "complete", sessionId: "s2", text: "done" },
      ],
    };
    const session = deriveSession(early, {
      startAt: 0,
      stopAt: 800,
      plannedStopAt: 800,
      audioMs: 700,
    });
    expect(session.timing.stopToLastFinalMs).toBe(-300);
    expect(session.timing.stopToEndedMs).toBeNull();
    expect(session.endReason).toBeNull();
  });

  it("returns an empty session when nothing arrived after the press", () => {
    const session = deriveSession(capture, {
      startAt: 9_000,
      stopAt: null,
      plannedStopAt: null,
      audioMs: 1,
    });
    expect(session.sessionId).toBeNull();
    expect(session.hypothesis).toBe("");
    expect(session.timing.micOpenMs).toBeNull();
  });
});

describe("micProcessingMismatch", () => {
  const opened = (micProcessing: ReplayCapture["micProcessing"]): ReplayCapture => ({
    micOpens: [50, 1_120],
    micProcessing,
    events: [],
  });
  const off = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

  it("accepts an off arm only when this session's track reports all three off", () => {
    expect(
      micProcessingMismatch(opened([{ noiseSuppression: true }, off]), 1_000, "off")
    ).toBeNull();
    expect(
      micProcessingMismatch(opened([off, { ...off, autoGainControl: true }]), 1_000, "off")
    ).toBe("microphone processing stayed on: autoGainControl");
  });

  it("calls a setting the track didn't report unconfirmed, not off", () => {
    const { autoGainControl: _, ...partial } = off;
    expect(micProcessingMismatch(opened([off, partial]), 1_000, "off")).toBe(
      "microphone processing unconfirmed: autoGainControl not reported"
    );
  });

  it("leaves the default arm and an unopened mic alone", () => {
    const processing = opened([{}, { echoCancellation: true }]);
    expect(micProcessingMismatch(processing, 1_000, "default")).toBeNull();
    expect(micProcessingMismatch(processing, 2_000, "off")).toBeNull();
  });
});

describe("installReplayCapture's microphone wrapper", () => {
  const page = {
    evaluate: async (fn: (arg?: unknown) => unknown, arg?: unknown) => fn(arg),
  } as unknown as Page;
  let getUserMedia: ReturnType<typeof vi.fn>;

  let reported: Record<string, unknown>;

  beforeEach(() => {
    reported = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    getUserMedia = vi.fn(async () => ({
      getAudioTracks: () => [{ getSettings: () => reported }],
    }));
    const noop = () => () => {};
    vi.stubGlobal("window", {
      electron: {
        voiceInput: {
          onStatus: noop,
          onTranscriptionDelta: noop,
          onTranscriptionComplete: noop,
          onSessionEnded: noop,
          onError: noop,
        },
      },
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("turns all three off in a plain request and records what the track ran", async () => {
    await installReplayCapture(page, { micProcessing: "off" });
    await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
    const capture = await readReplayCapture(page);
    expect(capture.micOpens).toHaveLength(1);
    expect(micProcessingAfter(capture, 0)).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
  });

  it("keeps the chosen device in a request it turns processing off in", async () => {
    await installReplayCapture(page, { micProcessing: "off" });
    await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { ideal: "mic-2" } },
      video: false,
    });
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        deviceId: { ideal: "mic-2" },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
  });

  it("saves what the track ran, not what was asked, so an ignored request shows", async () => {
    reported = { echoCancellation: false, autoGainControl: true, sampleRate: 48_000 };
    await installReplayCapture(page, { micProcessing: "off" });
    await navigator.mediaDevices.getUserMedia({ audio: true });
    const capture = await readReplayCapture(page);
    expect(micProcessingAfter(capture, 0)).toEqual({
      echoCancellation: false,
      noiseSuppression: undefined,
      autoGainControl: true,
    });
    expect(micProcessingMismatch(capture, 0, "off")).toBe(
      "microphone processing stayed on: autoGainControl"
    );
  });

  it("passes the app's own request through on the default arm", async () => {
    await installReplayCapture(page);
    const constraints = { audio: true, video: false };
    await navigator.mediaDevices.getUserMedia(constraints);
    expect(getUserMedia).toHaveBeenCalledWith(constraints);
  });
});
