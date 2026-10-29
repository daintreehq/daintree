// @vitest-environment jsdom
/**
 * Enter in an armed pane's composer broadcasts to the fleet. Only the text that
 * went out leaves the draft: what was typed while the broadcast was on its way
 * stays, and a broadcast that reached no one leaves the draft alone (#14946).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const submitMock = vi.hoisted(() => vi.fn<(id: string, text: string) => Promise<void>>());
// When set, the composer's fleet send is held here instead of broadcast, so a
// test can settle it at an exact point.
const heldFleetSend = vi.hoisted(() => ({
  capture: null as null | ((settle: () => void) => void),
}));
vi.mock("../composerFleetBroadcast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../composerFleetBroadcast")>();
  return {
    ...actual,
    tryComposerFleetBroadcast: (
      ...args: Parameters<typeof actual.tryComposerFleetBroadcast>
    ): boolean => {
      if (!heldFleetSend.capture) return actual.tryComposerFleetBroadcast(...args);
      heldFleetSend.capture(args[3]);
      return true;
    },
  };
});
vi.mock("@/clients", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients")>();
  return {
    ...actual,
    terminalClient: {
      ...actual.terminalClient,
      submit: (id: string, text: string) => submitMock(id, text),
    },
  };
});

import { act, cleanup, render } from "@testing-library/react";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import type { PtyPanelData } from "@shared/types/panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetBroadcastProgressStore } from "@/store/fleetBroadcastProgressStore";
import { useFleetFailureStore } from "@/store/fleetFailureStore";
import { useFleetRunStore } from "@/store/fleetRunStore";
import {
  __resetFleetTargetOverridesStoreForTesting,
  useFleetTargetOverridesStore,
} from "@/store/fleetTargetOverridesStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { HybridInputBar } from "../HybridInputBar";

const WT_ID = "/repo/wt";
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

function agent(id: string): PtyPanelData {
  return {
    id,
    title: id,
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
}

beforeEach(() => {
  initBuiltInPanelKinds();
  setCurrentViewStore(createWorktreeStore());
  const panels = [agent("term-1"), agent("term-2")];
  usePanelStore.setState({
    panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
    panelIds: panels.map((p) => p.id),
    panelIdsByWorktreeId: { [WT_ID]: panels.map((p) => p.id) },
    focusedId: "term-1",
  });
  useTerminalInputStore.setState({ draftInputs: new Map(), hybridInputAutoFocus: false });
  useFleetArmingStore.setState({
    armedIds: new Set<string>(),
    armOrder: [],
    armOrderById: {},
    lastArmedId: null,
  });
  useFleetArmingStore.getState().armIds(["term-1", "term-2"]);
  useFleetBroadcastProgressStore.setState({
    completed: 0,
    total: 0,
    failed: 0,
    isActive: false,
    cancelled: false,
  });
  useFleetFailureStore.getState().clear();
  __resetFleetTargetOverridesStoreForTesting();
  useFleetRunStore.getState()._reset();
  submitMock.mockReset().mockResolvedValue(undefined);
  heldFleetSend.capture = null;
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      notification: { playUiEvent: vi.fn().mockResolvedValue(undefined) },
      runHistory: { append: vi.fn().mockResolvedValue(undefined) },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useFleetArmingStore.setState({ armedIds: new Set(), armOrder: [], armOrderById: {} });
  useFleetRunStore.getState()._reset();
  if (originalElectron) Object.defineProperty(window, "electron", originalElectron);
  else delete (window as { electron?: unknown }).electron;
  document.body.innerHTML = "";
});

async function mount() {
  const onSend = vi.fn(() => Promise.resolve(true));
  const result = render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={createWorktreeStore()}>
        <HybridInputBar terminalId="term-1" cwd={WT_ID} agentId="claude" onSend={onSend} />
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  await act(async () => {});
  const view = EditorView.findFromDOM(result.container.querySelector<HTMLElement>(".cm-editor")!)!;
  view.contentDOM.focus();

  const type = async (text: string) => {
    await act(async () => {
      const end = view.state.doc.length;
      view.dispatch({
        changes: { from: end, insert: text },
        selection: { anchor: end + text.length },
        userEvent: "input.type",
      });
    });
  };
  const pressEnter = async () => {
    await act(async () => {
      runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Enter" }), "editor");
    });
  };
  const settle = async () => {
    await act(async () => {
      for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const draft = (id: string) => useTerminalInputStore.getState().getDraftInput(id, undefined);
  return { view, onSend, type, pressEnter, settle, draft };
}

/** Holds every submit open until `release` lets them land. */
function holdSubmits() {
  const parked: Array<() => void> = [];
  submitMock.mockImplementation(() => new Promise<void>((resolve) => parked.push(resolve)));
  return {
    get count() {
      return parked.length;
    },
    release: () => {
      for (const resolve of parked.splice(0)) resolve();
    },
  };
}

