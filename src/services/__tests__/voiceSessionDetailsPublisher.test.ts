import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoicePublishDetailsRequest } from "@shared/types";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { usePanelStore } from "@/store/panelStore";
import { VOICE_PARAGRAPH_BREAK } from "@/lib/voiceTranscriptSegments";
import type { VoiceRewriteRequest } from "@/store/voiceRecordingStore";
import type { PanelInstance } from "@shared/types/panel";
import {
  buildVoiceSessionSnapshot,
  startVoiceDetailsPublisher,
  VOICE_DETAILS_PUBLISH_MS,
  type VoiceOwnerClock,
} from "../voiceSessionDetailsPublisher";

const running: VoiceOwnerClock = { elapsedMs: 4_200, pausedMs: 0, autoStop: null };

function recordInto(panelId = "p-1", overrides: Record<string, unknown> = {}) {
  useVoiceRecordingStore.setState({
    status: "recording",
    micSignal: "live",
    micDeviceLabel: "MacBook Pro Microphone",
    micNotice: null,
    correctionEnabled: true,
    lockedTarget: null,
    activeTarget: {
      panelId,
      panelTitle: "Claude",
      projectName: "Alpha",
      worktreeLabel: "main",
    },
    panelBuffers: {},
    ...overrides,
  });
}

function withWords(panelId: string, completedSegments: string[], liveText: string) {
  useVoiceRecordingStore.setState({
    panelBuffers: {
      [panelId]: {
        liveText,
        liveItems: [],
        completedSegments,
        sessionDraftStart: -1,
        activeParagraphStart: -1,
        transcriptPhase: "idle",
        correctionRanges: [],
        sessionCorrectedText: null,
        dictationSessionId: null,
      },
    },
  });
}

function claudePane(title = "claude · notes"): PanelInstance {
  return {
    id: "p-1",
    kind: "terminal",
    title,
    cwd: "/alpha",
    cols: 80,
    rows: 24,
    location: "grid",
    launchAgentId: "claude",
  };
}

const build = (options: Partial<Parameters<typeof buildVoiceSessionSnapshot>[1]> = {}) =>
  buildVoiceSessionSnapshot(useVoiceRecordingStore.getState(), {
    panel: undefined,
    clock: running,
    hostId: "local",
    now: 50_000,
    ...options,
  });

