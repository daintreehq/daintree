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
    lockedTarget: null,
    recentTargets: [],
    elapsedSeconds: 0,
    audioLevel: 0,
    panelBuffers: {},
    announcement: null,
  });
}

describe("voiceRecordingStore — setArming", () => {
  beforeEach(reset);

  it("atomically sets status='arming' and activeTarget in a single update", () => {
    let intermediateStatus: string | null = null;
    let intermediateTarget: typeof TARGET | null | undefined = undefined;
    const unsub = useVoiceRecordingStore.subscribe((state) => {
      // The first subscriber notification reads the new state. If status and
      // activeTarget were written separately, one snapshot would observe
      // status=arming with activeTarget=null (or vice versa).
      if (intermediateStatus === null) {
        intermediateStatus = state.status;
        intermediateTarget = state.activeTarget;
      }
    });
    try {
      useVoiceRecordingStore.getState().setArming(TARGET);
    } finally {
      unsub();
    }

    expect(intermediateStatus).toBe("arming");
    expect(intermediateTarget).toEqual(TARGET);
    const final = useVoiceRecordingStore.getState();
    expect(final.status).toBe("arming");
    expect(final.activeTarget).toEqual(TARGET);
  });

  it("clears any prior errorMessage so a fresh arming flow doesn't show stale text", () => {
    useVoiceRecordingStore.setState({ errorMessage: "Previous failure" });
    useVoiceRecordingStore.getState().setArming(TARGET);
    expect(useVoiceRecordingStore.getState().errorMessage).toBeNull();
  });

  it("transitions cleanly to connecting when beginSession runs after arming", () => {
    useVoiceRecordingStore.getState().setArming(TARGET);
    useVoiceRecordingStore.getState().beginSession(TARGET);
    const state = useVoiceRecordingStore.getState();
    expect(state.status).toBe("connecting");
    expect(state.activeTarget).toEqual(TARGET);
  });
});

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

  it("resetParagraphState resets draftLengthAtSegmentStart to -1", () => {
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

  it("resetParagraphState resets liveText to empty string", () => {
    useVoiceRecordingStore.getState().beginSession(TARGET);
    useVoiceRecordingStore.getState().appendDelta("interim text");
    expect(useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]?.liveText).toBe("interim text");

    useVoiceRecordingStore.getState().resetParagraphState(PANEL_ID);

    expect(useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]?.liveText).toBe("");
  });

  it("after resetParagraphState, setDraftLengthAtSegmentStart can set a new anchor", () => {
    useVoiceRecordingStore.getState().beginSession(TARGET);
    useVoiceRecordingStore.getState().setDraftLengthAtSegmentStart(PANEL_ID, 20);
    useVoiceRecordingStore.getState().resetParagraphState(PANEL_ID);
    useVoiceRecordingStore.getState().setDraftLengthAtSegmentStart(PANEL_ID, 21);

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

describe("voiceRecordingStore — lockedTarget", () => {
  beforeEach(reset);

  it("lockTarget sets lockedTarget to the provided value", () => {
    useVoiceRecordingStore.getState().lockTarget({ panelId: PANEL_ID, panelTitle: "Editor" });
    expect(useVoiceRecordingStore.getState().lockedTarget).toEqual({
      panelId: PANEL_ID,
      panelTitle: "Editor",
    });
  });

  it("unlockTarget clears lockedTarget to null", () => {
    useVoiceRecordingStore.getState().lockTarget({ panelId: PANEL_ID });
    useVoiceRecordingStore.getState().unlockTarget();
    expect(useVoiceRecordingStore.getState().lockedTarget).toBeNull();
  });

  it("clearLockedTarget(matchingId) clears the lock", () => {
    useVoiceRecordingStore.getState().lockTarget({ panelId: PANEL_ID });
    useVoiceRecordingStore.getState().clearLockedTarget(PANEL_ID);
    expect(useVoiceRecordingStore.getState().lockedTarget).toBeNull();
  });

  it("clearLockedTarget(nonMatchingId) is a no-op when lock points elsewhere", () => {
    useVoiceRecordingStore.getState().lockTarget({ panelId: PANEL_ID });
    const before = useVoiceRecordingStore.getState().lockedTarget;
    useVoiceRecordingStore.getState().clearLockedTarget("other-panel");
    expect(useVoiceRecordingStore.getState().lockedTarget).toBe(before);
  });

  it("clearLockedTarget is safe when no lock is set", () => {
    expect(useVoiceRecordingStore.getState().lockedTarget).toBeNull();
    useVoiceRecordingStore.getState().clearLockedTarget("any-id");
    expect(useVoiceRecordingStore.getState().lockedTarget).toBeNull();
  });
});

describe("voiceRecordingStore — recentTargets", () => {
  beforeEach(reset);

  it("recordRecentTarget appends new entries with metadata and timestamp", () => {
    useVoiceRecordingStore
      .getState()
      .recordRecentTarget({ panelId: PANEL_ID, panelTitle: "Editor", projectName: "demo" });
    const recents = useVoiceRecordingStore.getState().recentTargets;
    expect(recents).toHaveLength(1);
    expect(recents[0]?.panelId).toBe(PANEL_ID);
    expect(recents[0]?.panelTitle).toBe("Editor");
    expect(recents[0]?.projectName).toBe("demo");
    expect(typeof recents[0]?.lastUsedAt).toBe("number");
  });

  it("recordRecentTarget deduplicates by panelId, hoisting the existing entry to the front", () => {
    useVoiceRecordingStore.getState().recordRecentTarget({ panelId: "a", panelTitle: "A" });
    useVoiceRecordingStore.getState().recordRecentTarget({ panelId: "b", panelTitle: "B" });
    useVoiceRecordingStore.getState().recordRecentTarget({ panelId: "a", panelTitle: "A renamed" });
    const recents = useVoiceRecordingStore.getState().recentTargets;
    expect(recents.map((t) => t.panelId)).toEqual(["a", "b"]);
    expect(recents[0]?.panelTitle).toBe("A renamed");
  });

  it("recordRecentTarget caps the list at 3 entries (MRU)", () => {
    useVoiceRecordingStore.getState().recordRecentTarget({ panelId: "a" });
    useVoiceRecordingStore.getState().recordRecentTarget({ panelId: "b" });
    useVoiceRecordingStore.getState().recordRecentTarget({ panelId: "c" });
    useVoiceRecordingStore.getState().recordRecentTarget({ panelId: "d" });
    const recents = useVoiceRecordingStore.getState().recentTargets;
    expect(recents.map((t) => t.panelId)).toEqual(["d", "c", "b"]);
  });

  it("recordRecentTarget dedups a live entry against a rehydrated (no panelId) entry with same worktree+title", () => {
    useVoiceRecordingStore.setState({
      recentTargets: [{ panelTitle: "Editor", worktreeId: "wt-1", lastUsedAt: 1 }],
    });
    useVoiceRecordingStore.getState().recordRecentTarget({
      panelId: "p1",
      panelTitle: "Editor",
      worktreeId: "wt-1",
    });
    const recents = useVoiceRecordingStore.getState().recentTargets;
    expect(recents).toHaveLength(1);
    expect(recents[0]?.panelId).toBe("p1");
  });

  it("recordRecentTarget keeps rehydrated entry with different worktreeId", () => {
    useVoiceRecordingStore.setState({
      recentTargets: [{ panelTitle: "Editor", worktreeId: "wt-other", lastUsedAt: 1 }],
    });
    useVoiceRecordingStore.getState().recordRecentTarget({
      panelId: "p1",
      panelTitle: "Editor",
      worktreeId: "wt-1",
    });
    const recents = useVoiceRecordingStore.getState().recentTargets;
    expect(recents).toHaveLength(2);
  });
});
