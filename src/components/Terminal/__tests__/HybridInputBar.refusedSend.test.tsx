// @vitest-environment jsdom
/**
 * The grid composer sends through `submitText`: a send the terminal turns down
 * leaves the draft where it was typed and says it wasn't sent, and one it takes
 * clears and still hands a terminal-first user's keyboard back (#14945, #14692).
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
import { SCRATCH_REFUSAL_CAPTION, SCRATCH_REFUSAL_STATUS } from "@/services/voiceScratchCommand";
import { HybridInputBar } from "../HybridInputBar";
import { _resetPaneFocusRequestsForTesting } from "../paneFocusRequest";

const WT_ID = "/repo/wt";
const isMac = /Mac/.test(navigator.platform);
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
  useTerminalInputStore.setState({
    draftInputs: new Map(),
    commandHistory: new Map(),
    sentPrompts: new Map(),
    hybridInputAutoFocus: false,
  });
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
  useVoiceRecordingStore.setState({ status: "idle", activeTarget: null, scratchRefusal: null });
  useFleetArmingStore.setState({ armedIds: new Set() });
  if (originalElectron) Object.defineProperty(window, "electron", originalElectron);
  else delete (window as { electron?: unknown }).electron;
  delete document.body.dataset.performanceMode;
  document.body.innerHTML = "";
});

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
  const { textarea, handler } = terminal();
  const settles: Array<(accepted: boolean) => void> = [];
  const onSend = vi.fn();
  const submitText = vi.fn(
    (_text: string, _imagePaths: readonly string[]) =>
      new Promise<boolean>((resolve) => settles.push(resolve))
  );
  const worktreeStore = createWorktreeStore();
  const bar = (terminalId: string) => (
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={worktreeStore}>
        <HybridInputBar
          terminalId={terminalId}
          cwd={WT_ID}
          agentId="claude"
          onSend={onSend}
          submitText={submitText}
          isolated={isolated}
        />
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  const result = render(bar("term-1"));
  const switchTo = async (terminalId: string) => {
    await act(async () => {
      result.rerender(bar(terminalId));
    });
  };
  await act(async () => {});
  // A move to another terminal mounts a new editor.
  const liveView = () =>
    EditorView.findFromDOM(result.container.querySelector<HTMLElement>(".cm-editor")!)!;
  const view = liveView();
  view.contentDOM.focus();

  const type = async (text: string) => {
    await act(async () => {
      const live = liveView();
      live.dispatch({
        changes: { from: live.state.doc.length, insert: text },
        userEvent: "input.type",
      });
    });
  };
  const pressEnter = async () => {
    await act(async () => {
      runScopeHandlers(liveView(), new KeyboardEvent("keydown", { key: "Enter" }), "editor");
    });
  };
  const chord = async (key: string) => {
    await act(async () => {
      runScopeHandlers(
        liveView(),
        new KeyboardEvent("keydown", { key, shiftKey: true, metaKey: isMac, ctrlKey: !isMac }),
        "editor"
      );
    });
  };
  const settle = async (accepted: boolean) => {
    await act(async () => {
      settles.shift()!(accepted);
    });
  };
  const caption = () => result.container.querySelector("[data-send-refused-caption]");
  const announced = () =>
    Array.from(result.container.querySelectorAll('[role="status"]'))
      .map((el) => el.textContent)
      .join("");
  return {
    ...result,
    view,
    onSend,
    submitText,
    type,
    pressEnter,
    chord,
    settle,
    caption,
    announced,
    switchTo,
    textarea,
    handler,
  };
}

const draft = () => useTerminalInputStore.getState().getDraftInput("term-1");
const history = () => useTerminalInputStore.getState().commandHistory.get("term-1") ?? [];
const sentPrompts = () => useTerminalInputStore.getState().getSentPrompts("term-1");

describe("HybridInputBar with a host that says whether the terminal took the send", () => {
  it("keeps a refused draft where it was typed, and says it wasn't sent", async () => {
    const { view, onSend, submitText, type, pressEnter, settle, caption, announced } =
      await mount();
    await type("ship it");
    await pressEnter();

    expect(submitText).toHaveBeenCalledWith("ship it", []);
    expect(onSend).not.toHaveBeenCalled();
    // On its way: nothing cleared yet, nothing said yet.
    expect(view.state.doc.toString()).toBe("ship it");
    expect(caption()).toBeNull();

    await settle(false);

    expect(view.state.doc.toString()).toBe("ship it");
    expect(draft()).toBe("ship it");
    expect(caption()?.textContent).toBe("Not sent");
    expect(announced()).toContain("Not sent. The draft is still here.");
    expect(history()).toEqual([]);
    expect(sentPrompts()).toEqual([]);
  });

  it("clears an accepted send, records it, and hands the keyboard back to the terminal", async () => {
    const { view, type, pressEnter, settle, caption, textarea } = await mount();
    await type("ship it");
    await pressEnter();
    expect(document.activeElement).toBe(view.contentDOM);

    await settle(true);

    expect(view.state.doc.toString()).toBe("");
    expect(draft()).toBe("");
    expect(caption()).toBeNull();
    expect(history()).toEqual(["ship it"]);
    expect(sentPrompts().map((p) => p.text)).toEqual(["ship it"]);
    expect(document.activeElement).toBe(textarea);
  });

  it("keeps what was typed while a refused send was on its way", async () => {
    const { view, type, pressEnter, settle, caption } = await mount();
    await type("first");
    await pressEnter();
    await type(" and more");

    await settle(false);

    expect(view.state.doc.toString()).toBe("first and more");
    expect(caption()?.textContent).toBe("Not sent");
  });

  it("leaves a draft changed during an accepted send, and keeps the keyboard where it is", async () => {
    const { view, type, pressEnter, settle } = await mount();
    await type("first");
    await pressEnter();
    await type(" and more");

    await settle(true);

    expect(view.state.doc.toString()).toBe("first and more");
    expect(document.activeElement).toBe(view.contentDOM);
  });

  it("drops the note on the next edit, and on the next send", async () => {
    const { submitText, type, pressEnter, settle, caption } = await mount();
    await type("ship it");
    await pressEnter();
    await settle(false);
    expect(caption()).not.toBeNull();

    await type("!");
    expect(caption()).toBeNull();

    await pressEnter();
    await settle(false);
    expect(caption()).not.toBeNull();
    await pressEnter();
    expect(submitText).toHaveBeenCalledTimes(3);
    expect(caption()).toBeNull();
    await settle(true);
    expect(caption()).toBeNull();
  });

  it("gives the border to a later scratch refusal, and a later refused send takes it back (#14973)", async () => {
    const { container, submitText, type, pressEnter, settle, caption } = await mount();
    const scratchCaption = () => container.querySelector("[data-scratch-refused-caption]");
    await type("ship it");
    await pressEnter();
    await settle(false);
    expect(caption()).not.toBeNull();

    act(() => {
      useVoiceRecordingStore.setState({
        scratchRefusal: { panelId: "term-1", reason: "edited", id: 1 },
      });
    });
    expect(scratchCaption()).not.toBeNull();
    expect(caption()).toBeNull();

    // Refused in the same tick it went, the note never stops saying "refused".
    submitText.mockImplementationOnce(() => {
      throw new Error("pty gone");
    });
    await pressEnter();
    await act(async () => {});
    expect(useVoiceRecordingStore.getState().scratchRefusal).toBeNull();
    expect(scratchCaption()).toBeNull();
    expect(caption()?.textContent).toBe("Not sent");
  });

  it("keeps a scratch refusal through a send the terminal took: it says what went out", async () => {
    const { container, type, pressEnter, settle } = await mount();
    const scratchCaption = () => container.querySelector("[data-scratch-refused-caption]");
    await type("ship it");
    act(() => {
      useVoiceRecordingStore.setState({
        scratchRefusal: { panelId: "term-1", reason: "edited", id: 1 },
      });
    });

    await pressEnter();
    await settle(true);

    expect(draft()).toBe("");
    expect(scratchCaption()).not.toBeNull();
  });

  it("lets a send refused after a scratch refusal take the border back", async () => {
    const { container, type, pressEnter, settle, caption } = await mount();
    const scratchCaption = () => container.querySelector("[data-scratch-refused-caption]");
    await type("ship it");
    await pressEnter();
    act(() => {
      useVoiceRecordingStore.setState({
        scratchRefusal: { panelId: "term-1", reason: "nothing", id: 1 },
      });
    });
    expect(scratchCaption()).not.toBeNull();

    await settle(false);

    expect(scratchCaption()).toBeNull();
    expect(caption()?.textContent).toBe("Not sent");
  });

  it("says a scratch refusal in the Expanded Editor's header, and from inside its dialog", async () => {
    const { chord } = await mount();
    await chord("e");
    act(() => {
      for (const cb of frames.splice(0)) cb(0);
    });
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();

    act(() => {
      useVoiceRecordingStore.setState({
        scratchRefusal: { panelId: "term-1", reason: "edited", id: 1 },
      });
    });

    expect(dialog!.textContent).toContain(SCRATCH_REFUSAL_CAPTION.edited);
    const spoken = Array.from(dialog!.querySelectorAll('[role="status"]')).map(
      (node) => node.textContent
    );
    expect(spoken.join("|")).toContain(SCRATCH_REFUSAL_STATUS.edited);
  });

  it("drops the note when a popped stash replaces the draft", async () => {
    const { view, type, pressEnter, chord, settle, caption, announced } = await mount();
    await type("older");
    await chord("s");
    await type("ship it");
    await pressEnter();
    await settle(false);
    expect(caption()).not.toBeNull();

    await chord("x");

    expect(view.state.doc.toString()).toBe("older");
    expect(caption()).toBeNull();
    expect(announced()).not.toContain("Not sent");
  });

  it.each([
    ["rejects", () => Promise.reject(new Error("pty gone"))],
    [
      "throws",
      () => {
        throw new Error("pty gone");
      },
    ],
  ])("treats a submission that %s as refused", async (_, refuse) => {
    const { submitText, view, type, pressEnter, caption } = await mount();
    submitText.mockImplementationOnce(refuse);
    await type("ship it");
    await pressEnter();
    await act(async () => {});

    expect(view.state.doc.toString()).toBe("ship it");
    expect(caption()?.textContent).toBe("Not sent");
  });

  it("drops the note when the composer moves to another terminal, and a late refusal stays with the first", async () => {
    const { submitText, type, pressEnter, settle, caption, announced, switchTo } = await mount();
    await type("ship it");
    await pressEnter();
    await settle(false);
    expect(caption()).not.toBeNull();

    await switchTo("term-2");
    expect(caption()).toBeNull();
    expect(announced()).not.toContain("Not sent");

    await switchTo("term-1");
    await type(" again");
    await pressEnter();
    expect(submitText).toHaveBeenLastCalledWith("ship it again", []);
    await switchTo("term-2");
    await settle(false);
    expect(caption()).toBeNull();
  });

  it("says a refused send wasn't sent in an isolated composer too, and never hands the keyboard back", async () => {
    const { view, type, pressEnter, settle, caption, handler } = await mount({ isolated: true });
    await type("ship it");
    await pressEnter();
    await settle(false);
    expect(caption()?.textContent).toBe("Not sent");

    await pressEnter();
    await settle(true);
    expect(view.state.doc.toString()).toBe("");
    expect(handler).not.toHaveBeenCalled();
  });

  // The claim is the Enter's, not the moment the text finally goes out.
  it.each([
    ["hands back", false],
    ["leaves the keyboard alone after a press", true],
  ])("%s once a @diff fetched before the send is accepted", async (_, pressed) => {
    const { view, type, pressEnter, settle, handler, submitText } = await mount();
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
    if (pressed) document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await act(async () => deliverDiff("diff --git a/x b/x"));
    expect(submitText).toHaveBeenCalledTimes(1);

    await settle(true);

    expect(handler).toHaveBeenCalledTimes(pressed ? 0 : 1);
    expect(document.activeElement === view.contentDOM).toBe(pressed);
  });
});
