import { describe, expect, it, beforeEach } from "vitest";
import { useVoiceRecordingStore } from "../voiceRecordingStore";

const PANEL_ID = "panel-1";
const TARGET = { panelId: PANEL_ID };

function reset() {
  useVoiceRecordingStore.setState({
    isConfigured: false,
    correctionEnabled: false,
    status: "idle",
    errorMessage: null,
    activeTarget: null,
    elapsedSeconds: 0,
    audioLevel: 0,
    panelBuffers: {},
    announcement: null,
  });
}

describe("voiceRecordingStore — transcript phase transitions", () => {
  beforeEach(reset);

  it("buffer starts with transcriptPhase idle after beginSession", () => {
    useVoiceRecordingStore.getState().beginSession(TARGET);
    const buffer = useVoiceRecordingStore.getState().panelBuffers[PANEL_ID];
    expect(buffer?.transcriptPhase).toBe("idle");
  });

  it("appendDelta transitions transcriptPhase to interim", () => {
    useVoiceRecordingStore.getState().beginSession(TARGET);
    useVoiceRecordingStore.getState().appendDelta("hello");
    const buffer = useVoiceRecordingStore.getState().panelBuffers[PANEL_ID];
    expect(buffer?.transcriptPhase).toBe("interim");
  });

  it("completeSegment with non-empty text transitions to utterance_final", () => {
    useVoiceRecordingStore.getState().beginSession(TARGET);
    useVoiceRecordingStore.getState().appendDelta("hello");
    useVoiceRecordingStore.getState().completeSegment("hello");
    const buffer = useVoiceRecordingStore.getState().panelBuffers[PANEL_ID];
    expect(buffer?.transcriptPhase).toBe("utterance_final");
  });

  it("completeSegment with empty text transitions to idle", () => {
    useVoiceRecordingStore.getState().beginSession(TARGET);
    useVoiceRecordingStore.getState().appendDelta(" ");
    useVoiceRecordingStore.getState().completeSegment("");
    const buffer = useVoiceRecordingStore.getState().panelBuffers[PANEL_ID];
    expect(buffer?.transcriptPhase).toBe("idle");
  });

  it("addPendingCorrection transitions to paragraph_pending_ai", () => {
    useVoiceRecordingStore.getState().beginSession(TARGET);
    useVoiceRecordingStore.getState().appendDelta("text");
    useVoiceRecordingStore.getState().completeSegment("text");
    useVoiceRecordingStore.getState().addPendingCorrection(PANEL_ID, "id-1", 0, "text");
    const buffer = useVoiceRecordingStore.getState().panelBuffers[PANEL_ID];
    expect(buffer?.transcriptPhase).toBe("paragraph_pending_ai");
  });

  it("resolvePendingCorrection transitions to stable when all corrections resolved", () => {
    useVoiceRecordingStore.getState().beginSession(TARGET);
    useVoiceRecordingStore.getState().addPendingCorrection(PANEL_ID, "id-1", 0, "raw text");
    useVoiceRecordingStore.getState().resolvePendingCorrection(PANEL_ID, "id-1");
    const buffer = useVoiceRecordingStore.getState().panelBuffers[PANEL_ID];
    expect(buffer?.transcriptPhase).toBe("stable");
  });

  it("resolvePendingCorrection stays paragraph_pending_ai when corrections remain", () => {
    useVoiceRecordingStore.getState().beginSession(TARGET);
    useVoiceRecordingStore.getState().addPendingCorrection(PANEL_ID, "id-1", 0, "first");
    useVoiceRecordingStore.getState().addPendingCorrection(PANEL_ID, "id-2", 10, "second");
    useVoiceRecordingStore.getState().resolvePendingCorrection(PANEL_ID, "id-1");
    const buffer = useVoiceRecordingStore.getState().panelBuffers[PANEL_ID];
    expect(buffer?.transcriptPhase).toBe("paragraph_pending_ai");
  });

  it("duplicate rawText with different IDs resolves independently", () => {
    useVoiceRecordingStore.getState().beginSession(TARGET);
    useVoiceRecordingStore.getState().addPendingCorrection(PANEL_ID, "id-a", 0, "start the server");
    useVoiceRecordingStore
      .getState()
      .addPendingCorrection(PANEL_ID, "id-b", 20, "start the server");

    // Resolve the first entry by ID — second should remain
    useVoiceRecordingStore.getState().resolvePendingCorrection(PANEL_ID, "id-a");

    const buffer = useVoiceRecordingStore.getState().panelBuffers[PANEL_ID];
    expect(buffer?.pendingCorrections).toHaveLength(1);
    expect(buffer?.pendingCorrections[0].id).toBe("id-b");
    expect(buffer?.transcriptPhase).toBe("paragraph_pending_ai");
  });

  it("rebasePendingCorrections shifts segmentStart for entries after the applied position", () => {
    useVoiceRecordingStore.getState().beginSession(TARGET);
    useVoiceRecordingStore.getState().addPendingCorrection(PANEL_ID, "id-1", 0, "hello world");
    useVoiceRecordingStore.getState().addPendingCorrection(PANEL_ID, "id-2", 20, "second para");

    // "hello world" (11 chars) is replaced by "Hello, world!" (13 chars) → delta = +2
    useVoiceRecordingStore.getState().rebasePendingCorrections(PANEL_ID, 0, 2);

    const buffer = useVoiceRecordingStore.getState().panelBuffers[PANEL_ID];
    // Entry at position 0 is not shifted (only entries AFTER the applied position are)
    expect(buffer?.pendingCorrections[0].segmentStart).toBe(0);
    // Entry at position 20 shifts to 22
    expect(buffer?.pendingCorrections[1].segmentStart).toBe(22);
  });

  it("rebasePendingCorrections with negative delta contracts later offsets", () => {
    useVoiceRecordingStore.getState().beginSession(TARGET);
    useVoiceRecordingStore.getState().addPendingCorrection(PANEL_ID, "id-1", 0, "hello world");
    useVoiceRecordingStore.getState().addPendingCorrection(PANEL_ID, "id-2", 20, "second para");

    // "hello world" replaced by "hi" → delta = -9
    useVoiceRecordingStore.getState().rebasePendingCorrections(PANEL_ID, 0, -9);

    const buffer = useVoiceRecordingStore.getState().panelBuffers[PANEL_ID];
    expect(buffer?.pendingCorrections[0].segmentStart).toBe(0);
    expect(buffer?.pendingCorrections[1].segmentStart).toBe(11);
  });

  it("resetParagraphState transitions to idle when no pending corrections", () => {
    useVoiceRecordingStore.getState().beginSession(TARGET);
    useVoiceRecordingStore.getState().appendDelta("text");
    useVoiceRecordingStore.getState().completeSegment("text");
    useVoiceRecordingStore.getState().resetParagraphState(PANEL_ID);
    const buffer = useVoiceRecordingStore.getState().panelBuffers[PANEL_ID];
    expect(buffer?.transcriptPhase).toBe("idle");
  });

  it("resetParagraphState preserves paragraph_pending_ai when corrections still in flight", () => {
    useVoiceRecordingStore.getState().beginSession(TARGET);
    useVoiceRecordingStore.getState().addPendingCorrection(PANEL_ID, "id-1", 0, "pending text");
    useVoiceRecordingStore.getState().resetParagraphState(PANEL_ID);
    const buffer = useVoiceRecordingStore.getState().panelBuffers[PANEL_ID];
    expect(buffer?.transcriptPhase).toBe("paragraph_pending_ai");
  });

  it("resetParagraphState also resets draftLengthAtSegmentStart to -1", () => {
    useVoiceRecordingStore.getState().beginSession(TARGET);
    useVoiceRecordingStore.getState().setDraftLengthAtSegmentStart(PANEL_ID, 42);
    expect(
      useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]?.draftLengthAtSegmentStart
    ).toBe(42);

    useVoiceRecordingStore.getState().resetParagraphState(PANEL_ID);

    expect(
      useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]?.draftLengthAtSegmentStart
    ).toBe(-1);
  });

  it("resetParagraphState also resets liveText to empty string", () => {
    useVoiceRecordingStore.getState().beginSession(TARGET);
    useVoiceRecordingStore.getState().appendDelta("interim text");
    expect(useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]?.liveText).toBe("interim text");

    useVoiceRecordingStore.getState().resetParagraphState(PANEL_ID);

    expect(useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]?.liveText).toBe("");
  });

  it("after resetParagraphState, setDraftLengthAtSegmentStart can set a new anchor", () => {
    useVoiceRecordingStore.getState().beginSession(TARGET);
    // Set an initial anchor (simulating delta receipt before Enter)
    useVoiceRecordingStore.getState().setDraftLengthAtSegmentStart(PANEL_ID, 20);
    // Enter pressed — resets segment state
    useVoiceRecordingStore.getState().resetParagraphState(PANEL_ID);
    // First delta after Enter should establish a new anchor
    useVoiceRecordingStore.getState().setDraftLengthAtSegmentStart(PANEL_ID, 21); // after newline

    expect(
      useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]?.draftLengthAtSegmentStart
    ).toBe(21);
  });

  it("finishSession resets transcriptPhase to idle regardless of prior phase", () => {
    useVoiceRecordingStore.getState().beginSession(TARGET);
    useVoiceRecordingStore.getState().appendDelta("unfinished");
    expect(useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]?.transcriptPhase).toBe(
      "interim"
    );
    useVoiceRecordingStore.getState().finishSession();
    const buffer = useVoiceRecordingStore.getState().panelBuffers[PANEL_ID];
    expect(buffer?.transcriptPhase).toBe("idle");
  });

  it("full lifecycle: idle → interim → utterance_final → paragraph_pending_ai → stable", () => {
    const store = useVoiceRecordingStore.getState();

    store.beginSession(TARGET);
    expect(useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]?.transcriptPhase).toBe("idle");

    useVoiceRecordingStore.getState().appendDelta("hello world");
    expect(useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]?.transcriptPhase).toBe(
      "interim"
    );

    useVoiceRecordingStore.getState().completeSegment("hello world");
    expect(useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]?.transcriptPhase).toBe(
      "utterance_final"
    );

    useVoiceRecordingStore.getState().addPendingCorrection(PANEL_ID, "id-1", 0, "hello world");
    expect(useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]?.transcriptPhase).toBe(
      "paragraph_pending_ai"
    );

    useVoiceRecordingStore.getState().resolvePendingCorrection(PANEL_ID, "id-1");
    expect(useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]?.transcriptPhase).toBe(
      "stable"
    );
  });
});
