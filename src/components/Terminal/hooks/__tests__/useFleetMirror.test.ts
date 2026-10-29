// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isolateHistory, undo, undoDepth } from "@codemirror/commands";
import { createComposerHistory } from "../../inputEditorExtensions/composerHistory";
import { useFleetMirror } from "../useFleetMirror";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetResolutionPreviewStore } from "@/store/fleetResolutionPreviewStore";

vi.mock("@/store/fleetResolutionPreviewStore", () => ({
  useFleetResolutionPreviewStore: vi.fn(),
}));

type MirrorParams = Parameters<typeof useFleetMirror>[0];

describe("useFleetMirror", () => {
  let setDraft: ReturnType<typeof vi.fn>;
  let clear: ReturnType<typeof vi.fn>;
  let setValue: ReturnType<typeof vi.fn>;
  let editorViewRef: { current: any };

  beforeEach(() => {
    setDraft = vi.fn();
    clear = vi.fn();
    setValue = vi.fn();
    editorViewRef = {
      current: {
        state: { doc: { toString: () => "hello" } },
        dispatch: vi.fn(),
      },
    };

    useTerminalInputStore.setState({ draftInputs: new Map(), fleetDraftHolds: new Map() });
    useFleetArmingStore.getState().armIds(["term-1", "term-2"]);

    vi.mocked(useFleetResolutionPreviewStore).mockImplementation((_selector: unknown) => {
      return undefined as any;
    });

    (useFleetResolutionPreviewStore as any).getState = vi.fn(() => ({
      setDraft,
      clear,
    }));
  });

  function params(overrides: Partial<MirrorParams> = {}): MirrorParams {
    return {
      editorViewRef: editorViewRef as any,
      terminalId: "term-1",
      projectId: "proj-1",
      value: "hello",
      setValue: setValue as any,
      isFleetPrimary: false,
      isFleetFollower: false,
      disabled: false,
      lastEmittedValueRef: { current: "hello" } as any,
      ...overrides,
    };
  }

  function render(overrides: Partial<MirrorParams> = {}) {
    return renderHook((props: MirrorParams) => useFleetMirror(props), {
      initialProps: params(overrides),
    });
  }

  const draftOf = (id: string) => useTerminalInputStore.getState().getDraftInput(id, "proj-1");

  it("primary pushes draft to other armed panes", () => {
    useFleetArmingStore.getState().armIds(["term-1", "term-2", "term-3"]);

    render({ isFleetPrimary: true, value: "test draft" });

    expect(draftOf("term-2")).toBe("test draft");
    expect(draftOf("term-3")).toBe("test draft");
    expect(draftOf("term-1")).toBe("");
    expect(setDraft).toHaveBeenCalledWith("test draft");
  });

  it("pushes nothing from a primary whose fleet was cleared before its effect ran", () => {
    useTerminalInputStore.getState().setDraftInput("term-2", "b's own", "proj-1");
    useFleetArmingStore.getState().clear();

    render({ isFleetPrimary: true, value: "stale draft" });

    expect(draftOf("term-2")).toBe("b's own");
    expect(useTerminalInputStore.getState().fleetDraftHolds.size).toBe(0);
  });

  it("clears resolution preview when not primary or disabled", () => {
    render({ isFleetPrimary: false, disabled: false });
    expect(clear).toHaveBeenCalled();
  });

  it("follower takes the primary's draft without making it, or its own past edits, undoable", () => {
    const view = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({ doc: "", extensions: [createComposerHistory()] }),
    });
    view.dispatch({ changes: { from: 0, insert: "mine" }, userEvent: "input.type" });
    view.dispatch({ annotations: isolateHistory.of("after") });
    // An own deletion: undoing it would put "in" back into the mirrored text.
    view.dispatch({ changes: { from: 1, to: 3 }, userEvent: "delete" });
    editorViewRef.current = view;
    useTerminalInputStore.getState().setDraftInput("term-1", "driver text", "proj-1");

    render({ isFleetFollower: true, value: "me" });

    expect(view.state.doc.toString()).toBe("driver text");
    expect(undoDepth(view.state)).toBe(0);
    expect(undo(view)).toBe(false);
    expect(view.state.doc.toString()).toBe("driver text");
    view.destroy();
  });

  it("gives a follower leaving the fleet its own draft back, with none of the fleet's to undo into", () => {
    const view = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({ doc: "", extensions: [createComposerHistory()] }),
    });
    editorViewRef.current = view;
    useTerminalInputStore.getState().setDraftInput("term-1", "my own", "proj-1");
    useTerminalInputStore
      .getState()
      .mirrorFleetDraft("term-2", "driver text", new Set(["term-1", "term-2"]), "proj-1");
    const hook = render({ isFleetFollower: true, value: "my own" });
    expect(view.state.doc.toString()).toBe("driver text");
    // An edit made to the fleet's draft while this pane was its primary.
    view.dispatch({ changes: { from: 0, insert: "more " }, userEvent: "input.type" });

    act(() => {
      useTerminalInputStore.getState().releaseFleetDraftHolds(new Set());
    });
    hook.rerender(params({ value: "more driver text" }));

    expect(setValue).toHaveBeenLastCalledWith("my own");
    expect(view.state.doc.toString()).toBe("my own");
    expect(undo(view)).toBe(false);
    expect(view.state.doc.toString()).toBe("my own");
    view.destroy();
  });

  it("leaves a pane whose draft became the fleet's as it is when the fleet ends", () => {
    const view = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({ doc: "", extensions: [createComposerHistory()] }),
    });
    view.dispatch({ changes: { from: 0, insert: "shared" }, userEvent: "input.type" });
    editorViewRef.current = view;
    const hook = render({ isFleetPrimary: true, value: "shared" });
    setValue.mockClear();

    act(() => {
      useFleetArmingStore.getState().clear();
      useTerminalInputStore.getState().releaseFleetDraftHolds(new Set());
    });
    hook.rerender(params({ value: "shared" }));

    expect(setValue).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("shared");
    expect(undoDepth(view.state)).toBe(1);
    view.destroy();
  });

  it("clears resolution preview when primary but disabled", () => {
    render({ isFleetPrimary: true, disabled: true });
    expect(clear).toHaveBeenCalled();
  });
});
