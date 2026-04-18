// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useNoteVoiceInput } from "../useNoteVoiceInput";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import type { EditorView } from "@codemirror/view";

function makeEditorView(initialDoc = ""): {
  view: EditorView;
  dispatched: Array<{ from: number; to: number; insert: string }>;
} {
  const dispatched: Array<{ from: number; to: number; insert: string }> = [];
  let cursorPos = initialDoc.length;
  let doc = initialDoc;

  const view = {
    state: {
      selection: {
        main: {
          get head() {
            return cursorPos;
          },
          get from() {
            return cursorPos;
          },
        },
      },
    },
    dispatch(tr: {
      changes?: { from: number; to: number; insert: string };
      selection?: { anchor: number };
      scrollIntoView?: boolean;
    }) {
      if (tr.changes) {
        dispatched.push({ ...tr.changes });
        // Simulate the doc change
        const { from, to, insert } = tr.changes;
        doc = doc.slice(0, from) + insert + doc.slice(to);
      }
      if (tr.selection) {
        cursorPos = tr.selection.anchor;
      }
    },
  } as unknown as EditorView;

  return { view, dispatched };
}

function resetStore() {
  useVoiceRecordingStore.setState({
    isConfigured: false,
    status: "idle",
    errorMessage: null,
    activeTarget: null,
    elapsedSeconds: 0,
    audioLevel: 0,
    panelBuffers: {},
    announcement: null,
  });
}