describe("buildVoiceSessionSnapshot", () => {
  afterEach(() => {
    useVoiceRecordingStore.setState({ activeTarget: null, status: "idle", panelBuffers: {} });
  });

  it("describes the owner's session as its own panel shows it", () => {
    recordInto("p-1", { lockedTarget: { panelId: "p-1" } });

    expect(build({ panel: claudePane() })).toMatchObject({
      phase: "recording",
      kind: "dictation",
      targetTitle: "claude · notes",
      targetChrome: { agentId: "claude", isAgent: true },
      targetHostId: "local",
      projectName: "Alpha",
      worktreeLabel: "main",
      micLabel: "MacBook Pro Microphone",
      micSignal: "live",
      micNotice: null,
      correctionEnabled: true,
      locked: true,
      wordCount: 0,
      transcript: "",
      clock: { at: 50_000, elapsedMs: 4_200, pausedMs: 0, paused: false, autoStop: null },
    });
  });

  it("falls back to the target's own title when the pane is gone", () => {
    recordInto();
    expect(build()).toMatchObject({ targetTitle: "Claude", targetChrome: null });
  });

  it("counts the words so far, finished and still being heard, but not paragraph breaks", () => {
    recordInto();
    withWords("p-1", ["Fix the build", VOICE_PARAGRAPH_BREAK, "then run it"], "  and push  ");

    const snapshot = build();
    expect(snapshot?.wordCount).toBe(8);
    expect(snapshot?.transcript).toMatch(/^Fix the build[\s\S]*then run it[\s\S]*and push/);
  });

  it("carries only the end of a long transcript, and still counts all of it", () => {
    recordInto();
    withWords("p-1", ["word ".repeat(300).trim()], "last");

    const snapshot = build();
    expect(snapshot?.transcript.length).toBe(400);
    expect(snapshot?.transcript.endsWith("last")).toBe(true);
    expect(snapshot?.wordCount).toBe(301);
  });

  const rewrite: VoiceRewriteRequest = {
    selection: {
      text: "word",
      range: () => ({ from: 0, to: 4 }),
      onLost: () => {},
      apply: () => true,
      release: () => {},
    },
    instruction: [],
    cancelled: false,
  };
  it.each([
    { target: { panelId: "p-1", rewrite }, kind: "rewrite" },
    { target: { panelId: "canopy:1", surface: "canopy-reply" as const }, kind: "canopy-reply" },
    { target: { panelId: "p-1" }, kind: "dictation" },
  ])("names a $kind session", ({ target, kind }) => {
    recordInto();
    useVoiceRecordingStore.setState({ activeTarget: target });

    expect(build()?.kind).toBe(kind);
  });

  it("names the host a Canopy reply's words go to, not the view's own", () => {
    recordInto();
    useVoiceRecordingStore.setState({
      activeTarget: { panelId: "canopy:1", surface: "canopy-reply", otherHostId: "studio-01" },
    });

    expect(build()).toMatchObject({ targetHostId: "studio-01", targetTitle: "Canopy reply" });
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
    expect(build()?.micNotice).toEqual({ kind: "silent", bluetooth: true });

    useVoiceRecordingStore.setState({ micNotice: { ...silent, target: { panelId: "p-2" } } });
    expect(build()?.micNotice).toBeNull();

    useVoiceRecordingStore.setState({
      micNotice: { kind: "lost", target: { panelId: "p-1" }, deviceLabel: null },
    });
    expect(build()?.micNotice).toEqual({ kind: "lost", bluetooth: false });
  });

  it("marks a paused clock, and carries none once the session is stopping", () => {
    recordInto("p-1", { status: "paused" });
    expect(build()?.clock?.paused).toBe(true);

    useVoiceRecordingStore.setState({ status: "finishing" });
    expect(build({ clock: null })).toMatchObject({ phase: "finishing", clock: null });
  });

  it("passes on the owner's auto-stop warning for the state it is in", () => {
    recordInto("p-1", { idleStopWarning: true, pauseStopWarning: false });
    expect(build()?.stopWarning).toBe(true);

    useVoiceRecordingStore.setState({ status: "paused" });
    expect(build()?.stopWarning).toBe(false);
    useVoiceRecordingStore.setState({ pauseStopWarning: true, idleStopWarning: false });
    expect(build()?.stopWarning).toBe(true);
  });

  it("clips a label to what main takes", () => {
    recordInto("p-1", { micDeviceLabel: "m".repeat(500) });
    expect(build()?.micLabel?.length).toBe(200);
  });

  it("describes nothing while no session a panel would show runs here", () => {
    recordInto("p-1", { status: "idle" });
    expect(build()).toBeNull();
    useVoiceRecordingStore.setState({ status: "error" });
    expect(build()).toBeNull();
  });
});

