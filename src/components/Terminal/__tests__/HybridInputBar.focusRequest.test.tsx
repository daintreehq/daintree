// @vitest-environment jsdom
/**
 * The bar's own focus work: what it takes on mount when its lazy chunk lands
 * late (#10541), and the frame its grabs defer to, which a press or a newer
 * request must be able to call off (#8487).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRef, useEffect, type ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import type { PtyPanelData } from "@shared/types/panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { SCRATCHPAD_BOUNDARY_ATTR } from "@/lib/terminalScratchpad";
import { HybridInputBar, type HybridInputBarHandle } from "../HybridInputBar";
import {
  _resetPaneFocusRequestsForTesting,
  holdPaneFocus,
  requestPaneFocus,
} from "../paneFocusRequest";

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
    preferredTerminalFocusTarget: "hybridInput",
  });
  useTerminalInputStore.setState({ draftInputs: new Map() });
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

/** Stands in for TerminalPane: its arrival pass runs after its children's effects. */
function ArrivingPane({ children }: { children: ReactNode }) {
  useEffect(() => holdPaneFocus("term-1", "hybridInput"), []);
  return <>{children}</>;
}

async function mount({ arriving = false } = {}) {
  const ref = createRef<HybridInputBarHandle>();
  const bar = (
    <HybridInputBar ref={ref} terminalId="term-1" cwd={WT_ID} agentId="claude" onSend={() => {}} />
  );
  const view = render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={createWorktreeStore()}>
        {arriving ? <ArrivingPane>{bar}</ArrivingPane> : bar}
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  await act(async () => {});
  // Settled, second look included: the mount commit moves the editor's DOM,
  // and what counts is where the keyboard ends up.
  flushFrames();
  const editor = view.container.querySelector<HTMLElement>(".cm-content")!;
  return { ref, editor };
}

function press() {
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
}

/** Something to hold the keyboard that takes no typing, so moving to it ends nothing. */
function focusButton() {
  const button = document.createElement("button");
  document.body.appendChild(button);
  button.focus();
  return button;
}

describe("HybridInputBar mount focus", () => {
  it("takes the keyboard for a request made while it was still loading", async () => {
    expect(requestPaneFocus("term-1", "hybridInput")).toBe(false);

    const { editor } = await mount();

    expect(document.activeElement).toBe(editor);
  });

  it("leaves the keyboard where the user took it after the request", async () => {
    requestPaneFocus("term-1", "hybridInput");
    press();

    const { editor } = await mount();

    expect(document.activeElement).not.toBe(editor);
  });

  // The request names this bar, so a remembered terminal doesn't veto it.
  it("takes a request made while the terminal is remembered", async () => {
    usePanelStore.setState({ preferredTerminalFocusTarget: "xterm" });
    requestPaneFocus("term-1", "hybridInput");

    const { editor } = await mount();

    expect(document.activeElement).toBe(editor);
  });

  it("leaves the keyboard alone while its pane isn't selected", async () => {
    usePanelStore.setState({ focusedId: "other" });
    requestPaneFocus("term-1", "hybridInput");

    const { editor } = await mount();

    expect(document.activeElement).not.toBe(editor);
  });

  // The pane's arrival pass runs after the bar's own effects when both mount
  // in one commit; the claim has to wait for it.
  it("takes the arrival of a pane mounting in the same commit", async () => {
    const { editor } = await mount({ arriving: true });
    expect(document.activeElement).toBe(editor);
  });

  it.each([
    ["the hybrid input", "hybridInput", true],
    ["the terminal", "xterm", false],
  ] as const)("follows the pane's arrival when it settled on %s", async (_, surface, takes) => {
    holdPaneFocus("term-1", surface);

    const { editor } = await mount();

    expect(document.activeElement === editor).toBe(takes);
  });

  // Nothing asked: a bar that mounts in a pane no focus pass sent here stays put.
  it("takes nothing when nothing asked for it", async () => {
    const { editor } = await mount();
    expect(document.activeElement).not.toBe(editor);
  });

  it("never takes the Scratchpad's caret (#12835)", async () => {
    const notes = document.createElement("div");
    notes.setAttribute(SCRATCHPAD_BOUNDARY_ATTR, "term-1");
    notes.innerHTML = "<textarea></textarea>";
    document.body.appendChild(notes);
    const caret = notes.querySelector("textarea")!;
    caret.focus();
    requestPaneFocus("term-1", "hybridInput");

    await mount();

    expect(document.activeElement).toBe(caret);
  });
});

describe("HybridInputBar deferred focus", () => {
  it("drops a grab a press arrived ahead of", async () => {
    const { ref, editor } = await mount();

    expect(ref.current!.focusWithCursorAtEnd()).toBe(true);
    press();
    flushFrames();

    expect(document.activeElement).not.toBe(editor);
  });

  // Even one asking for this same bar: the newer ask schedules its own grab.
  it("drops a grab a newer request arrived ahead of", async () => {
    const { ref, editor } = await mount();

    ref.current!.focusWithCursorAtEnd();
    requestPaneFocus("term-1", "hybridInput");
    flushFrames();

    expect(document.activeElement).not.toBe(editor);
  });

  // Keyboard focus moving to a field ends the request without any press.
  it("drops a grab once the user has typed their way somewhere else", async () => {
    const { ref } = await mount();
    requestPaneFocus("term-1", "hybridInput");
    ref.current!.focusWithCursorAtEnd();

    const field = document.createElement("input");
    document.body.appendChild(field);
    field.focus();
    flushFrames();

    expect(document.activeElement).toBe(field);
  });

  it("never takes the Scratchpad's caret from a grab (#12835)", async () => {
    const { ref } = await mount();
    ref.current!.focusWithCursorAtEnd();

    const notes = document.createElement("div");
    notes.setAttribute(SCRATCHPAD_BOUNDARY_ATTR, "term-1");
    notes.innerHTML = "<textarea></textarea>";
    document.body.appendChild(notes);
    const caret = notes.querySelector("textarea")!;
    caret.focus();
    flushFrames();

    expect(document.activeElement).toBe(caret);
  });

  // `focus()` takes the keyboard at once and looks again a frame later; that
  // second look is deferred work like any other.
  it.each([
    ["a press", press],
    ["a newer request", () => requestPaneFocus("term-1", "hybridInput")],
  ])("drops the second look after %s", async (_, supersede) => {
    const { ref } = await mount();

    ref.current!.focus();
    supersede();
    const button = focusButton();
    flushFrames();

    expect(document.activeElement).toBe(button);
  });

  // A request naming the bar is what lets a drop or type-anywhere land here
  // while the remembered surface is the terminal; without one, the remembered
  // surface still vetoes the grab.
  it.each([
    ["takes", true],
    ["vetoes", false],
  ])("%s the grab against a remembered terminal", async (_, requested) => {
    usePanelStore.setState({ preferredTerminalFocusTarget: "xterm" });
    const { ref, editor } = await mount();
    if (requested) requestPaneFocus("term-1", "hybridInput");

    ref.current!.focusWithCursorAtEnd();
    flushFrames();

    expect(document.activeElement === editor).toBe(requested);
  });
});
