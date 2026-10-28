import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoicePublishDetailsRequest } from "@shared/types";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { usePanelStore } from "@/store/panelStore";
import { VOICE_PARAGRAPH_BREAK } from "@/lib/voiceTranscriptSegments";
import {
  buildVoiceSessionDetails,
  startVoiceDetailsPublisher,
  VOICE_DETAILS_PUBLISH_MS,
} from "../voiceSessionDetailsPublisher";

const ticking = { seconds: 4, at: 1_000, ticking: true };

function recordInto(panelId = "p-1", overrides: Record<string, unknown> = {}) {
  useVoiceRecordingStore.setState({
    status: "recording",
    micSignal: "live",
    micDeviceLabel: "MacBook Pro Microphone",
    micNotice: null,
    correctionEnabled: true,
    lockedTarget: null,
    pauseStopWarning: false,
    idleStopWarning: false,
    activeTarget: { panelId, panelTitle: "Claude", worktreeLabel: "main" },
    panelBuffers: {},
    ...overrides,
  });
}

describe("buildVoiceSessionDetails", () => {
  afterEach(() => {
    useVoiceRecordingStore.setState({ activeTarget: null, status: "idle", panelBuffers: {} });
  });

  it("describes the owner's session as its own indicator shows it", () => {
    recordInto("p-1", { lockedTarget: { panelId: "p-1" } });

    expect(
      buildVoiceSessionDetails(useVoiceRecordingStore.getState(), {
        elapsed: ticking,
        agentId: "claude",
      })
    ).toEqual({
      status: "recording",
      kind: "dictation",
      panelTitle: "Claude",
      worktreeLabel: "main",
      agentId: "claude",
      locked: true,
      correctionEnabled: true,
      micDeviceLabel: "MacBook Pro Microphone",
      micSignal: "live",
      micNotice: null,
      pauseStopWarning: false,
      idleStopWarning: false,
      wordCount: 0,
      elapsed: ticking,
    });
  });

  it("counts the words so far, finished and still being heard, but not paragraph breaks", () => {
    recordInto();
    const store = useVoiceRecordingStore.getState();
    useVoiceRecordingStore.setState({
      panelBuffers: {
        "p-1": {
          ...(store.panelBuffers["p-1"] ?? {
            liveItems: [],
            sessionDraftStart: -1,
            activeParagraphStart: -1,
            transcriptPhase: "idle",
            correctionRanges: [],
            sessionCorrectedText: null,
            dictationSessionId: "s1",
          }),
          completedSegments: ["Fix the build", VOICE_PARAGRAPH_BREAK, "then run it"],
          liveText: "  and push  ",
        },
      } as never,
    });

    const details = buildVoiceSessionDetails(useVoiceRecordingStore.getState(), {
      elapsed: ticking,
      agentId: null,
    });
    expect(details?.wordCount).toBe(8);
  });

  it.each([
    { target: { panelId: "p-1", rewrite: {} }, kind: "rewrite" },
    { target: { panelId: "canopy:1", surface: "canopy-reply" }, kind: "canopy-reply" },
    { target: { panelId: "p-1" }, kind: "dictation" },
  ])("names a $kind session", ({ target, kind }) => {
    recordInto();
    useVoiceRecordingStore.setState({ activeTarget: target as never });

    expect(
      buildVoiceSessionDetails(useVoiceRecordingStore.getState(), {
        elapsed: ticking,
        agentId: null,
      })?.kind
    ).toBe(kind);
  });

  it("passes on a warning about this session's mic, never one about another target's", () => {
    recordInto();
    const silent = {
      kind: "silent" as const,
      target: { panelId: "p-1" },
      deviceLabel: "AirPods",
      bluetooth: true,
      builtIn: null,
    };
    useVoiceRecordingStore.setState({ micNotice: silent });
    const read = () =>
      buildVoiceSessionDetails(useVoiceRecordingStore.getState(), {
        elapsed: ticking,
        agentId: null,
      })?.micNotice;
    expect(read()).toEqual({ kind: "silent", bluetooth: true });

    useVoiceRecordingStore.setState({ micNotice: { ...silent, target: { panelId: "p-2" } } });
    expect(read()).toBeNull();

    useVoiceRecordingStore.setState({
      micNotice: { kind: "lost", target: { panelId: "p-1" }, deviceLabel: null },
    });
    expect(read()).toBeNull();
  });

  it("clips a label to what main takes", () => {
    recordInto("p-1", { micDeviceLabel: "m".repeat(500) });

    const details = buildVoiceSessionDetails(useVoiceRecordingStore.getState(), {
      elapsed: ticking,
      agentId: null,
    });
    expect(details?.micDeviceLabel?.length).toBe(200);
  });

  it("describes nothing while no session runs here", () => {
    recordInto();
    useVoiceRecordingStore.setState({ status: "idle" });
    expect(
      buildVoiceSessionDetails(useVoiceRecordingStore.getState(), {
        elapsed: ticking,
        agentId: null,
      })
    ).toBeNull();
  });
});

