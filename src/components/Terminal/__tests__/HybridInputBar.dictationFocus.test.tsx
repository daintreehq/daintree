// @vitest-environment jsdom
/**
 * Dictation takes the keyboard for a composer it is about to write into
 * (#14770). The words go at the caret the composer last showed in the draft, or
 * at the end of a draft nobody focused, so that is where the grab has to leave
 * the caret (#14634).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import type { PtyPanelData } from "@shared/types/panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { HybridInputBar, type HybridInputBarHandle } from "../HybridInputBar";
import { SCRATCHPAD_BOUNDARY_ATTR } from "@/lib/terminalScratchpad";
import { _resetPaneFocusRequestsForTesting, requestPaneFocus } from "../paneFocusRequest";

const WT_ID = "/repo/wt";

// jsdom has no layout: CodeMirror measures text through Range rects it lacks.
const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
const originalRangeBounds = Range.prototype.getBoundingClientRect;
beforeAll(() => {
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterAll(() => {
  if (originalRangeRects)
    Object.defineProperty(Range.prototype, "getClientRects", originalRangeRects);
  else delete (Range.prototype as Partial<Range>).getClientRects;
  Range.prototype.getBoundingClientRect = originalRangeBounds;
});

let frames: FrameRequestCallback[] = [];
function flushFrames() {
  act(() => {
    while (frames.length > 0) {
      const due = frames;
      frames = [];
      for (const cb of due) cb(0);
    }
  });
}

beforeEach(() => {
  initBuiltInPanelKinds();
  setCurrentViewStore(createWorktreeStore());
  const panel = {
    id: "term-1",
    title: "claude",
    kind: "terminal",
    cwd: WT_ID,
    cols: 120,
    rows: 40,
    worktreeId: WT_ID,
    location: "grid",
    hasPty: true,
    detectedAgentId: "claude",
    launchAgentId: "claude",
    agentState: "waiting",
    runtimeStatus: "running",
  } as PtyPanelData;
  usePanelStore.setState({
    panelsById: { [panel.id]: panel },
    panelIds: [panel.id],
    panelIdsByWorktreeId: { [WT_ID]: [panel.id] },
    focusedId: panel.id,
  });
  useTerminalInputStore.setState({ draftInputs: new Map(), hybridInputAutoFocus: true });
  frames = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    frames.push(cb);
    return frames.length;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  _resetPaneFocusRequestsForTesting();
  document.body.innerHTML = "";
});

async function mount() {
  const ref = createRef<HybridInputBarHandle>();
  const result = render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={createWorktreeStore()}>
        <HybridInputBar
          ref={ref}
          terminalId="term-1"
          cwd={WT_ID}
          agentId="claude"
          onSend={() => {}}
        />
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  await act(async () => {});
  flushFrames();
  const view = EditorView.findFromDOM(result.container.querySelector<HTMLElement>(".cm-editor")!)!;
  return { ref, view, editor: view.contentDOM };
}

async function write(text: string): Promise<void> {
  await act(async () => {
    const inputs = useTerminalInputStore.getState();
    inputs.setDraftInput("term-1", text);
    inputs.bumpExternalDraftRevision();
  });
}

// The composer "has been focused" for the caret tracker without taking the
// keyboard: jsdom's DOM selection never follows a dispatched one, and a focused
// editor reads it back over the caret.
async function showCaret(view: EditorView, anchor: number, head = anchor): Promise<void> {
  Object.defineProperty(view, "hasFocus", { configurable: true, get: () => true });
  await act(async () => {
    view.dispatch({ selection: { anchor, head } });
  });
}

const selection = (view: EditorView) => {
  const { anchor, head } = view.state.selection.main;
  return { anchor, head };
};

function press() {
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
}

/** What dictation's start asks of the pane, then the grab the pane's handler runs. */
function dictate(ref: { current: HybridInputBarHandle | null }) {
  requestPaneFocus("term-1", "hybridInput", { forDictation: true });
  return ref.current!.focusWithCursorAtEnd();
}

