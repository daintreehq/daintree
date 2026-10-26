// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { undoDepth } from "@codemirror/commands";
import { createComposerHistory } from "../../inputEditorExtensions/composerHistory";
import { useFleetMirror } from "../useFleetMirror";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetResolutionPreviewStore } from "@/store/fleetResolutionPreviewStore";

vi.mock("@/store/terminalInputStore", () => ({
  useTerminalInputStore: vi.fn(),
}));

vi.mock("@/store/fleetArmingStore", () => ({
  useFleetArmingStore: vi.fn(),
}));

vi.mock("@/store/fleetResolutionPreviewStore", () => ({
  useFleetResolutionPreviewStore: vi.fn(),
}));

describe("useFleetMirror", () => {
  let setDraftInput: ReturnType<typeof vi.fn>;
  let setDraft: ReturnType<typeof vi.fn>;
  let clear: ReturnType<typeof vi.fn>;
  let setValue: ReturnType<typeof vi.fn>;
  let viewDispatch: ReturnType<typeof vi.fn>;
  let editorViewRef: { current: any };

  beforeEach(() => {
    setDraftInput = vi.fn();
    setDraft = vi.fn();
    clear = vi.fn();
    setValue = vi.fn();
    viewDispatch = vi.fn();
    editorViewRef = {
      current: {
        state: { doc: { toString: () => "hello" } },
        dispatch: viewDispatch,
      },
    };

    vi.mocked(useTerminalInputStore).mockImplementation((_selector: unknown) => {
      return "" as any;
    });

    (useTerminalInputStore as any).getState = vi.fn(() => ({
      setDraftInput,
      draftInputs: new Map(),
    }));

    vi.mocked(useFleetArmingStore).mockImplementation((_selector: unknown) => {
      return new Set(["term-1", "term-2"]) as any;
    });

    vi.mocked(useFleetResolutionPreviewStore).mockImplementation((_selector: unknown) => {
      return undefined as any;
    });

    (useFleetResolutionPreviewStore as any).getState = vi.fn(() => ({
      setDraft,
      clear,
    }));
  });

  function render(overrides: Partial<Parameters<typeof useFleetMirror>[0]> = {}) {
    return renderHook(() =>
      useFleetMirror({
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
      })
    );
  }

  it("primary pushes draft to other armed panes", () => {
    (useTerminalInputStore as any).getState = vi.fn(() => ({
      setDraftInput,
      draftInputs: new Map(),
    }));

    vi.mocked(useFleetArmingStore).mockImplementation((_selector: unknown) => {
      return new Set(["term-1", "term-2", "term-3"]) as any;
    });

    render({ isFleetPrimary: true, value: "test draft" } as any);

    expect(setDraftInput).toHaveBeenCalledWith("term-2", "test draft", "proj-1");
    expect(setDraftInput).toHaveBeenCalledWith("term-3", "test draft", "proj-1");
    expect(setDraftInput).not.toHaveBeenCalledWith("term-1", expect.anything(), expect.anything());
    expect(setDraft).toHaveBeenCalledWith("test draft");
  });

  it("clears resolution preview when not primary or disabled", () => {
    render({ isFleetPrimary: false, disabled: false } as any);
    expect(clear).toHaveBeenCalled();
  });

  it("follower takes the primary's draft without making it, or its own past edits, undoable", () => {
    const view = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({ doc: "", extensions: [createComposerHistory()] }),
    });
    view.dispatch({ changes: { from: 0, insert: "mine" }, userEvent: "input.type" });
    editorViewRef.current = view;
    vi.mocked(useTerminalInputStore).mockImplementation(() => "driver text" as any);

    render({ isFleetFollower: true, value: "mine" } as any);

    expect(view.state.doc.toString()).toBe("driver text");
    expect(undoDepth(view.state)).toBe(0);
    view.destroy();
  });

  it("clears resolution preview when primary but disabled", () => {
    render({ isFleetPrimary: true, disabled: true } as any);
    expect(clear).toHaveBeenCalled();
  });
});
