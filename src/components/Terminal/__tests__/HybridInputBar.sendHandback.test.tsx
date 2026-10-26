// @vitest-environment jsdom
/**
 * A terminal-first user sends from the hybrid input and gets the keyboard back
 * on the pane's terminal, once the terminal has accepted the send and only if
 * they are still where the send left them (#14692).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fleetBroadcast = vi.hoisted(() =>
  vi.fn((_terminalId: string, _text: string, _onSent: () => void) => false)
);
vi.mock("@/components/Fleet/fleetEnterBroadcast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/Fleet/fleetEnterBroadcast")>();
  return { ...actual, tryFleetBroadcastFromEditor: fleetBroadcast };
});

import { act, cleanup, render } from "@testing-library/react";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import type { PtyPanelData } from "@shared/types/panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { registerPanelFocusHandler } from "@/components/Panel/panelFocusRegistry";
import { voiceRecordingService } from "@/services/VoiceRecordingService";
import { UI_EXIT_DURATION } from "@/lib/animationUtils";
import { HybridInputBar } from "../HybridInputBar";
import { _resetPaneFocusRequestsForTesting, requestPaneFocus } from "../paneFocusRequest";

const WT_ID = "/repo/wt";
const isMac = /Mac/.test(navigator.platform);
/** Comfortably past the Expanded Editor's exit, after which the dialog hands focus back. */
const PAST_DIALOG_EXIT_MS = UI_EXIT_DURATION * 2;
const originalElectron = Object.getOwnPropertyDescriptor(window, "electron");

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

let unregisterTerminal: (() => void) | null = null;
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
  useTerminalInputStore.setState({ draftInputs: new Map(), hybridInputAutoFocus: false });
  fleetBroadcast.mockReset();
  fleetBroadcast.mockReturnValue(false);
  frames = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    frames.push(cb);
    return frames.length;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  unregisterTerminal?.();
  unregisterTerminal = null;
  _resetPaneFocusRequestsForTesting();
  useVoiceRecordingStore.setState({ status: "idle", activeTarget: null });
  useFleetArmingStore.setState({ armedIds: new Set() });
  if (originalElectron) Object.defineProperty(window, "electron", originalElectron);
  else delete (window as { electron?: unknown }).electron;
  delete document.body.dataset.performanceMode;
  document.body.innerHTML = "";
});

/** The pane's terminal, standing in for TerminalPane's focus handler and its xterm. */
function terminal() {
  const pane = document.createElement("div");
  pane.setAttribute("data-panel-id", "term-1");
  pane.innerHTML = '<div class="xterm"><textarea></textarea></div>';
  document.body.appendChild(pane);
  const textarea = pane.querySelector("textarea")!;
  const handler = vi.fn((surface?: string) => {
    if (surface !== "xterm") return false;
    textarea.focus();
    return true;
  });
  unregisterTerminal = registerPanelFocusHandler("term-1", handler);
  return { textarea, handler };
}

async function mount({ isolated = false } = {}) {
  const term = terminal();
  const settles: Array<(accepted: boolean) => void> = [];
  const onSend = vi.fn(() => new Promise<boolean>((resolve) => settles.push(resolve)));
  const result = render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={createWorktreeStore()}>
        <HybridInputBar
          terminalId="term-1"
          cwd={WT_ID}
          agentId="claude"
          onSend={onSend}
          isolated={isolated}
        />
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  await act(async () => {});
  const view = EditorView.findFromDOM(result.container.querySelector<HTMLElement>(".cm-editor")!)!;
  view.contentDOM.focus();

  const type = async (text: string) => {
    await act(async () => {
      view.dispatch({
        changes: { from: view.state.doc.length, insert: text },
        userEvent: "input.type",
      });
    });
  };
  const openExpandedEditor = async () => {
    await act(async () => {
      runScopeHandlers(
        view,
        new KeyboardEvent("keydown", { key: "e", shiftKey: true, metaKey: isMac, ctrlKey: !isMac }),
        "editor"
      );
    });
    flushFrames();
  };
  const pressEnter = async () => {
    await act(async () => {
      runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Enter" }), "editor");
    });
  };
  /** The terminal's answer to the oldest send still waiting on one. */
  const settle = async (accepted: boolean) => {
    await act(async () => {
      settles.shift()!(accepted);
    });
  };
  return { ...result, view, onSend, type, openExpandedEditor, pressEnter, settle, ...term };
}

