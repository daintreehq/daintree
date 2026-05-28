import { describe, expect, it, beforeEach } from "vitest";
import { useVoiceRecordingStore } from "../voiceRecordingStore";

const PANEL_ID = "panel-1";
const TARGET = { panelId: PANEL_ID };

function reset() {
  useVoiceRecordingStore.setState({
    isConfigured: false,
    correctionEnabled: false,
    status: "idle",
    lastError: null,
    activeTarget: null,
    elapsedSeconds: 0,
    audioLevel: 0,
    panelBuffers: {},
    announcement: null,
  });
}

describe("voiceRecordingStore — clearPanelBuffer", () => {
  beforeEach(reset);

  it("removes the buffer entry for the given panelId", () => {
    useVoiceRecordingStore.getState().beginSession(TARGET);
    useVoiceRecordingStore.getState().appendDelta("test");
    expect(useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]).toBeDefined();

    useVoiceRecordingStore.getState().clearPanelBuffer(PANEL_ID);

    expect(useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]).toBeUndefined();
  });

  it("is a no-op for panelIds that have no buffer", () => {
    const before = useVoiceRecordingStore.getState().panelBuffers;
    useVoiceRecordingStore.getState().clearPanelBuffer("nonexistent");
    expect(useVoiceRecordingStore.getState().panelBuffers).toBe(before);
  });
});

describe("voiceRecordingStore — project switch reset", () => {
  beforeEach(reset);

  it("clears panelBuffers while preserving session and config state", () => {
    useVoiceRecordingStore.setState({
      isConfigured: true,
      correctionEnabled: true,
    });
    useVoiceRecordingStore.getState().beginSession(TARGET);
    useVoiceRecordingStore.getState().appendDelta("dictated text");

    // Simulate resetAllStoresForProjectSwitch — only panelBuffers is cleared
    useVoiceRecordingStore.setState({ panelBuffers: {} });

    const state = useVoiceRecordingStore.getState();
    expect(state.panelBuffers).toEqual({});
    expect(state.isConfigured).toBe(true);
    expect(state.correctionEnabled).toBe(true);
    // activeTarget and status are intentionally NOT cleared — the
    // VoiceRecordingService owns the session lifecycle and clearing
    // them here would orphan audio resources.
    expect(state.activeTarget).toEqual(TARGET);
  });
});

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

  it("resetParagraphState transitions to idle", () => {
    useVoiceRecordingStore.getState().beginSession(TARGET);
    useVoiceRecordingStore.getState().appendDelta("text");
    useVoiceRecordingStore.getState().completeSegment("text");
    useVoiceRecordingStore.getState().resetParagraphState(PANEL_ID);
    const buffer = useVoiceRecordingStore.getState().panelBuffers[PANEL_ID];
    expect(buffer?.transcriptPhase).toBe("idle");
  });

  it("resetParagraphState resets insertPoint to -1", () => {
    useVoiceRecordingStore.getState().beginSession(TARGET);
    useVoiceRecordingStore.getState().setInsertPoint(PANEL_ID, 42);
    expect(useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]?.insertPoint).toBe(42);

    useVoiceRecordingStore.getState().resetParagraphState(PANEL_ID);

    expect(useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]?.insertPoint).toBe(-1);
  });

  it("resetParagraphState resets liveText to empty string", () => {
    useVoiceRecordingStore.getState().beginSession(TARGET);
    useVoiceRecordingStore.getState().appendDelta("interim text");
    expect(useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]?.liveText).toBe("interim text");

    useVoiceRecordingStore.getState().resetParagraphState(PANEL_ID);

    expect(useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]?.liveText).toBe("");
  });

  it("after resetParagraphState, setInsertPoint can set a new anchor", () => {
    useVoiceRecordingStore.getState().beginSession(TARGET);
    useVoiceRecordingStore.getState().setInsertPoint(PANEL_ID, 20);
    useVoiceRecordingStore.getState().resetParagraphState(PANEL_ID);
    useVoiceRecordingStore.getState().setInsertPoint(PANEL_ID, 21);

    expect(useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]?.insertPoint).toBe(21);
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

  it("full lifecycle: idle → interim → utterance_final → idle (after reset)", () => {
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

    useVoiceRecordingStore.getState().resetParagraphState(PANEL_ID);
    expect(useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]?.transcriptPhase).toBe("idle");
  });
});
