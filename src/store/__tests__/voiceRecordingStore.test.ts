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
    useVoiceRecordingStore.getState().addPendingCorrection(PANEL_ID, 0, "text");
    const buffer = useVoiceRecordingStore.getState().panelBuffers[PANEL_ID];
    expect(buffer?.transcriptPhase).toBe("paragraph_pending_ai");
  });

  it("resolvePendingCorrection transitions to stable when all corrections resolved", () => {
    useVoiceRecordingStore.getState().beginSession(TARGET);
    useVoiceRecordingStore.getState().addPendingCorrection(PANEL_ID, 0, "raw text");
    useVoiceRecordingStore.getState().resolvePendingCorrection(PANEL_ID, "raw text");
    const buffer = useVoiceRecordingStore.getState().panelBuffers[PANEL_ID];
    expect(buffer?.transcriptPhase).toBe("stable");
  });

  it("resolvePendingCorrection stays paragraph_pending_ai when corrections remain", () => {
    useVoiceRecordingStore.getState().beginSession(TARGET);
    useVoiceRecordingStore.getState().addPendingCorrection(PANEL_ID, 0, "first");
    useVoiceRecordingStore.getState().addPendingCorrection(PANEL_ID, 10, "second");
    useVoiceRecordingStore.getState().resolvePendingCorrection(PANEL_ID, "first");
    const buffer = useVoiceRecordingStore.getState().panelBuffers[PANEL_ID];
    expect(buffer?.transcriptPhase).toBe("paragraph_pending_ai");
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
    useVoiceRecordingStore.getState().addPendingCorrection(PANEL_ID, 0, "pending text");
    useVoiceRecordingStore.getState().resetParagraphState(PANEL_ID);
    const buffer = useVoiceRecordingStore.getState().panelBuffers[PANEL_ID];
    expect(buffer?.transcriptPhase).toBe("paragraph_pending_ai");
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

    useVoiceRecordingStore.getState().addPendingCorrection(PANEL_ID, 0, "hello world");
    expect(useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]?.transcriptPhase).toBe(
      "paragraph_pending_ai"
    );

    useVoiceRecordingStore.getState().resolvePendingCorrection(PANEL_ID, "hello world");
    expect(useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]?.transcriptPhase).toBe(
      "stable"
    );
  });
});