function press() {
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
}

describe("HybridInputBar hands the keyboard back to a terminal-first user's terminal", () => {
  it("moves the keyboard to the terminal once the send is accepted", async () => {
    const { view, type, pressEnter, settle, textarea, onSend } = await mount();
    await type("ship it");
    await pressEnter();

    expect(onSend).toHaveBeenCalledTimes(1);
    // Sent but not yet accepted: the keyboard waits where it is.
    expect(document.activeElement).toBe(view.contentDOM);

    await settle(true);

    expect(document.activeElement).toBe(textarea);
  });

  it("leaves the keyboard in the hybrid input when the send fails", async () => {
    const { view, type, pressEnter, settle, handler } = await mount();
    await type("ship it");
    await pressEnter();

    await settle(false);

    expect(document.activeElement).toBe(view.contentDOM);
    expect(handler).not.toHaveBeenCalled();
  });

  it("leaves the keyboard alone when a new draft started before a slow send settled", async () => {
    const { view, type, pressEnter, settle, handler } = await mount();
    await type("first");
    await pressEnter();
    await type("and then");

    await settle(true);

    expect(document.activeElement).toBe(view.contentDOM);
    expect(view.state.doc.toString()).toBe("and then");
    expect(handler).not.toHaveBeenCalled();
  });

  it("counts a new draft that was erased again", async () => {
    const { view, type, pressEnter, settle, handler } = await mount();
    await type("first");
    await pressEnter();
    await type("x");
    await act(async () => {
      view.dispatch({ changes: { from: 0, to: 1 }, userEvent: "delete.backward" });
    });

    await settle(true);

    expect(document.activeElement).toBe(view.contentDOM);
    expect(handler).not.toHaveBeenCalled();
  });

  it("leaves the keyboard alone when the user pressed somewhere before the send settled", async () => {
    const { view, type, pressEnter, settle, handler } = await mount();
    await type("ship it");
    await pressEnter();
    press();

    await settle(true);

    expect(document.activeElement).toBe(view.contentDOM);
    expect(handler).not.toHaveBeenCalled();
  });

  it("leaves the keyboard where the user took it before the send settled", async () => {
    const { type, pressEnter, settle, handler } = await mount();
    await type("ship it");
    await pressEnter();
    const elsewhere = document.createElement("input");
    document.body.appendChild(elsewhere);
    elsewhere.focus();

    await settle(true);

    expect(document.activeElement).toBe(elsewhere);
    expect(handler).not.toHaveBeenCalled();
  });

  // Tabbed to a control that then went away: the keyboard is nowhere, but
  // the user left first.
  it("leaves the keyboard alone when it went elsewhere, then nowhere", async () => {
    const { type, pressEnter, settle, handler } = await mount();
    await type("ship it");
    await pressEnter();
    const control = document.createElement("button");
    document.body.appendChild(control);
    control.focus();
    control.remove();
    expect(document.activeElement).toBe(document.body);

    await settle(true);

    expect(handler).not.toHaveBeenCalled();
  });

  // Something handing focus back to the composer, a dialog restoring its
  // opener say, doesn't undo where the user went meanwhile.
  it("leaves the keyboard alone when it went elsewhere and came back", async () => {
    const { view, type, pressEnter, settle, handler } = await mount();
    await type("ship it");
    await pressEnter();
    const control = document.createElement("button");
    document.body.appendChild(control);
    control.focus();
    view.contentDOM.focus();

    await settle(true);

    expect(document.activeElement).toBe(view.contentDOM);
    expect(handler).not.toHaveBeenCalled();
  });

  it("leaves the keyboard alone when a draft reached the store but not yet the editor", async () => {
    const { view, type, pressEnter, settle, handler } = await mount();
    await type("ship it");
    await pressEnter();
    act(() => useTerminalInputStore.getState().setDraftInput("term-1", "handed off"));
    expect(view.state.doc.length).toBe(0);

    await settle(true);

    expect(handler).not.toHaveBeenCalled();
  });

  it("yields to a newer focus request for the pane", async () => {
    const { view, type, pressEnter, settle, handler } = await mount();
    await type("ship it");
    await pressEnter();
    act(() => {
      requestPaneFocus("term-1", "hybridInput");
    });

    await settle(true);

    expect(document.activeElement).toBe(view.contentDOM);
    expect(handler).not.toHaveBeenCalledWith("xterm");
  });

  it("leaves the keyboard alone once another pane is selected", async () => {
    const { view, type, pressEnter, settle, handler } = await mount();
    await type("ship it");
    await pressEnter();
    act(() => usePanelStore.setState({ focusedId: "term-2" }));

    await settle(true);

    expect(document.activeElement).toBe(view.contentDOM);
    expect(handler).not.toHaveBeenCalled();
  });

  it("changes nothing with the setting on the hybrid input", async () => {
    useTerminalInputStore.setState({ hybridInputAutoFocus: true });
    const { view, type, pressEnter, settle, handler } = await mount();
    await type("ship it");
    await pressEnter();

    await settle(true);

    expect(document.activeElement).toBe(view.contentDOM);
    expect(handler).not.toHaveBeenCalled();
  });

  it("reads the setting when the terminal answers", async () => {
    useTerminalInputStore.setState({ hybridInputAutoFocus: true });
    const { type, pressEnter, settle, textarea } = await mount();
    await type("ship it");
    await pressEnter();
    act(() => useTerminalInputStore.setState({ hybridInputAutoFocus: false }));

    await settle(true);

    expect(document.activeElement).toBe(textarea);
  });

  it("moves nothing once the composer has gone", async () => {
    const { type, pressEnter, settle, handler, unmount } = await mount();
    await type("ship it");
    await pressEnter();
    unmount();

    await settle(true);

    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps a composer with no pane of its own where it is", async () => {
    const { view, type, pressEnter, settle, handler } = await mount({ isolated: true });
    await type("ship it");
    await pressEnter();

    await settle(true);

    expect(document.activeElement).toBe(view.contentDOM);
    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps a fleet broadcast in the hybrid input", async () => {
    useFleetArmingStore.setState({ armedIds: new Set(["term-1", "term-2"]) });
    fleetBroadcast.mockImplementation((_id, _text, onSent) => {
      onSent();
      return true;
    });
    const { view, type, pressEnter, onSend, handler } = await mount();
    await type("to everyone");
    await pressEnter();
    await act(async () => {});

    expect(fleetBroadcast).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(view.contentDOM);
    expect(handler).not.toHaveBeenCalled();
  });

  // The claim is the Enter's, not the moment the text finally goes out.
  it.each([
    ["hands back", false],
    ["leaves the keyboard alone after a press", true],
  ])("%s while a @diff was still being fetched", async (_, pressed) => {
    const { view, type, pressEnter, settle, handler, onSend } = await mount();
    let deliverDiff!: (diff: string) => void;
    (window as { electron?: unknown }).electron = {
      git: {
        getWorkingDiff: vi.fn(
          () =>
            new Promise<string>((resolve) => {
              deliverDiff = resolve;
            })
        ),
      },
    };
    await type("review @diff");
    await pressEnter();
    if (pressed) press();
    await act(async () => deliverDiff("diff --git a/x b/x"));
    expect(onSend).toHaveBeenCalledTimes(1);

    await settle(true);

    expect(handler).toHaveBeenCalledTimes(pressed ? 0 : 1);
    expect(document.activeElement === view.contentDOM).toBe(pressed);
  });

  // A send closes the Expanded Editor, and both the editor's move back to the
  // bar and the dialog's exit hand the caret back to the bar afterwards.
  describe("from the Expanded Editor", () => {
    it("waits for the dialog to hand the caret back, then hands it to the terminal", async () => {
      const { view, type, openExpandedEditor, pressEnter, settle, handler, textarea } =
        await mount();
      await type("a long prompt");
      await openExpandedEditor();
      view.contentDOM.focus();
      await pressEnter();

      // Accepted while the dialog is still animating out.
      await settle(true);
      expect(handler).not.toHaveBeenCalled();
      flushFrames();

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, PAST_DIALOG_EXIT_MS));
      });

      expect(handler).toHaveBeenCalledWith("xterm");
      expect(document.activeElement).toBe(textarea);
    });

    // Performance mode closes the dialog at once; the editor's move back to
    // the bar still restores its caret a frame later.
    it("keeps the terminal when the dialog closed at once", async () => {
      document.body.dataset.performanceMode = "true";
      const { view, type, openExpandedEditor, pressEnter, settle, textarea } = await mount();
      await type("a long prompt");
      await openExpandedEditor();
      view.contentDOM.focus();
      await pressEnter();

      await settle(true);
      expect(document.activeElement).toBe(textarea);
      flushFrames();

      expect(document.activeElement).toBe(textarea);
    });

    it("leaves the keyboard alone when the editor opened again before its exit finished", async () => {
      const { view, type, openExpandedEditor, pressEnter, settle, handler } = await mount();
      await type("a long prompt");
      await openExpandedEditor();
      view.contentDOM.focus();
      await pressEnter();
      await settle(true);

      await openExpandedEditor();
      await openExpandedEditor();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, PAST_DIALOG_EXIT_MS));
      });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // The voice lock makes the editor non-editable for the wait, and Chromium
  // drops a focused contenteditable's focus to the body when it does.
  describe("after a voice submit", () => {
    async function dictateThenEnter(mounted: Awaited<ReturnType<typeof mount>>) {
      const { view, type, pressEnter } = mounted;
      await type("dictated words");
      act(() => {
        useVoiceRecordingStore.setState({
          status: "recording",
          activeTarget: { panelId: "term-1" },
        });
      });
      let finishStop!: () => void;
      vi.spyOn(voiceRecordingService, "stop").mockImplementation(async () => {
        view.contentDOM.blur();
        await new Promise<void>((resolve) => {
          finishStop = resolve;
        });
        useVoiceRecordingStore.setState({ status: "idle", activeTarget: null });
      });
      vi.spyOn(voiceRecordingService, "hasPendingCorrection").mockReturnValue(false);
      await pressEnter();
      return async () => {
        await act(async () => finishStop());
      };
    }

    it("hands back although the lock dropped the keyboard", async () => {
      const mounted = await mount();
      const finishStop = await dictateThenEnter(mounted);
      await finishStop();
      expect(mounted.onSend).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(document.body);

      await mounted.settle(true);

      expect(document.activeElement).toBe(mounted.textarea);
    });

    it("leaves the keyboard alone after a press during the wait", async () => {
      const mounted = await mount();
      const finishStop = await dictateThenEnter(mounted);
      press();
      await finishStop();

      await mounted.settle(true);

      expect(mounted.handler).not.toHaveBeenCalled();
    });

    it("leaves the keyboard alone when a new dictation started before the send settled", async () => {
      const mounted = await mount();
      const finishStop = await dictateThenEnter(mounted);
      await finishStop();
      act(() => {
        useVoiceRecordingStore.setState({
          status: "recording",
          activeTarget: { panelId: "term-1" },
        });
      });

      await mounted.settle(true);

      expect(mounted.handler).not.toHaveBeenCalled();
    });
  });
});
