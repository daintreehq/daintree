// @vitest-environment jsdom
/**
 * Starting dictation takes the keyboard to the selected pane's hybrid input
 * (#14770). Composed from the real bar and the real request machinery, with a
 * registry handler standing in for TerminalPane's.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import type { PtyPanelData } from "@shared/types/panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { focusPanelInput, registerPanelFocusHandler } from "@/components/Panel/panelFocusRegistry";
import { HybridInputBar, type HybridInputBarHandle } from "@/components/Terminal/HybridInputBar";
import {
  _resetPaneFocusRequestsForTesting,
  requestedForDictation,
  requestedPaneSurface,
} from "@/components/Terminal/paneFocusRequest";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import {
  beginDictationReturn,
  focusDictationComposer,
  revealDictationComposer,
} from "../voiceComposerFocus";

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

let unregister: (() => void) | null = null;

beforeEach(() => {
  initBuiltInPanelKinds();
  setCurrentViewStore(createWorktreeStore());
  const panel = (id: string) =>
    ({
      id,
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
    }) as PtyPanelData;
  usePanelStore.setState({
    panelsById: { "term-1": panel("term-1"), "term-2": panel("term-2") },
    panelIds: ["term-1", "term-2"],
    panelIdsByWorktreeId: { [WT_ID]: ["term-1", "term-2"] },
    focusedId: "term-1",
  });
  // The setting that sends the keyboard to the terminal after every send.
  useTerminalInputStore.setState({ draftInputs: new Map(), hybridInputAutoFocus: false });
  frames = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    frames.push(cb);
    return frames.length;
  });
});

afterEach(() => {
  unregister?.();
  unregister = null;
  cleanup();
  vi.restoreAllMocks();
  _resetPaneFocusRequestsForTesting();
  document.body.innerHTML = "";
});

async function mountPane() {
  const ref = createRef<HybridInputBarHandle>();
  const result = render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={createWorktreeStore()}>
        <div data-panel-id="term-1">
          <div className="xterm">
            <textarea data-testid="xterm-input" />
          </div>
          <HybridInputBar
            ref={ref}
            terminalId="term-1"
            cwd={WT_ID}
            agentId="claude"
            onSend={() => {}}
          />
        </div>
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  await act(async () => {});
  flushFrames();
  const view = EditorView.findFromDOM(result.container.querySelector<HTMLElement>(".cm-editor")!)!;
  unregister = registerPanelFocusHandler("term-1", (surface) =>
    surface === "hybridInput" ? ref.current!.focusWithCursorAtEnd() : false
  );
  const terminal = result.getByTestId("xterm-input") as HTMLTextAreaElement;
  return { view, editor: view.contentDOM, terminal };
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

/** The click that puts the keyboard on `el`: the press, then the focus it brings. */
function clickInto(el: HTMLElement) {
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  el.focus();
}

function elsewhere(markup: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = markup;
  document.body.appendChild(host);
  return host.firstElementChild as HTMLElement;
}