describe("startVoiceDetailsPublisher", () => {
  let sessionId: string | null;
  let elapsed: { seconds: number; at: number; ticking: boolean };
  let accepted: boolean;
  let published: VoicePublishDetailsRequest[];
  let stopPublishing: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    sessionId = "s1";
    elapsed = { seconds: 0, at: 0, ticking: true };
    accepted = true;
    published = [];
    usePanelStore.setState({
      panelsById: { "p-1": { id: "p-1", detectedAgentId: "claude" } as never },
    });
    recordInto();
    stopPublishing = startVoiceDetailsPublisher(
      { sessionId: () => sessionId, elapsed: () => elapsed },
      (request) => {
        published.push(request);
        return Promise.resolve(accepted);
      }
    );
  });

  afterEach(() => {
    stopPublishing();
    vi.useRealTimers();
    useVoiceRecordingStore.setState({ activeTarget: null, status: "idle", panelBuffers: {} });
    usePanelStore.setState({ panelsById: {} });
  });

  const nudge = () => useVoiceRecordingStore.setState({ audioLevel: Math.random() });

  it("reports the session once its changes settle, with the pane's agent", async () => {
    useVoiceRecordingStore.setState({ status: "paused" });
    useVoiceRecordingStore.setState({ pauseStopWarning: true });
    expect(published).toEqual([]);

    await vi.advanceTimersByTimeAsync(VOICE_DETAILS_PUBLISH_MS);

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      sessionId: "s1",
      details: { status: "paused", pauseStopWarning: true, agentId: "claude" },
    });
  });

  it("sends nothing for level readings, or for a running clock's ticks", async () => {
    nudge();
    await vi.advanceTimersByTimeAsync(VOICE_DETAILS_PUBLISH_MS);
    expect(published).toHaveLength(1);

    for (let second = 1; second <= 5; second++) {
      elapsed = { seconds: second, at: second * 1000, ticking: true };
      useVoiceRecordingStore.setState({ elapsedSeconds: second });
      nudge();
      await vi.advanceTimersByTimeAsync(1000);
    }

    expect(published).toHaveLength(1);
  });

  it("reports the clock stopping, with where it stopped", async () => {
    nudge();
    await vi.advanceTimersByTimeAsync(VOICE_DETAILS_PUBLISH_MS);

    elapsed = { seconds: 9, at: 9_000, ticking: false };
    useVoiceRecordingStore.setState({ status: "paused" });
    await vi.advanceTimersByTimeAsync(VOICE_DETAILS_PUBLISH_MS);

    expect(published.at(-1)?.details.elapsed).toEqual({ seconds: 9, at: 9_000, ticking: false });
  });

  it("keeps reporting through a session that never goes quiet", async () => {
    // A transcript word lands every 50ms for two seconds.
    for (let i = 0; i < 40; i++) {
      useVoiceRecordingStore.setState({
        panelBuffers: { "p-1": { liveText: "word ".repeat(i + 1), completedSegments: [] } as never },
      });
      await vi.advanceTimersByTimeAsync(50);
    }

    expect(published.length).toBeGreaterThanOrEqual(8);
    expect(published.length).toBeLessThanOrEqual(2000 / VOICE_DETAILS_PUBLISH_MS + 1);
  });

  it("sends a report main didn't take again with the next change", async () => {
    accepted = false;
    nudge();
    await vi.advanceTimersByTimeAsync(VOICE_DETAILS_PUBLISH_MS);
    expect(published).toHaveLength(1);

    accepted = true;
    nudge();
    await vi.advanceTimersByTimeAsync(VOICE_DETAILS_PUBLISH_MS);
    expect(published).toHaveLength(2);
    expect(published[1]).toEqual(published[0]);
  });

  it("reports a new session even when it looks the same as the last", async () => {
    nudge();
    await vi.advanceTimersByTimeAsync(VOICE_DETAILS_PUBLISH_MS);

    sessionId = "s2";
    nudge();
    await vi.advanceTimersByTimeAsync(VOICE_DETAILS_PUBLISH_MS);

    expect(published.map((request) => request.sessionId)).toEqual(["s1", "s2"]);
  });

  it("reports nothing for a view that owns no session", async () => {
    sessionId = null;
    nudge();
    await vi.advanceTimersByTimeAsync(VOICE_DETAILS_PUBLISH_MS);

    expect(published).toEqual([]);
  });

  it("drops a report still waiting when it stops", async () => {
    nudge();
    stopPublishing();
    await vi.advanceTimersByTimeAsync(VOICE_DETAILS_PUBLISH_MS * 2);
    nudge();
    await vi.advanceTimersByTimeAsync(VOICE_DETAILS_PUBLISH_MS);

    expect(published).toEqual([]);
  });
});