describe("HybridInputBar's fleet send", () => {
  it("clears the draft once the broadcast has gone out", async () => {
    const { view, type, pressEnter, settle, onSend, draft } = await mount();
    await type("to everyone");
    await pressEnter();
    await settle();

    expect(onSend).not.toHaveBeenCalled();
    expect(submitMock.mock.calls.map(([id]) => id).sort()).toEqual(["term-1", "term-2"]);
    expect(view.state.doc.toString()).toBe("");
    expect(draft("term-1")).toBe("");
    expect(draft("term-2")).toBe("");
  });

  it("keeps what was typed while the broadcast was on its way, here and in the followers", async () => {
    const submits = holdSubmits();
    const { view, type, pressEnter, settle, draft } = await mount();
    try {
      await type("first");
      await pressEnter();
      await settle();
      expect(submits.count).toBe(2);

      await type(" and the next one");
    } finally {
      await act(async () => submits.release());
    }
    await settle();

    expect(view.state.doc.toString()).toBe("first and the next one");
    expect(draft("term-1")).toBe("first and the next one");
    expect(draft("term-2")).toBe("first and the next one");
  });

  it("keeps a write from outside that reached the draft but not yet the editor", async () => {
    let delivered: (() => void) | null = null;
    heldFleetSend.capture = (settle) => {
      delivered = settle;
    };
    const { view, type, pressEnter, settle, draft } = await mount();
    await type("first");
    await pressEnter();
    expect(delivered).not.toBeNull();

    // A handoff or dictation writes the store first and reaches the editor an
    // effect later; the broadcast settles in between.
    act(() => {
      const inputs = useTerminalInputStore.getState();
      inputs.setDraftInput("term-1", "first, then the logs", undefined);
      inputs.bumpExternalDraftRevision();
      expect(view.state.doc.toString()).toBe("first");
      delivered!();
      expect(draft("term-1")).toBe("first, then the logs");
    });
    await settle();

    expect(view.state.doc.toString()).toBe("first, then the logs");
    expect(draft("term-2")).toBe("first, then the logs");
  });

  it("keeps the draft when every target is excluded", async () => {
    useFleetTargetOverridesStore.getState().setSkipped("term-1", true);
    useFleetTargetOverridesStore.getState().setSkipped("term-2", true);
    const { view, type, pressEnter, settle, onSend, draft } = await mount();
    await type("not yet");
    await pressEnter();
    await settle();

    expect(onSend).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("not yet");
    expect(draft("term-1")).toBe("not yet");
    expect(draft("term-2")).toBe("not yet");
  });

  it.each([
    ["was unreachable", "EPIPE"],
    ["refused it for now", "ENOSPC: disk full"],
  ])("keeps the draft when every target %s", async (_, reason) => {
    submitMock.mockRejectedValue(new Error(reason));
    const { view, type, pressEnter, settle, draft } = await mount();
    await type("try again");
    await pressEnter();
    await settle();

    expect(submitMock).toHaveBeenCalledTimes(2);
    expect(view.state.doc.toString()).toBe("try again");
    expect(draft("term-1")).toBe("try again");
    expect(draft("term-2")).toBe("try again");
  });

  // Enter on a `/` row runs it; the fleet gets it, as it gets a typed Enter (#14948).
  it("runs a slash command picked from the menu on every armed pane", async () => {
    const { view, type, pressEnter, settle, onSend, draft } = await mount();
    await type("/compa");
    await settle();
    expect(document.querySelector('[role="option"]')?.textContent).toContain("/compact");

    await pressEnter();
    await settle();

    expect(onSend).not.toHaveBeenCalled();
    expect(submitMock.mock.calls.sort(([a], [b]) => a.localeCompare(b))).toEqual([
      ["term-1", "/compact"],
      ["term-2", "/compact"],
    ]);
    expect(view.state.doc.toString()).toBe("");
    expect(draft("term-1")).toBe("");
    expect(draft("term-2")).toBe("");
  });

  it("runs a slash command from the menu on every armed pane when Enter arrives as input", async () => {
    const { view, type, settle, onSend } = await mount();
    await type("/compa");
    await settle();

    await act(async () => {
      view.contentDOM.dispatchEvent(
        new InputEvent("beforeinput", { inputType: "insertLineBreak", cancelable: true })
      );
    });
    await settle();

    expect(onSend).not.toHaveBeenCalled();
    expect(submitMock.mock.calls.map(([id, text]) => `${id} ${text}`).sort()).toEqual([
      "term-1 /compact",
      "term-2 /compact",
    ]);
  });

  it.each([
    ["armed alone", "term-2"],
    ["not armed", "term-1"],
  ])("runs a slash command from the menu on this pane when it is %s", async (_, disarmed) => {
    useFleetArmingStore.getState().disarmId(disarmed);
    const { view, type, pressEnter, settle, onSend } = await mount();
    await type("/compa");
    await settle();

    await pressEnter();
    await settle();

    expect(submitMock).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![0]).toMatchObject({ text: "/compact" });
    expect(view.state.doc.toString()).toBe("");
  });

  it("runs a slash command from the menu on no pane when every target is excluded", async () => {
    useFleetTargetOverridesStore.getState().setSkipped("term-1", true);
    useFleetTargetOverridesStore.getState().setSkipped("term-2", true);
    const { view, type, pressEnter, settle, onSend, draft } = await mount();
    await type("/compa");
    await settle();

    await pressEnter();
    await settle();

    expect(onSend).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("/compa");
    expect(draft("term-1")).toBe("/compa");
  });

  it("keeps what was typed while a slash command from the menu was on its way", async () => {
    const submits = holdSubmits();
    const { view, type, pressEnter, settle, draft } = await mount();
    try {
      await type("/compa");
      await settle();
      await pressEnter();
      await settle();
      expect(submits.count).toBe(2);

      await type(" then summarize");
    } finally {
      await act(async () => submits.release());
    }
    await settle();

    expect(submitMock.mock.calls.map(([, text]) => text)).toEqual(["/compact", "/compact"]);
    expect(view.state.doc.toString()).toBe("/compa then summarize");
    expect(draft("term-1")).toBe("/compa then summarize");
  });
});