describe("startVoiceDetailsPublisher", () => {
  let sessionId: string | null;
  let startedAt: number;
  let autoStopAt: number | null;
  let accepted: boolean;
  let published: VoicePublishDetailsRequest[];
  let stopPublishing: () => void;

  beforeEach(() => {
    vi.useFakeTimers({ now: 100_000 });
    startedAt = 100_000;
    sessionId = "s1";
    autoStopAt = null;
    accepted = true;
    published = [];
    usePanelStore.setState({ panelsById: { "p-1": claudePane("Claude") } });
    recordInto();
    stopPublishing = startVoiceDetailsPublisher(
      {
        sessionId: () => sessionId,
        // A clock that runs from `startedAt`, as the service's does.
        clock: (now) => ({
          elapsedMs: now - startedAt,
          pausedMs: 0,
          autoStop: autoStopAt === null ? null : { reason: "idle", remainingMs: autoStopAt - now },
        }),
        hostId: () => "local",
      },
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

  let level = 0;
  const nudge = () => useVoiceRecordingStore.setState({ audioLevel: (level = 1 - level) });

  it("reports the session once its changes settle, with the pane's agent", async () => {
    useVoiceRecordingStore.setState({ status: "paused" });
    useVoiceRecordingStore.setState({ micSignal: "silent" });
    expect(published).toEqual([]);

    await vi.advanceTimersByTimeAsync(VOICE_DETAILS_PUBLISH_MS);

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      sessionId: "s1",
      details: { phase: "paused", micSignal: "silent", targetChrome: { agentId: "claude" } },
    });
  });

  it("sends nothing for level readings, or as a running clock ticks", async () => {
    nudge();
    await vi.advanceTimersByTimeAsync(VOICE_DETAILS_PUBLISH_MS);
    expect(published).toHaveLength(1);

    for (let second = 1; second <= 5; second++) {
      useVoiceRecordingStore.setState({ elapsedSeconds: second });
      nudge();
      await vi.advanceTimersByTimeAsync(1000);
    }

    expect(published).toHaveLength(1);
  });

  it("reports an auto-stop being set and moved, but not counting down", async () => {
    nudge();
    await vi.advanceTimersByTimeAsync(VOICE_DETAILS_PUBLISH_MS);

    autoStopAt = Date.now() + 60_000;
    nudge();
    await vi.advanceTimersByTimeAsync(VOICE_DETAILS_PUBLISH_MS);
    expect(published).toHaveLength(2);
    expect(published[1]!.details.clock?.autoStop?.reason).toBe("idle");

    for (let i = 0; i < 5; i++) {
      nudge();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(published).toHaveLength(2);

    // New words push the deadline back.
    autoStopAt = Date.now() + 60_000;
    nudge();
    await vi.advanceTimersByTimeAsync(VOICE_DETAILS_PUBLISH_MS);
    expect(published).toHaveLength(3);
  });

  it("reports the target pane being renamed while nothing else changes", async () => {
    nudge();
    await vi.advanceTimersByTimeAsync(VOICE_DETAILS_PUBLISH_MS);

    // Another pane changing is nothing to report.
    usePanelStore.setState({
      panelsById: { ...usePanelStore.getState().panelsById, "p-2": { ...claudePane(), id: "p-2" } },
    });
    await vi.advanceTimersByTimeAsync(VOICE_DETAILS_PUBLISH_MS);
    expect(published).toHaveLength(1);

    usePanelStore.setState({
      panelsById: { ...usePanelStore.getState().panelsById, "p-1": claudePane("renamed") },
    });
    await vi.advanceTimersByTimeAsync(VOICE_DETAILS_PUBLISH_MS);

    expect(published).toHaveLength(2);
    expect(published[1]!.details.targetTitle).toBe("renamed");
  });

  it("keeps reporting through a session that never goes quiet", async () => {
    // A transcript word lands every 50ms for two seconds.
    for (let i = 0; i < 40; i++) {
      withWords("p-1", [], "word ".repeat(i + 1));
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
    expect(published[1]!.details.phase).toBe(published[0]!.details.phase);
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

  it("drops a report still waiting when it stops, and hears neither store after", async () => {
    nudge();
    stopPublishing();
    await vi.advanceTimersByTimeAsync(VOICE_DETAILS_PUBLISH_MS * 2);
    nudge();
    usePanelStore.setState({ panelsById: { "p-1": claudePane("renamed") } });
    await vi.advanceTimersByTimeAsync(VOICE_DETAILS_PUBLISH_MS);

    expect(published).toEqual([]);
  });
});
