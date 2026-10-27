import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VOICE_SESSION_SUMMARY_MESSAGE } from "@shared/utils/voiceLogFields";
import { countPassageFates } from "../voiceCorrectionPassages";
import {
  VOICE_FRAME_WAIT_MS,
  VOICE_PRESS_WINDOW_MS,
  VOICE_REPORT_WAIT_MS,
  VoiceSessionTimeline,
} from "../voiceSessionTimeline";

const report = {
  provider: "deepgram",
  delayTier: "none",
  biasTermCount: 7,
  droppedPreStart: 2,
  droppedConnect: 3,
  droppedReplay: 0,
  reconnects: 1,
  completedSegments: 4,
  emptyCompletions: 1,
};

let clock = 0;
const log = vi.fn();
const warn = vi.fn();
const onDone = vi.fn();
const frames: Array<() => void> = [];

function timeline(pressedAt: number | null = null): VoiceSessionTimeline {
  return new VoiceSessionTimeline(
    "session-1",
    {
      now: () => clock,
      log,
      warn,
      nextFrame: (callback) => {
        frames.push(callback);
        return () => {
          const index = frames.indexOf(callback);
          if (index >= 0) frames.splice(index, 1);
        };
      },
      onDone,
    },
    pressedAt
  );
}

function logged(): Record<string, unknown> {
  expect(log).toHaveBeenCalledTimes(1);
  expect(log.mock.calls[0]![0]).toBe(VOICE_SESSION_SUMMARY_MESSAGE);
  return log.mock.calls[0]![1] as Record<string, unknown>;
}

