import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VOICE_SESSION_SUMMARY_MESSAGE } from "@shared/utils/voiceLogFields";
import {
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
    clock = 1_100;
    t.mark("firstText");
    clock = 1_500;
    t.mark("firstText");
    t.finish("escape");
    t.finish("user");
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
    t.endCorrection("applied");
    expect(logged()).toMatchObject({ correctionMs: 850, correction: "applied" });
  });

  it("drops a report carrying anything but numbers and enums", () => {
    const t = timeline();
    t.expectReport();
    t.finish("user");
    t.reportEnded("stopped", { ...report, provider: "fix the login bug", keyterms: ["daintree"] });

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
    vi.advanceTimersByTime(VOICE_REPORT_WAIT_MS);
    t.reportEnded("stopped", report);
    expect(log).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });
});