describe("focusDictationComposer", () => {
  it("moves the keyboard from the terminal to the hybrid input, whatever the focus setting says", async () => {
    const { view, editor, terminal } = await mountPane();
    await write("hello world");
    await showCaret(view, 5);
    terminal.focus();

    focusDictationComposer("term-1");
    flushFrames();

    expect(document.activeElement).toBe(editor);
    expect(selection(view)).toEqual({ anchor: 5, head: 5 });
    expect(requestedForDictation("term-1")).toBe(true);
  });

  it("keeps a selection that dictation is about to replace", async () => {
    const { view, editor, terminal } = await mountPane();
    await write("hello world");
    await showCaret(view, 0, 5);
    terminal.focus();

    focusDictationComposer("term-1");
    flushFrames();

    expect(document.activeElement).toBe(editor);
    expect(selection(view)).toEqual({ anchor: 0, head: 5 });
  });

  it("moves nothing for a hybrid input that already holds the keyboard", async () => {
    const { view, editor } = await mountPane();
    await write("hello world");
    view.focus();
    expect(document.activeElement).toBe(editor);
    const dispatch = vi.spyOn(view, "dispatch");

    focusDictationComposer("term-1");
    flushFrames();

    expect(dispatch).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(editor);
  });

  it("takes the keyboard from the control that started it", async () => {
    const { editor } = await mountPane();
    const mic = elsewhere("<button>Dictate</button>");
    mic.focus();

    focusDictationComposer("term-1");
    flushFrames();

    expect(document.activeElement).toBe(editor);
  });

  describe("once the session is under way", () => {
    // A real session's words and stop are in VoiceRecordingService.handoff.test.ts.
    it("leaves a click into the terminal where it landed, whatever asks for frames after", async () => {
      const { editor, terminal } = await mountPane();
      terminal.focus();
      focusDictationComposer("term-1");
      flushFrames();
      expect(document.activeElement).toBe(editor);

      clickInto(terminal);
      flushFrames();

      expect(document.activeElement).toBe(terminal);
      expect(requestedPaneSurface("term-1")).toBeNull();
    });

    it("leaves a click that lands while the grab is still waiting for its frame", async () => {
      const { editor, terminal } = await mountPane();
      terminal.focus();
      focusDictationComposer("term-1");

      clickInto(terminal);
      flushFrames();

      expect(document.activeElement).toBe(terminal);
      expect(document.activeElement).not.toBe(editor);
    });

    it("leaves a move to another field, with no click", async () => {
      const { terminal } = await mountPane();
      terminal.focus();
      focusDictationComposer("term-1");
      const field = elsewhere("<input />");
      field.focus();

      flushFrames();

      expect(document.activeElement).toBe(field);
    });
  });

  describe("never a different pane", () => {
    it("does nothing for a locked target that isn't the selected pane", async () => {
      const { terminal } = await mountPane();
      terminal.focus();

      focusDictationComposer("term-2");
      flushFrames();

      expect(document.activeElement).toBe(terminal);
      expect(requestedPaneSurface("term-2")).toBeNull();
      expect(requestedPaneSurface("term-1")).toBeNull();
    });

    // Nothing typing holds the keyboard, so only the selection says whose it is.
    it("leaves the keyboard on a control when the locked target isn't the selected pane", async () => {
      await mountPane();
      const mic = elsewhere("<button>Dictate</button>");
      mic.focus();

      focusDictationComposer("term-2");
      flushFrames();

      expect(document.activeElement).toBe(mic);
      expect(requestedPaneSurface("term-2")).toBeNull();
    });

    it("leaves the keyboard on another pane's typing surface", async () => {
      await mountPane();
      const other = elsewhere('<div data-panel-id="term-2"><textarea></textarea></div>');
      const field = other.querySelector("textarea")!;
      field.focus();

      focusDictationComposer("term-1");
      flushFrames();

      expect(document.activeElement).toBe(field);
    });

    it("leaves the keyboard in a field that belongs to no pane", async () => {
      await mountPane();
      const field = elsewhere("<input />");
      field.focus();

      focusDictationComposer("term-1");
      flushFrames();

      expect(document.activeElement).toBe(field);
    });

    it("leaves an open modal alone", async () => {
      await mountPane();
      const dialog = elsewhere('<div role="dialog" aria-modal="true"><button>OK</button></div>');
      dialog.querySelector("button")!.focus();

      focusDictationComposer("term-1");
      flushFrames();

      expect(document.activeElement).toBe(dialog.querySelector("button"));
    });
  });
});

describe("revealDictationComposer (#14773)", () => {
  it("takes the keyboard from another pane's field this view last left it in", async () => {
    const { editor } = await mountPane();
    const other = elsewhere('<div data-panel-id="term-2"><textarea></textarea></div>');
    other.querySelector("textarea")!.focus();

    revealDictationComposer("term-1");
    flushFrames();

    expect(document.activeElement).toBe(editor);
    expect(requestedForDictation("term-1")).toBe(true);
  });

  it("leaves an open modal alone", async () => {
    await mountPane();
    const dialog = elsewhere('<div role="dialog" aria-modal="true"><button>OK</button></div>');
    dialog.querySelector("button")!.focus();

    revealDictationComposer("term-1");
    flushFrames();

    expect(document.activeElement).toBe(dialog.querySelector("button"));
  });

  it("does nothing for a pane that isn't the selected one", async () => {
    const { terminal } = await mountPane();
    terminal.focus();

    revealDictationComposer("term-2");
    flushFrames();

    expect(document.activeElement).toBe(terminal);
    expect(requestedPaneSurface("term-2")).toBeNull();
  });
});