describe("HybridInputBar focus for dictation", () => {
  it("takes the keyboard and leaves the caret the composer showed", async () => {
    const { ref, view, editor } = await mount();
    await write("hello world");
    await showCaret(view, 5);

    expect(dictate(ref)).toBe(true);
    flushFrames();

    expect(document.activeElement).toBe(editor);
    expect(selection(view)).toEqual({ anchor: 5, head: 5 });
  });

  it("keeps a selection that dictation is about to replace, whichever way it runs", async () => {
    const { ref, view, editor } = await mount();
    await write("hello world");
    await showCaret(view, 7, 2);

    dictate(ref);
    flushFrames();

    expect(document.activeElement).toBe(editor);
    expect(selection(view)).toEqual({ anchor: 7, head: 2 });
  });

  // Where dictation appends a draft nobody focused. Focusing it leaves
  // CodeMirror's caret at 0, which the tracker would then publish as the
  // place to dictate.
  it("puts the caret of a composer nobody focused at the end of the draft", async () => {
    const { ref, view, editor } = await mount();
    await write("hello world");
    await act(async () => {
      view.dispatch({ selection: { anchor: 0 } });
    });

    dictate(ref);
    flushFrames();

    expect(document.activeElement).toBe(editor);
    expect(selection(view)).toEqual({ anchor: 11, head: 11 });
  });

  // Dictation reads the store's draft: a caret recorded for text the draft no
  // longer holds is no place to write.
  it("puts the caret at the end of what the editor shows once the store's draft has moved on", async () => {
    const { ref, view } = await mount();
    await write("hello");
    await showCaret(view, 2);
    useTerminalInputStore.getState().setDraftInput("term-1", "hello there");

    dictate(ref);
    flushFrames();

    expect(selection(view)).toEqual({ anchor: 5, head: 5 });
  });

  it("moves nothing for an editor that already holds the keyboard", async () => {
    const { ref, view, editor } = await mount();
    await write("hello world");
    view.focus();
    expect(document.activeElement).toBe(editor);
    const dispatch = vi.spyOn(view, "dispatch");

    expect(dictate(ref)).toBe(true);
    flushFrames();

    expect(dispatch).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(editor);
  });

  it("drops a grab a press arrived ahead of", async () => {
    const { ref, view, editor } = await mount();
    await write("hello world");
    await showCaret(view, 5);

    dictate(ref);
    press();
    flushFrames();

    expect(document.activeElement).not.toBe(editor);
    expect(selection(view)).toEqual({ anchor: 5, head: 5 });
  });

  // The request names this bar, so a terminal home doesn't veto the grab.
  it("lands against a terminal home", async () => {
    useTerminalInputStore.setState({ hybridInputAutoFocus: false });
    const { ref, view, editor } = await mount();
    await write("hello world");
    await showCaret(view, 5);

    dictate(ref);
    flushFrames();

    expect(document.activeElement).toBe(editor);
    expect(selection(view)).toEqual({ anchor: 5, head: 5 });
  });

  // Starting dictation is the user's own move to the bar, unlike a drop or a
  // restore that must not take the notes' caret (#12835).
  it("takes the keyboard from the pane's Scratchpad", async () => {
    const { ref, editor } = await mount();
    const notes = document.createElement("div");
    notes.setAttribute(SCRATCHPAD_BOUNDARY_ATTR, "term-1");
    notes.innerHTML = "<textarea></textarea>";
    document.body.appendChild(notes);
    notes.querySelector("textarea")!.focus();

    dictate(ref);
    flushFrames();

    expect(document.activeElement).toBe(editor);
  });

  it("takes a request made before it loaded from the pane's Scratchpad", async () => {
    const notes = document.createElement("div");
    notes.setAttribute(SCRATCHPAD_BOUNDARY_ATTR, "term-1");
    notes.innerHTML = "<textarea></textarea>";
    document.body.appendChild(notes);
    notes.querySelector("textarea")!.focus();
    requestPaneFocus("term-1", "hybridInput", { forDictation: true });

    const { editor } = await mount();

    expect(document.activeElement).toBe(editor);
  });

  it("takes a request made before it loaded, with the caret at the end of a restored draft", async () => {
    useTerminalInputStore.getState().setDraftInput("term-1", "hello world");
    requestPaneFocus("term-1", "hybridInput", { forDictation: true });

    const { view, editor } = await mount();

    expect(document.activeElement).toBe(editor);
    expect(selection(view)).toEqual({ anchor: 11, head: 11 });
  });

  // `handle.focus()` is the bar's other way in, and the one a late mount uses.
  describe("through the plain focus handle", () => {
    it("leaves a recorded selection alone", async () => {
      const { ref, view, editor } = await mount();
      await write("hello world");
      await showCaret(view, 2, 7);
      requestPaneFocus("term-1", "hybridInput", { forDictation: true });

      ref.current!.focus();
      flushFrames();

      expect(document.activeElement).toBe(editor);
      expect(selection(view)).toEqual({ anchor: 2, head: 7 });
    });

    it("moves nothing for an editor that already holds the keyboard, whatever the store says", async () => {
      const { ref, view, editor } = await mount();
      await write("hello world");
      view.focus();
      useTerminalInputStore.getState().setDraftInput("term-1", "something else");
      requestPaneFocus("term-1", "hybridInput", { forDictation: true });
      const dispatch = vi.spyOn(view, "dispatch");

      ref.current!.focus();
      flushFrames();

      expect(dispatch).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(editor);
    });

    it("parks nothing for a focus dictation didn't ask for", async () => {
      const { ref, view } = await mount();
      await write("hello world");
      await act(async () => {
        view.dispatch({ selection: { anchor: 0 } });
      });

      ref.current!.focus();
      flushFrames();

      expect(selection(view)).toEqual({ anchor: 0, head: 0 });
    });
  });

  it("leaves the plain end-of-draft grab dragging the caret to the end", async () => {
    const { ref, view } = await mount();
    await write("hello world");
    await showCaret(view, 5);

    requestPaneFocus("term-1", "hybridInput");
    ref.current!.focusWithCursorAtEnd();
    flushFrames();

    expect(selection(view)).toEqual({ anchor: 11, head: 11 });
  });
});
