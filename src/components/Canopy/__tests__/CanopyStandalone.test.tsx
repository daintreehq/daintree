// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render as rtlRender, within } from "@testing-library/react";
import type { ReactElement } from "react";
import type { AgentDirectory, AgentDirectoryLiveEntry } from "@shared/types/agentDirectory";
import type {
  CanopySnapshot,
  CanopyTerminalData,
  CanopyTerminalView,
  CanopyTrashEntry,
} from "@shared/types/ipc/canopy";
import type { FleetSnapshot } from "@shared/types/ipc/fleet";
import { TooltipProvider } from "@/components/ui/tooltip";

/** The app root provides tooltips; the rows' action buttons need one. No project provider is here. */
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: TooltipProvider });

// The terminal and the reply are the real ones, down to xterm's own boundary:
// a stand-in for either would prove only that a placeholder mounted.
const xterm = vi.hoisted(() => ({
  current: null as null | {
    writes: Array<string | Uint8Array>;
    focused: number;
    emitData: (data: string) => void;
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: Record<string, unknown>;
    buffer = {
      active: { baseY: 0, cursorY: 0, getLine: () => ({ translateToString: () => "" }) },
      onBufferChange: () => ({ dispose() {} }),
    };
    private onDataListener: ((data: string) => void) | null = null;
    unicode = { activeVersion: "6" };
    modes = { bracketedPasteMode: false };
    cols = 80;
    rows = 24;
    element: HTMLElement | undefined;
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      xterm.current = {
        writes: [],
        focused: 0,
        emitData: (data) => this.onDataListener?.(data),
      };
    }
    open(host: HTMLElement) {
      this.element = host;
    }
    focus() {
      xterm.current!.focused += 1;
    }
    getSelection() {
      return "";
    }
    registerLinkProvider() {
      return { dispose() {} };
    }
    reset() {}
    write(data: string | Uint8Array, callback?: () => void) {
      xterm.current!.writes.push(data);
      callback?.();
    }
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
    }
    onDimensionsChange() {
      return { dispose() {} };
    }
    attachCustomKeyEventHandler() {}
    onData(listener: (data: string) => void) {
      this.onDataListener = listener;
      return { dispose: () => (this.onDataListener = null) };
    }
    loadAddon() {}
    dispose() {}
  },
}));
vi.mock("@/services/terminal/TerminalResizeController", () => ({
  getXtermCellDimensions: () => null,
}));
vi.mock("@/services/TerminalInstanceService", () => {
  const terminalInstanceService = {
    holdGeometry: () => () => {},
    get: () => undefined,
  };
  return { createTerminalPaintPlane: () => terminalInstanceService };
});
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    findNext = vi.fn(() => true);
    findPrevious = vi.fn(() => true);
    clearDecorations = vi.fn();
    onDidChangeResults = () => ({ dispose() {} });
    activate() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: class {
    activate() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-webgl", () => {
  throw new Error("no WebGL in jsdom");
});

const dispatchMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: dispatchMock } }));
const switchToHostMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/Hosts/hostSwitching", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/Hosts/hostSwitching")>()),
  switchToHost: switchToHostMock,
}));
const openInAssistantMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("@/services/assistantSubject", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/assistantSubject")>()),
  openInAssistant: openInAssistantMock,
}));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));
const lifecycle = vi.hoisted(() => new Set<(phase: string) => void>());
vi.mock("@/lib/viewCacheState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/viewCacheState")>()),
  subscribeProjectViewLifecycle: (listener: (phase: string) => void) => {
    lifecycle.add(listener);
    return () => lifecycle.delete(listener);
  },
}));

