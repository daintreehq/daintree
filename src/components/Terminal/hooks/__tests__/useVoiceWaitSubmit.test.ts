import { describe, it, expect, beforeEach, vi } from "vitest";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { waitForCorrectionsToSettle } from "../useVoiceWaitSubmit";

vi.mock("@/services/VoiceRecordingService", () => ({
  voiceRecordingService: { stop: vi.fn().mockResolvedValue(undefined) },
}));

const PANEL_ID = "test-panel";

function setBufferState(
  panelId: string,
  overrides: {
    pendingCorrections?: { id: string; segmentStart: number; rawText: string }[];
    transcriptPhase?: string;
  }
) {
  useVoiceRecordingStore.setState((state) => ({
    panelBuffers: {
      ...state.panelBuffers,
      [panelId]: {
        liveText: "",
        completedSegments: [],
        sessionDraftStart: -1,
        draftLengthAtSegmentStart: -1,
        pendingCorrections: overrides.pendingCorrections ?? [],
        aiCorrectionSpans: [],
        activeParagraphStart: -1,
        transcriptPhase: (overrides.transcriptPhase ?? "idle") as never,
      },
    },
  }));
}

describe("waitForCorrectionsToSettle", () => {
  beforeEach(() => {
    useVoiceRecordingStore.setState({
      status: "idle",
      activeTarget: null,
      panelBuffers: {},
    });
    useTerminalInputStore.setState({
      voiceSubmittingPanels: new Set(),
    });
  });

  it("resolves immediately when no pending corrections", async () => {
    setBufferState(PANEL_ID, { pendingCorrections: [], transcriptPhase: "idle" });
    await waitForCorrectionsToSettle(PANEL_ID, 1000);
  });

  it("resolves immediately when panel buffer does not exist", async () => {
    await waitForCorrectionsToSettle("nonexistent", 1000);
  });

  it("waits until pending corrections clear", async () => {
    setBufferState(PANEL_ID, {
      pendingCorrections: [{ id: "c1", segmentStart: 0, rawText: "test" }],
      transcriptPhase: "paragraph_pending_ai",
    });

    let resolved = false;
    const promise = waitForCorrectionsToSettle(PANEL_ID, 5000).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync?.(0).catch(() => null);
    expect(resolved).toBe(false);

    useVoiceRecordingStore.getState().resolvePendingCorrection(PANEL_ID, "c1");

    await promise;
    expect(resolved).toBe(true);
  });

  it("resolves on timeout when corrections never settle", async () => {
    vi.useFakeTimers();

    setBufferState(PANEL_ID, {
      pendingCorrections: [{ id: "c1", segmentStart: 0, rawText: "stuck" }],
      transcriptPhase: "paragraph_pending_ai",
    });

    let resolved = false;
    const promise = waitForCorrectionsToSettle(PANEL_ID, 500).then(() => {
      resolved = true;
    });

    expect(resolved).toBe(false);
    vi.advanceTimersByTime(500);
    await promise;
    expect(resolved).toBe(true);

    vi.useRealTimers();
  });

  it("handles IPC ordering gap: resolves after store updates post-stop", async () => {
    setBufferState(PANEL_ID, {
      pendingCorrections: [{ id: "c1", segmentStart: 0, rawText: "hello" }],
      transcriptPhase: "paragraph_pending_ai",
    });

    let resolved = false;
    const promise = waitForCorrectionsToSettle(PANEL_ID, 5000).then(() => {
      resolved = true;
    });

    expect(resolved).toBe(false);

    setTimeout(() => {
      useVoiceRecordingStore.getState().resolvePendingCorrection(PANEL_ID, "c1");
    }, 50);

    await promise;
    expect(resolved).toBe(true);
  });
});

describe("terminalInputStore voiceSubmitting", () => {
  beforeEach(() => {
    useTerminalInputStore.setState({ voiceSubmittingPanels: new Set() });
  });

  it("setVoiceSubmitting adds and removes panels", () => {
    const store = useTerminalInputStore.getState();

    store.setVoiceSubmitting(PANEL_ID, true);
    expect(useTerminalInputStore.getState().isVoiceSubmitting(PANEL_ID)).toBe(true);

    store.setVoiceSubmitting(PANEL_ID, false);
    expect(useTerminalInputStore.getState().isVoiceSubmitting(PANEL_ID)).toBe(false);
  });

  it("clearTerminalState clears voiceSubmitting", () => {
    useTerminalInputStore.getState().setVoiceSubmitting(PANEL_ID, true);
    useTerminalInputStore.getState().clearTerminalState(PANEL_ID);
    expect(useTerminalInputStore.getState().isVoiceSubmitting(PANEL_ID)).toBe(false);
  });

  it("does not trigger unnecessary state updates", () => {
    const store = useTerminalInputStore.getState();
    store.setVoiceSubmitting(PANEL_ID, false);
    const before = useTerminalInputStore.getState().voiceSubmittingPanels;
    store.setVoiceSubmitting(PANEL_ID, false);
    const after = useTerminalInputStore.getState().voiceSubmittingPanels;
    expect(before).toBe(after);
  });
});
