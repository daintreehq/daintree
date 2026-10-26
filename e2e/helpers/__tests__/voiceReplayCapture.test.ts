import { describe, expect, it } from "vitest";
import { deriveSession, type ReplayCapture } from "../voiceReplayCapture";

const capture: ReplayCapture = {
  micOpens: [50, 1_120],
  events: [
    // An earlier session's tail must not leak into this one.
    { t: 90, kind: "complete", sessionId: "old", text: "stale words" },
    { t: 1_010, kind: "status", sessionId: "s1", status: "connecting" },
    { t: 1_400, kind: "status", sessionId: "s1", status: "recording" },
    { t: 1_600, kind: "delta", sessionId: "s1", text: " " },
    { t: 1_700, kind: "delta", sessionId: "s1", text: "Run npm" },
    { t: 2_500, kind: "complete", sessionId: "s1", text: " Run npm test. " },
    { t: 2_600, kind: "complete", sessionId: "s1", text: "" },
    { t: 3_900, kind: "status", sessionId: "s1", status: "finishing" },
    { t: 4_300, kind: "complete", sessionId: "s1", text: "Then  push." },
    { t: 4_500, kind: "error", sessionId: "s1", message: "drain timed out" },
    { t: 4_600, kind: "ended", sessionId: "s1", reason: "stopped" },
  ],
};

describe("deriveSession", () => {
  it("joins the session's non-empty finals in order and times them from the press", () => {
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