import { CanopyView } from "../CanopyView";
import { standaloneCanopyFrame, type CanopyFrame } from "../canopyFrame";
import { CANOPY_TITLE } from "../canopyTerms";
import { _resetCanopyWatchBurstForTests } from "../CanopyTerminal";
import { __resetCanopyPlaceForTests } from "../CanopyPlace";
import { __resetCanopySeenForTests } from "@/lib/canopySeen";
import { registerDialogEscapeBackstop } from "@/lib/dialogEscapeBackstop";
import { resolveCanopyReplyDictation } from "@/services/canopyReplyDictation";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { load as loadTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";
import { useCanopyStore } from "@/store/canopyStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { useProjectStore } from "@/store/projectStore";
import { useUIStore } from "@/store/uiStore";

// The service mock never evaluates the real module, so nothing builds it.
await loadTerminalService();

const NOW = Date.now();
/** Past the terminal's wait between watches, which spares a run stepped straight past. */
const PAST_WATCH_BURST_MS = 200;

const snapshot: CanopySnapshot = {
  mode: "on",
  activated: true,
  dispositions: [],
  seen: [],
  reads: [],
  scope: null,
  active: true,
  busy: false,
  refreshedAt: NOW,
  cards: [],
  lastError: null,
  failedRuns: [],
  glances: [],
};

function run(runId: string, workspaceId: string, since: number) {
  return {
    runId,
    workspaceId,
    spawnedAt: NOW - 3_600_000,
    cwd: `/repo/${workspaceId}`,
    agentId: "claude" as const,
    agentState: "waiting" as const,
    waitingReason: "question" as const,
    since: NOW - since,
  };
}

/** One agent in each of two projects: only a host with no project shows both beside "p1". */
const FLEET: FleetSnapshot = {
  runs: [run("first", "p1", 60_000), run("second", "p2", 30_000)],
  changedAt: NOW,
  degraded: false,
  lastSuccessfulAt: NOW,
};

function assistantEntry(): AgentDirectoryLiveEntry {
  return {
    state: "live",
    role: "assistant",
    subject: {
      hostId: "local",
      scope: { kind: "project", projectId: "p1" },
      terminalId: "help-0",
      incarnation: 3,
      lane: 0,
    },
    agentId: "claude",
    agentState: "waiting",
    waitingReason: "prompt",
    since: NOW - 10_000,
    label: null,
    attached: true,
    handback: null,
  };
}

let directory: AgentDirectory;
let pushChunk: (chunk: CanopyTerminalData) => void = () => {};
/** Each watch asked for, by run, with what answers it. */
let watches: Array<{ runId: string; answer: (view: CanopyTerminalView) => void }>;

function installElectron() {
  const canopy = {
    onSnapshotUpdated: vi.fn(() => () => {}),
    setActive: vi.fn(async (_active: boolean) => useCanopyStore.getState().snapshot!),
    setScope: vi.fn(async (_projectId: string | null) => {}),
    setShown: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    reread: vi.fn(async () => {}),
    markSeen: vi.fn(async () => {}),
    setRead: vi.fn(async () => null),
    archive: vi.fn(async (runId: string, target: { spawnedAt: number }) => ({
      runId,
      spawnedAt: target.spawnedAt,
      turn: 0,
      readTurn: 0,
      markedUnreadAt: null,
      version: 1,
    })),
    unarchive: vi.fn(async () => {}),
    restoreTrashed: vi.fn(async (): Promise<unknown> => ({ open: { workspaceId: "p1" } })),
    reply: vi.fn(async () => {}),
    runBranch: vi.fn(async () => "main"),
    searchScreens: vi.fn(async () => [] as string[]),
    readAgentDirectory: vi.fn(async () => directory),
    readAssistantWork: vi.fn(async () => ({
      coverage: "ok" as const,
      observedAt: NOW,
      complete: true,
      omitted: 0,
      workers: [],
    })),
    onTerminalData: (listener: (chunk: CanopyTerminalData) => void) => {
      pushChunk = listener;
      return () => {};
    },
    watchTerminal: vi.fn(
      (runId: string) =>
        new Promise<CanopyTerminalView>((resolve) => watches.push({ runId, answer: resolve }))
    ),
    watchAssistantTerminal: vi.fn(() => new Promise<CanopyTerminalView>(() => {})),
    unwatchTerminal: vi.fn(async (_watchId: number) => {}),
    terminalInput: vi.fn(async (_watchId: number, _data: string) => {}),
    terminalResize: vi.fn(async () => {}),
  };
  Object.defineProperty(window, "electron", {
    value: {
      canopy,
      fleet: {},
      terminal: { restore: vi.fn() },
      system: { openExternal: vi.fn() },
    },
    configurable: true,
    writable: true,
  });
  return canopy;
}

function hostFrame(overrides: Partial<CanopyFrame> = {}) {
  const decisions = {
    close: vi.fn(),
    goToRun: vi.fn(),
    restoreElsewhere: vi.fn(),
    openAssistant: vi.fn(async (): Promise<string | null> => null),
    ...overrides,
  };
  return { ...decisions, frame: standaloneCanopyFrame(decisions) };
}

/** Drain the landing effect's two animation frames. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

function surface() {
  return document.querySelector<HTMLElement>("[data-canopy-standalone]");
}

function card(runId: string) {
  return document.getElementById(`canopy-card-${runId}`)!;
}

function selectedRun() {
  return document.querySelector("[data-canopy-card][aria-selected=true]")?.id;
}

async function answerWatch(runId: string, watchId: number, screen: string) {
  const watch = watches.find((candidate) => candidate.runId === runId)!;
  await act(async () => watch.answer({ watchId, snapshot: { data: screen, cols: 80, rows: 24 } }));
}

let canopy: ReturnType<typeof installElectron>;

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
  }
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: vi.fn(),
    configurable: true,
  });
});

beforeEach(() => {
  initBuiltInPanelKinds();
  __resetCanopySeenForTests();
  __resetCanopyPlaceForTests();
  _resetCanopyWatchBurstForTests();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  watches = [];
  directory = { coverage: "ok", observedAt: NOW, complete: true, omitted: 0, entries: [] };
  useProjectStore.setState({
    projects: [
      { id: "p1", path: "/repo/p1", name: "app", emoji: "🌳", lastOpened: NOW },
      { id: "p2", path: "/repo/p2", name: "site", emoji: "🌲", lastOpened: NOW },
    ],
  });
  useFleetSnapshotStore.setState({ snapshot: FLEET });
  // Remembered from a project window: this host has no project to apply it to.
  useCanopyStore.setState({ isOpen: false, snapshot, mode: "on", scope: "project" });
  canopy = installElectron();
});

afterEach(() => {
  cleanup();
  useCanopyStore.setState({
    isOpen: false,
    snapshot: null,
    mode: "unset",
    scope: "all",
    orders: {},
    workOf: null,
    hostId: null,
  });
  window.localStorage.removeItem("daintree-canopy-order");
  xterm.current = null;
  vi.clearAllMocks();
  vi.restoreAllMocks();
  delete window.__DAINTREE_INITIAL_PROJECT__;
});

describe("Canopy's inbox with no dialog and no project", () => {
  it("lists every project's agents, with nothing of a dialog or a project around them", async () => {
    render(<CanopyView frame={hostFrame().frame} />);
    await settle();

    expect(surface()).not.toBeNull();
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(document.querySelector("[data-testid=canopy-dialog]")).toBeNull();
    expect(useUIStore.getState().overlayStack).not.toContain("canopy");

    expect(document.querySelector("[data-canopy-card]")).not.toBeNull();
    expect(card("first")).not.toBeNull();
    expect(card("second")).not.toBeNull();
    expect(within(surface()!).queryByRole("radio", { name: "This project" })).toBeNull();
    expect(within(surface()!).queryByRole("radio", { name: "All projects" })).toBeNull();
    expect(canopy.setScope).toHaveBeenCalledWith(null);
    expect(canopy.setScope).not.toHaveBeenCalledWith(expect.any(String));
    expect(useCanopyStore.getState().scope).toBe("project");
  });

  it("takes no scope from a view it stands in, whatever the view says it is", async () => {
    window.__DAINTREE_INITIAL_PROJECT__ = { id: "p1" };
    render(<CanopyView frame={hostFrame().frame} />);
    await settle();

    expect(card("second")).not.toBeNull();
    expect(within(surface()!).queryByRole("radio", { name: "This project" })).toBeNull();
    expect(canopy.setScope).not.toHaveBeenCalledWith("p1");
  });

  it("selects a row and shows its live terminal, typing into it", async () => {
    render(<CanopyView frame={hostFrame().frame} />);
    await settle();

    const landed = selectedRun();
    expect(landed).toBeDefined();
    const shownRun = landed!.replace(/^canopy-card-/, "");
    expect(canopy.watchTerminal).toHaveBeenCalledWith(shownRun, expect.anything());
    await answerWatch(shownRun, 7, "SCREEN");
    expect(xterm.current!.writes).toEqual(["SCREEN"]);

    await act(async () => pushChunk({ kind: "data", watchId: 7, runId: shownRun, data: "more" }));
    expect(xterm.current!.writes).toEqual(["SCREEN", "more"]);

    const terminal = document.querySelector<HTMLElement>("[data-canopy-terminal]")!;
    fireEvent.keyDown(terminal, { key: "y" });
    xterm.current!.emitData("y");
    expect(canopy.terminalInput).toHaveBeenCalledWith(7, "y");

    const other = shownRun === "first" ? "second" : "first";
    await act(async () => {
      fireEvent.click(card(other));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, PAST_WATCH_BURST_MS));
    });
    expect(selectedRun()).toBe(`canopy-card-${other}`);
    expect(canopy.watchTerminal).toHaveBeenCalledWith(other, expect.anything());
    expect(canopy.unwatchTerminal).toHaveBeenCalledWith(7);
    await answerWatch(other, 8, "OTHER");
    expect(xterm.current!.writes).toEqual(["OTHER"]);
  });

  it("draws the reply with no worktrees to name", async () => {
    render(<CanopyView frame={hostFrame().frame} />);
    await settle();
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    await settle();

    expect(document.querySelector("[data-canopy-detail] .cm-editor")).not.toBeNull();
  });

  it("hands Go to terminal to the host, and neither moves nor closes anything itself", async () => {
    const host = hostFrame();
    render(<CanopyView frame={host.frame} />);
    await settle();

    await act(async () => {
      fireEvent.click(card("second"));
    });
    await act(async () => {
      fireEvent.keyDown(card("second"), { key: "Enter" });
    });

    expect(host.goToRun).toHaveBeenCalledTimes(1);
    expect(host.goToRun.mock.calls[0]![0]).toEqual({
      place: { hostId: null, runId: "second", workspaceId: "p2" },
      listedRunId: "second",
      newWindow: false,
    });
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(switchToHostMock).not.toHaveBeenCalled();
    expect(useCanopyStore.getState().isOpen).toBe(true);
    expect(surface()).not.toBeNull();
  });

  it("hands closing to the host: the close button and Escape, and then only it decides", async () => {
    const host = hostFrame();
    render(<CanopyView frame={host.frame} />);
    await settle();

    await act(async () => {
      fireEvent.click(within(surface()!).getByRole("button", { name: `Close ${CANOPY_TITLE}` }));
    });
    expect(host.close).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.keyDown(card("first"), { key: "Escape" });
    });
    expect(host.close).toHaveBeenCalledTimes(2);

    expect(useCanopyStore.getState().isOpen).toBe(true);
    expect(surface()).not.toBeNull();
  });

  it("keeps Escape for a menu open in the inbox", async () => {
    const host = hostFrame();
    render(<CanopyView frame={host.frame} />);
    await settle();

    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.setAttribute("data-state", "open");
    document.body.appendChild(menu);
    await act(async () => {
      fireEvent.keyDown(card("first"), { key: "Escape" });
    });
    menu.remove();

    expect(host.close).not.toHaveBeenCalled();
  });

  it("keeps Escape for a dialog open over the inbox", async () => {
    const host = hostFrame();
    render(<CanopyView frame={host.frame} />);
    await settle();

    const unregister = registerDialogEscapeBackstop(() => {});
    await act(async () => {
      fireEvent.keyDown(card("first"), { key: "Escape" });
    });
    unregister();

    expect(host.close).not.toHaveBeenCalled();
  });

  it("keeps Escape for the search until it is empty", async () => {
    const host = hostFrame();
    render(<CanopyView frame={host.frame} />);
    await settle();

    const search = surface()!.querySelector<HTMLInputElement>("input[role=combobox]")!;
    await act(async () => {
      fireEvent.change(search, { target: { value: "port" } });
    });
    await act(async () => {
      fireEvent.keyDown(search, { key: "Escape" });
    });
    expect(search.value).toBe("");
    expect(host.close).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.keyDown(search, { key: "Escape" });
    });
    expect(host.close).toHaveBeenCalledTimes(1);
  });

  it("stays up when a view around it is cached: there is no project view to follow", async () => {
    const host = hostFrame();
    render(<CanopyView frame={host.frame} />);
    await settle();

    await act(async () => {
      for (const listener of lifecycle) listener("cached");
    });

    expect(host.close).not.toHaveBeenCalled();
    expect(surface()).not.toBeNull();
  });

  it("claims no terminal for dictation context, with no project to own one", async () => {
    window.__DAINTREE_INITIAL_PROJECT__ = { id: "p1" };
    render(<CanopyView frame={hostFrame().frame} />);
    await settle();
    await act(async () => {
      fireEvent.click(card("first"));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, PAST_WATCH_BURST_MS));
    });
    await answerWatch("first", 7, "SCREEN");

    const dictation = resolveCanopyReplyDictation();
    if (!dictation.ok) throw new Error(dictation.message);
    expect(dictation.target.terminalId).toBeUndefined();
  });

  it("hands the keyboard back to the terminal when its menu closes", async () => {
    render(<CanopyView frame={hostFrame().frame} />);
    await settle();
    const shownRun = selectedRun()!.replace(/^canopy-card-/, "");
    await answerWatch(shownRun, 7, "SCREEN");

    const search = surface()!.querySelector<HTMLInputElement>("input[role=combobox]")!;
    search.focus();
    const terminal = document.querySelector<HTMLElement>("[data-canopy-terminal]")!;
    await act(async () => {
      fireEvent.contextMenu(terminal, { clientX: 5, clientY: 5 });
    });
    const menu = document.querySelector<HTMLElement>("[data-canopy-terminal-menu]")!;
    expect(menu).not.toBeNull();
    search.focus();
    const before = xterm.current!.focused;
    await act(async () => {
      fireEvent.keyDown(menu, { key: "Escape" });
    });
    // Radix restores focus a task after closing, and the menu's refocus a task after that.
    await vi.waitFor(() => {
      expect(document.querySelector("[data-canopy-terminal-menu]")).toBeNull();
      expect(xterm.current!.focused).toBeGreaterThan(before);
    });
  });

  it("takes Z back from anywhere in the surface", async () => {
    render(<CanopyView frame={hostFrame().frame} />);
    await settle();

    await act(async () => {
      card("first").focus();
      fireEvent.keyDown(card("first"), { key: "e" });
    });
    expect(canopy.archive).toHaveBeenCalledWith("first", expect.anything());

    await act(async () => {
      fireEvent.keyDown(within(surface()!).getByRole("button", { name: "Refresh" }), { key: "z" });
    });
    expect(canopy.unarchive).toHaveBeenCalledWith("first", expect.anything());
  });

  it("hands a run only its project can restore to the host", async () => {
    const host = hostFrame();
    const entry: CanopyTrashEntry = {
      run: { ...run("gone", "p2", 0), title: "Fix gone", titleMode: "user" },
      trashedAt: NOW - 3_000,
      expiresAt: NOW + 20_000,
    };
    useCanopyStore.setState({ snapshot: { ...snapshot, trash: [entry] } });
    render(<CanopyView frame={host.frame} />);
    await settle();

    const bar = document.querySelector<HTMLButtonElement>("button[aria-controls=canopy-trash]")!;
    fireEvent.click(bar);
    await act(async () => {
      fireEvent.keyDown(bar, { key: "ArrowDown" });
    });
    await act(async () => {
      fireEvent.keyDown(document.querySelector("[data-canopy-trash-row]")!, { key: "Enter" });
    });

    expect(host.restoreElsewhere).toHaveBeenCalledTimes(1);
    expect(host.restoreElsewhere.mock.calls[0]![1]).toEqual({
      hostId: null,
      runId: "gone",
      workspaceId: "p2",
    });
  });

  describe("an assistant", () => {
    beforeEach(() => {
      directory = { ...directory, entries: [assistantEntry()] };
    });

    async function chooseAssistant() {
      await act(async () => {
        fireEvent.click(document.querySelector("[data-canopy-assistant]")!);
      });
      await settle();
    }

    async function pressAssistantButton(name: string) {
      await act(async () => {
        fireEvent.click(
          [...document.querySelectorAll("button")].find(
            (candidate) => candidate.textContent === name
          )!
        );
      });
      await settle();
    }

    it("is opened by the host, and says why it couldn't be", async () => {
      const refusal = "This assistant's session has ended.";
      const host = hostFrame({ openAssistant: vi.fn(async () => refusal) });
      render(<CanopyView frame={host.frame} />);
      await settle();
      await chooseAssistant();

      await pressAssistantButton("Open in Assistant");

      expect(host.openAssistant).toHaveBeenCalledTimes(1);
      expect(openInAssistantMock).not.toHaveBeenCalled();
      expect(surface()!.textContent).toContain(refusal);
      expect(host.close).not.toHaveBeenCalled();
    });

    it("leaves the host open once it opened one: only the host says when to close", async () => {
      const host = hostFrame();
      render(<CanopyView frame={host.frame} />);
      await settle();
      await chooseAssistant();

      await pressAssistantButton("Open in Assistant");

      expect(host.openAssistant).toHaveBeenCalledTimes(1);
      expect(host.close).not.toHaveBeenCalled();
      expect(useCanopyStore.getState().isOpen).toBe(true);
    });

    it("leaves the remembered scope alone when it shows the assistant's work", async () => {
      render(<CanopyView frame={hostFrame().frame} />);
      await settle();
      await chooseAssistant();

      await pressAssistantButton("Show its work");

      expect(useCanopyStore.getState().workOf).not.toBeNull();
      expect(useCanopyStore.getState().scope).toBe("project");
    });
  });

  it("shows nothing once Canopy is hidden, and opens on nothing while it is", async () => {
    const first = render(<CanopyView frame={hostFrame().frame} />);
    await settle();
    expect(surface()).not.toBeNull();

    await act(async () => {
      useCanopyStore.getState().applySnapshot({ ...snapshot, mode: "hidden" });
    });
    expect(surface()).toBeNull();
    first.unmount();

    render(<CanopyView frame={hostFrame().frame} />);
    await settle();
    expect(surface()).toBeNull();
  });

  it("lets everything go with the host", async () => {
    const view = render(<CanopyView frame={hostFrame().frame} />);
    await settle();
    expect(useCanopyStore.getState().isOpen).toBe(true);
    const shownRun = selectedRun()!.replace(/^canopy-card-/, "");
    await answerWatch(shownRun, 7, "SCREEN");

    view.unmount();
    await settle();

    expect(useCanopyStore.getState().isOpen).toBe(false);
    expect(canopy.setActive).toHaveBeenLastCalledWith(false);
    expect(canopy.unwatchTerminal).toHaveBeenCalledWith(7);
  });
});