describe("beginDictationReturn (#14791)", () => {
  it("takes the keyboard back from another pane's field, caret after the dictated words", async () => {
    const { view, editor } = await mountPane();
    await write("fix the login bug please");
    // Left at the start of the draft before the person went elsewhere.
    await showCaret(view, 0);
    const other = elsewhere('<div data-panel-id="term-2"><textarea></textarea></div>');
    const field = other.querySelector("textarea")!;
    field.value = "half typed";
    field.focus();

    const finish = beginDictationReturn("term-1");
    finish!(() => 17);
    flushFrames();

    expect(document.activeElement).toBe(editor);
    expect(selection(view)).toEqual({ anchor: 17, head: 17 });
    expect(field.value).toBe("half typed");
  });

  it("puts the caret after the words in a composer that never showed one, not at the end", async () => {
    const { view, editor, terminal } = await mountPane();
    await write("fix the login bug please");
    terminal.focus();

    beginDictationReturn("term-1")!(() => 17);
    flushFrames();

    expect(document.activeElement).toBe(editor);
    expect(selection(view)).toEqual({ anchor: 17, head: 17 });
  });

  it("keeps the composer's own caret when there are no words to go after", async () => {
    const { view, editor, terminal } = await mountPane();
    await write("hello world");
    await showCaret(view, 5);
    terminal.focus();

    beginDictationReturn("term-1")!(() => null);
    flushFrames();

    expect(document.activeElement).toBe(editor);
    expect(selection(view)).toEqual({ anchor: 5, head: 5 });
  });

  it("places the caret once: a later grab for the same return leaves it where the person put it", async () => {
    const { view, editor, terminal } = await mountPane();
    await write("fix the login bug please");
    terminal.focus();
    beginDictationReturn("term-1")!(() => 17);
    flushFrames();
    await showCaret(view, 3);
    // A control takes the keyboard without ending the return, then the pane asks again.
    elsewhere("<button>Copy</button>").focus();

    focusPanelInput("term-1", "hybridInput");
    flushFrames();

    expect(document.activeElement).toBe(editor);
    expect(selection(view)).toEqual({ anchor: 3, head: 3 });
  });

  it("does nothing, caret included, when the keyboard is in the composer already", async () => {
    const { view, editor } = await mountPane();
    await write("hello world");
    view.focus();
    const dispatch = vi.spyOn(view, "dispatch");

    expect(beginDictationReturn("term-1")).toBeNull();
    flushFrames();

    expect(dispatch).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(editor);
    expect(requestedPaneSurface("term-1")).toBeNull();
  });

  it("leaves an open modal alone", async () => {
    await mountPane();
    const dialog = elsewhere('<div role="dialog" aria-modal="true"><button>OK</button></div>');
    dialog.querySelector("button")!.focus();

    expect(beginDictationReturn("term-1")).toBeNull();
  });

  it("is called off by a press before the pane is ready", async () => {
    const { terminal } = await mountPane();
    terminal.focus();
    const finish = beginDictationReturn("term-1");
    const field = elsewhere("<input />");

    clickInto(field);
    finish!(() => 3);
    flushFrames();

    expect(document.activeElement).toBe(field);
    expect(requestedPaneSurface("term-1")).toBeNull();
  });

  it("has nothing to go back to for the assistant, whose input isn't a pane", async () => {
    await mountPane();
    const { activeSlot, sessions } = useHelpPanelStore.getState();
    const before = sessions;
    useHelpPanelStore.setState({
      sessions: { ...sessions, [activeSlot]: { ...sessions[activeSlot]!, terminalId: "term-1" } },
    });
    try {
      expect(beginDictationReturn("term-1")).toBeNull();
    } finally {
      useHelpPanelStore.setState({ sessions: before });
    }
  });
});