beforeEach(() => {
  vi.useFakeTimers();
  clock = 1_000;
  frames.length = 0;
  log.mockReset();
  warn.mockReset();
  onDone.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("VoiceSessionTimeline", () => {
  it("measures every interval from the key press that led to the start", () => {
    const t = timeline(1_000 - 40);
    clock = 1_010;
    t.markNextFrame("cue");
    clock = 1_016;
    frames.shift()!();
    clock = 1_300;
    t.mark("micLive");
    clock = 2_500;
    t.mark("socketReady");
    clock = 2_900;
    t.mark("firstText");
    clock = 6_000;
    t.mark("stopRequested");
    clock = 6_450;
    t.mark("settled");
    t.finish("user");

    expect(logged()).toMatchObject({
      sessionId: "session-1",
      origin: "key",
      stopReason: "user",
      backendEnd: "none",
      cueMs: 56,
      micLiveMs: 340,
      socketReadyMs: 1_540,
      firstTextMs: 1_940,
      stopRequestedMs: 5_040,
      stopSettledMs: 450,
      correctionMs: null,
      correction: "none",
    });
    expect(onDone).toHaveBeenCalledWith(t);
  });

  it("falls back to start() entry when no press preceded it closely enough", () => {
    const t = timeline(1_000 - VOICE_PRESS_WINDOW_MS - 1);
    expect(t.notePress(1_001)).toBe(false);
    clock = 1_200;
    t.mark("micLive");
    t.finish("user");
    expect(logged()).toMatchObject({ origin: "call", micLiveMs: 200 });
  });

  it("takes a press reported after start() entry when it came first", () => {
    const t = timeline();
    expect(t.notePress(990)).toBe(true);
    clock = 1_100;
    t.mark("micLive");
    t.finish("key_release");
    expect(logged()).toMatchObject({ origin: "key", micLiveMs: 110 });
  });

  it("keeps the first mark and the first stop reason", () => {
    const t = timeline();
    t.expectReport();
    clock = 1_100;
    t.mark("firstText");
    clock = 1_500;
    t.mark("firstText");
    // Still waiting on main, so the second stop lands on a live timeline.
    t.finish("escape");
    t.finish("user");
    t.reportEnded("stopped", report);
    expect(logged()).toMatchObject({ firstTextMs: 100, stopReason: "escape" });
  });

  it("waits for main's report, then folds it in", () => {
    const t = timeline();
    t.expectReport();
    t.finish("user");
    expect(log).not.toHaveBeenCalled();

    t.reportEnded("stopped", report);
    expect(logged()).toMatchObject({ backendEnd: "stopped", ...report });
  });

  it("uses a report that arrived before the session finished", () => {
    const t = timeline();
    t.expectReport();
    t.reportEnded("superseded", report);
    expect(log).not.toHaveBeenCalled();
    t.finish("user");
    expect(logged()).toMatchObject({ backendEnd: "superseded", reconnects: 1 });
  });

  it("logs without main's side once its report is overdue", () => {
    const t = timeline();
    t.setProvider("openai");
    t.expectReport();
    t.finish("wake");
    vi.advanceTimersByTime(VOICE_REPORT_WAIT_MS - 1);
    expect(log).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(logged()).toMatchObject({
      backendEnd: "unreported",
      provider: "openai",
      delayTier: null,
      reconnects: null,
    });
    t.reportEnded("stopped", report);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("waits for the correction and records how it went", () => {
    const t = timeline();
    t.mark("stopRequested");
    t.beginCorrection();
    t.finish("send");
    expect(log).not.toHaveBeenCalled();
    clock = 1_850;
    t.endCorrection("applied", countPassageFates(["applied"]));
    expect(logged()).toMatchObject({ correctionMs: 850, correction: "applied" });
  });

  it("logs the fate of each passage sent, and none for a session without cleanup", () => {
    const none = timeline();
    none.finish("user");
    expect(logged().correctionPassages).toEqual(countPassageFates([]));

    log.mockClear();
    const t = timeline();
    t.beginCorrection();
    t.finish("user");
    t.endCorrection("discarded", countPassageFates(["applied", "rejected_number", "unlanded"]));
    expect(logged().correctionPassages).toMatchObject({
      sent: 3,
      applied: 1,
      rejectedNumber: 1,
      unlanded: 1,
    });
  });

  it("counts the chunks cleaned while the session ran apart from the stop-time pass", () => {
    const t = timeline();
    t.noteCorrectionChunk();
    t.noteCorrectionChunk();
    t.mark("stopRequested");
    t.beginCorrection();
    t.finish("user");
    clock = 1_600;
    t.endCorrection("applied");
    t.noteCorrectionChunk();
    expect(logged()).toMatchObject({ correctionChunks: 2, correctionMs: 600 });
  });

  it("reports no chunks for a session that never sent one", () => {
    const t = timeline();
    t.mark("stopRequested");
    t.finish("user");
    expect(logged()).toMatchObject({ correctionChunks: 0, correction: "none", correctionMs: null });
  });

  it("splits the correction into main's preparation, the round trip and applying it", () => {
    const t = timeline();
    t.mark("stopRequested");
    t.beginCorrection();
    t.finish("user");
    clock = 2_450;
    t.noteCorrectionReplies({ prepMs: 12.4, requestMs: 1_380.6 });
    clock = 2_470;
    t.endCorrection("applied", countPassageFates(["applied"]));
    expect(logged()).toMatchObject({
      correctionMs: 1_470,
      correctionPrepMs: 12,
      correctionRequestMs: 1_381,
      correctionApplyMs: 20,
    });
  });

  it("keeps main's parts out when its timing carries anything but durations", () => {
    const t = timeline();
    t.beginCorrection();
    t.finish("user");
    clock = 1_900;
    t.noteCorrectionReplies({ prepMs: 3, requestMs: 800, prompt: "fix the login bug" });
    clock = 1_910;
    t.endCorrection("applied", countPassageFates(["applied"]));
    const line = logged();
    expect(line).toMatchObject({
      correctionPrepMs: null,
      correctionRequestMs: null,
      correctionApplyMs: 10,
    });
    expect(JSON.stringify(line)).not.toMatch(/login/);
  });

  it("ignores a reply that lands after its correction ended", () => {
    const t = timeline();
    t.expectReport();
    t.beginCorrection();
    t.finish("user");
    clock = 1_300;
    t.endCorrection("discarded", countPassageFates(["dropped"]));
    t.noteCorrectionReplies({ prepMs: 4, requestMs: 900 });
    t.reportEnded("stopped", report);
    expect(logged()).toMatchObject({
      correctionMs: 300,
      correctionPrepMs: null,
      correctionRequestMs: null,
      correctionApplyMs: null,
    });
  });

  it("leaves the parts unknown for a correction that never heard back", () => {
    const t = timeline();
    t.beginCorrection();
    t.finish("user");
    clock = 1_300;
    t.endCorrection("discarded", countPassageFates(["dropped"]));
    expect(logged()).toMatchObject({
      correctionMs: 300,
      correctionPrepMs: null,
      correctionRequestMs: null,
      correctionApplyMs: null,
    });
  });

  it.each([
    ["text in an enum field", { ...report, provider: "fix the login bug" }],
    ["a field it doesn't declare", { ...report, keyterms: ["daintree"] }],
    ["text in a count", { ...report, reconnects: "daintree" }],
  ])("drops a report carrying %s", (_case, bad) => {
    const t = timeline();
    t.expectReport();
    t.finish("user");
    t.reportEnded("stopped", bad);

    const line = logged();
    expect(line).toMatchObject({ backendEnd: "stopped", provider: null, biasTermCount: null });
    expect(JSON.stringify(line)).not.toMatch(/login|daintree/);
  });

  it("flags audio that produced no text, and only that", () => {
    const silent = timeline();
    silent.noteSignal();
    silent.finish("user");
    expect(logged()).toMatchObject({ audioNoText: true, charsCommitted: 0 });

    log.mockReset();
    const spoken = timeline();
    spoken.noteSignal();
    spoken.addCommitted(12);
    spoken.addDroppedQueued(3);
    spoken.finish("user");
    expect(logged()).toMatchObject({ audioNoText: false, charsCommitted: 12, droppedQueued: 3 });

    log.mockReset();
    timeline().finish("user");
    expect(logged()).toMatchObject({ audioNoText: false, charsCommitted: 0 });
  });

  it("holds the line for a frame still to paint text that came in during the stop", () => {
    const t = timeline();
    clock = 1_400;
    t.markNextFrame("firstText");
    t.finish("user");
    expect(log).not.toHaveBeenCalled();
    clock = 1_416;
    frames.shift()!();
    expect(logged()).toMatchObject({ firstTextMs: 416 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops the frame wait along with everything else when disposed", () => {
    const t = timeline();
    t.markNextFrame("firstText");
    t.finish("user");
    expect(vi.getTimerCount()).toBe(1);
    t.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(frames).toHaveLength(0);
  });

  it("logs a mark whose frame never comes as null, once the wait is over", () => {
    const t = timeline();
    t.markNextFrame("firstText");
    t.finish("user");
    vi.advanceTimersByTime(VOICE_FRAME_WAIT_MS - 1);
    expect(log).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(logged()).toMatchObject({ firstTextMs: null });
    expect(frames).toHaveLength(0);
  });

  it("asks for one frame per mark, and cancels it when disposed", () => {
    const t = timeline();
    t.markNextFrame("firstText");
    t.markNextFrame("firstText");
    t.markNextFrame("cue");
    expect(frames).toHaveLength(2);
    t.dispose();
    expect(frames).toHaveLength(0);
  });

  it("still lets go of the session when the log write throws", () => {
    log.mockImplementationOnce(() => {
      throw new Error("log transport gone");
    });
    const t = timeline();
    expect(() => t.finish("user")).toThrow("log transport gone");
    expect(onDone).toHaveBeenCalledWith(t);
  });

  it("logs nothing after it is disposed", () => {
    const t = timeline();
    t.expectReport();
    t.finish("user");
    t.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(VOICE_REPORT_WAIT_MS);
    t.reportEnded("stopped", report);
    expect(log).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });
});