describe("useNoteVoiceInput", () => {
  beforeEach(resetStore);
  afterEach(() => vi.clearAllMocks());

  it("inserts first delta at cursor position", () => {
    const { view, dispatched } = makeEditorView("Hello ");
    const ref = { current: view };

    renderHook(() => useNoteVoiceInput("panel-1", ref));

    act(() => {
      useVoiceRecordingStore.setState({
        activeTarget: { panelId: "panel-1" },
        panelBuffers: {
          "panel-1": {
            liveText: "world",
            completedSegments: [],
            sessionDraftStart: -1,
            draftLengthAtSegmentStart: -1,
            pendingCorrections: [],
            aiCorrectionSpans: [],
            activeParagraphStart: -1,
            transcriptPhase: "interim",
          },
        },
      });
    });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toEqual({ from: 6, to: 6, insert: "world" });
  });

  it("replaces live text range on subsequent deltas", () => {
    const { view, dispatched } = makeEditorView("Hello ");
    const ref = { current: view };

    renderHook(() => useNoteVoiceInput("panel-1", ref));

    // First delta
    act(() => {
      useVoiceRecordingStore.setState({
        activeTarget: { panelId: "panel-1" },
        panelBuffers: {
          "panel-1": {
            liveText: "wor",
            completedSegments: [],
            sessionDraftStart: -1,
            draftLengthAtSegmentStart: -1,
            pendingCorrections: [],
            aiCorrectionSpans: [],
            activeParagraphStart: -1,
            transcriptPhase: "interim",
          },
        },
      });
    });

    // Second delta — replaces previous live text
    act(() => {
      useVoiceRecordingStore.setState((prev) => ({
        panelBuffers: {
          ...prev.panelBuffers,
          "panel-1": {
            ...prev.panelBuffers["panel-1"]!,
            liveText: "world",
          },
        },
      }));
    });

    expect(dispatched).toHaveLength(2);
    // First: insert "wor" at position 6
    expect(dispatched[0]).toEqual({ from: 6, to: 6, insert: "wor" });
    // Second: replace [6, 9] with "world"
    expect(dispatched[1]).toEqual({ from: 6, to: 9, insert: "world" });
  });

  it("handles segment completion by replacing live text with final text", () => {
    const { view, dispatched } = makeEditorView("Hello ");
    const ref = { current: view };

    renderHook(() => useNoteVoiceInput("panel-1", ref));

    // First delta
    act(() => {
      useVoiceRecordingStore.setState({
        activeTarget: { panelId: "panel-1" },
        panelBuffers: {
          "panel-1": {
            liveText: "wrld",
            completedSegments: [],
            sessionDraftStart: -1,
            draftLengthAtSegmentStart: -1,
            pendingCorrections: [],
            aiCorrectionSpans: [],
            activeParagraphStart: -1,
            transcriptPhase: "interim",
          },
        },
      });
    });

    // Segment completes — liveText cleared, final text in completedSegments
    act(() => {
      useVoiceRecordingStore.setState((prev) => ({
        panelBuffers: {
          ...prev.panelBuffers,
          "panel-1": {
            ...prev.panelBuffers["panel-1"]!,
            liveText: "",
            completedSegments: ["world"],
            transcriptPhase: "utterance_final",
          },
        },
      }));
    });

    expect(dispatched).toHaveLength(2);
    // Completion replaces the live range with final text
    expect(dispatched[1]).toEqual({ from: 6, to: 10, insert: "world" });
  });

  it("does nothing when editorViewRef is null", () => {
    const ref = { current: null };

    renderHook(() => useNoteVoiceInput("panel-1", ref));

    // Should not throw
    act(() => {
      useVoiceRecordingStore.setState({
        activeTarget: { panelId: "panel-1" },
        panelBuffers: {
          "panel-1": {
            liveText: "test",
            completedSegments: [],
            sessionDraftStart: -1,
            draftLengthAtSegmentStart: -1,
            pendingCorrections: [],
            aiCorrectionSpans: [],
            activeParagraphStart: -1,
            transcriptPhase: "interim",
          },
        },
      });
    });

    // No crash is the assertion
  });

  it("ignores buffer updates for a different panelId", () => {
    const { view, dispatched } = makeEditorView("Hello ");
    const ref = { current: view };

    renderHook(() => useNoteVoiceInput("panel-1", ref));

    act(() => {
      useVoiceRecordingStore.setState({
        activeTarget: { panelId: "panel-2" },
        panelBuffers: {
          "panel-2": {
            liveText: "world",
            completedSegments: [],
            sessionDraftStart: -1,
            draftLengthAtSegmentStart: -1,
            pendingCorrections: [],
            aiCorrectionSpans: [],
            activeParagraphStart: -1,
            transcriptPhase: "interim",
          },
        },
      });
    });

    expect(dispatched).toHaveLength(0);
  });

  it("handles back-to-back sessions (lastSegmentCountRef reset)", () => {
    const { view, dispatched } = makeEditorView("Hello ");
    const ref = { current: view };

    renderHook(() => useNoteVoiceInput("panel-1", ref));

    const makeBuffer = (liveText: string, completedSegments: string[]) => ({
      liveText,
      completedSegments,
      sessionDraftStart: -1,
      draftLengthAtSegmentStart: -1,
      pendingCorrections: [] as never[],
      aiCorrectionSpans: [] as never[],
      activeParagraphStart: -1,
      transcriptPhase: "interim" as const,
    });

    // Session 1: delta then complete
    act(() => {
      useVoiceRecordingStore.setState({
        activeTarget: { panelId: "panel-1" },
        panelBuffers: { "panel-1": makeBuffer("first", []) },
      });
    });
    act(() => {
      useVoiceRecordingStore.setState((prev) => ({
        panelBuffers: {
          ...prev.panelBuffers,
          "panel-1": {
            ...prev.panelBuffers["panel-1"]!,
            liveText: "",
            completedSegments: ["first"],
          },
        },
      }));
    });

    expect(dispatched).toHaveLength(2);

    // Session 2: beginSession resets completedSegments to []
    act(() => {
      useVoiceRecordingStore.setState((prev) => ({
        panelBuffers: {
          ...prev.panelBuffers,
          "panel-1": makeBuffer("", []),
        },
      }));
    });

    // New delta + complete in session 2
    act(() => {
      useVoiceRecordingStore.setState((prev) => ({
        panelBuffers: {
          ...prev.panelBuffers,
          "panel-1": makeBuffer("second", []),
        },
      }));
    });
    act(() => {
      useVoiceRecordingStore.setState((prev) => ({
        panelBuffers: {
          ...prev.panelBuffers,
          "panel-1": {
            ...prev.panelBuffers["panel-1"]!,
            liveText: "",
            completedSegments: ["second"],
          },
        },
      }));
    });

    // Should have 4 dispatches: 2 from session 1 + 2 from session 2
    expect(dispatched).toHaveLength(4);
    expect(dispatched[3]).toEqual(expect.objectContaining({ insert: "second" }));
  });

  it("resets tracking refs on cleanup", () => {
    const { view, dispatched } = makeEditorView("Hello ");
    const ref = { current: view };

    const { unmount } = renderHook(() => useNoteVoiceInput("panel-1", ref));

    // Start a delta
    act(() => {
      useVoiceRecordingStore.setState({
        activeTarget: { panelId: "panel-1" },
        panelBuffers: {
          "panel-1": {
            liveText: "wor",
            completedSegments: [],
            sessionDraftStart: -1,
            draftLengthAtSegmentStart: -1,
            pendingCorrections: [],
            aiCorrectionSpans: [],
            activeParagraphStart: -1,
            transcriptPhase: "interim",
          },
        },
      });
    });

    expect(dispatched).toHaveLength(1);

    // Unmount — should unsubscribe
    unmount();

    // Further store changes should not dispatch
    act(() => {
      useVoiceRecordingStore.setState((prev) => ({
        panelBuffers: {
          ...prev.panelBuffers,
          "panel-1": {
            ...prev.panelBuffers["panel-1"]!,
            liveText: "world",
          },
        },
      }));
    });

    // No additional dispatch after unmount
    expect(dispatched).toHaveLength(1);
  });
});
