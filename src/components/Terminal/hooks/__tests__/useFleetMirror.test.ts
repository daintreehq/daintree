// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useLayoutEffect } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
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
  let views: EditorView[];

  beforeEach(() => {
    views = [];
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

  afterEach(() => {
    cleanup();
    for (const view of views) view.destroy();
    useFleetArmingStore.getState().clear();
  });

  function makeView(): EditorView {
    const view = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({ doc: "", extensions: [createComposerHistory()] }),
    });
    views.push(view);
    return view;
  }

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
      syncedDraftRef: { current: "hello" } as any,
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

  /** Renders a primary of {term-1, term-2} whose fleet becomes `live` before its effects run. */
  function renderPrimaryOvertakenBy(live: string[], value: string) {
    return renderHook(() => {
      useLayoutEffect(() => {
        useFleetArmingStore.getState().armIds(live);
      }, []);
      return useFleetMirror(params({ isFleetPrimary: true, value }));
    });
  }

  it.each([
    ["cleared", []],
    ["left with only this pane", ["term-1"]],
    ["armed without this pane", ["term-2", "term-3"]],
  ])("pushes nothing from a primary whose fleet was %s before its effect ran", (_, live) => {
    useTerminalInputStore.getState().setDraftInput("term-2", "b's own", "proj-1");

    renderPrimaryOvertakenBy(live, "stale draft");

    expect(draftOf("term-2")).toBe("b's own");
    expect(useTerminalInputStore.getState().fleetDraftHolds.size).toBe(0);
    expect(setDraft).not.toHaveBeenCalled();
  });

  it("pushes to the fleet as it is when its effect runs, not as it rendered", () => {
    useTerminalInputStore.getState().setDraftInput("term-2", "b's own", "proj-1");

    renderPrimaryOvertakenBy(["term-1", "term-3"], "fresh draft");

    expect(draftOf("term-2")).toBe("b's own");
    expect(draftOf("term-3")).toBe("fresh draft");
  });

  it("pushes nothing from a disabled primary", () => {
    useTerminalInputStore.getState().setDraftInput("term-2", "b's own", "proj-1");

    render({ isFleetPrimary: true, disabled: true, value: "draft" });

    expect(draftOf("term-2")).toBe("b's own");
    expect(useTerminalInputStore.getState().fleetDraftHolds.size).toBe(0);
  });

  it("clears resolution preview when not primary or disabled", () => {
    render({ isFleetPrimary: false, disabled: false });
    expect(clear).toHaveBeenCalled();
  });

  it("follower takes the primary's draft without making it, or its own past edits, undoable", () => {
    const view = makeView();
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
  });

  /** A pane holding `own`, mirrored the fleet's `shared`, then focused to edit it. */
  function heldPaneTakingFocus(own: string, shared: string) {
    const view = makeView();
    editorViewRef.current = view;
    const store = useTerminalInputStore.getState();
    store.setDraftInput("term-1", own, "proj-1");
    store.mirrorFleetDraft("term-2", shared, new Set(["term-1", "term-2"]), "proj-1");
    const hook = render({ isFleetFollower: true, value: own });
    expect(view.state.doc.toString()).toBe(shared);
    hook.rerender(params({ isFleetPrimary: true, value: shared }));
    return { view, hook };
  }

  function leaveFleet(hook: ReturnType<typeof render>, value: string) {
    act(() => {
      useFleetArmingStore.getState().clear();
      useTerminalInputStore.getState().releaseFleetDraftHolds(new Set());
    });
    hook.rerender(params({ value }));
  }

  it("gives a pane leaving the fleet its own draft back, with none of the fleet's edits to undo into", () => {
    const { view, hook } = heldPaneTakingFocus("my own", "driver text");
    // Deleted from the fleet's draft: undone, it would come back into this one.
    view.dispatch({ changes: { from: 0, to: 7 }, userEvent: "delete" });
    hook.rerender(params({ isFleetPrimary: true, value: "text" }));
    expect(draftOf("term-2")).toBe("text");
    expect(undoDepth(view.state)).toBeGreaterThan(0);

    leaveFleet(hook, "text");

    expect(setValue).toHaveBeenLastCalledWith("my own");
    expect(view.state.doc.toString()).toBe("my own");
    expect(undo(view)).toBe(false);
    expect(view.state.doc.toString()).toBe("my own");
  });

  it("leaves none of the fleet's edits to undo into when they ended on the pane's own text", () => {
    const { view, hook } = heldPaneTakingFocus("my own", "my own, shared");
    view.dispatch({ changes: { from: 6, to: 14 }, userEvent: "delete" });
    hook.rerender(params({ isFleetPrimary: true, value: "my own" }));
    expect(undoDepth(view.state)).toBeGreaterThan(0);

    leaveFleet(hook, "my own");

    expect(view.state.doc.toString()).toBe("my own");
    expect(undo(view)).toBe(false);
    expect(view.state.doc.toString()).toBe("my own");
  });

  it("leaves a pane whose draft became the fleet's as it is when the fleet ends", () => {
    const view = makeView();
    view.dispatch({ changes: { from: 0, insert: "shared" }, userEvent: "input.type" });
    editorViewRef.current = view;
    const hook = render({ isFleetPrimary: true, value: "shared" });
    setValue.mockClear();

    leaveFleet(hook, "shared");

    expect(setValue).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("shared");
    expect(undoDepth(view.state)).toBe(1);
  });

  it("clears resolution preview when primary but disabled", () => {
    render({ isFleetPrimary: true, disabled: true });
    expect(clear).toHaveBeenCalled();
  });
});
