// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render as rtlRender,
  screen,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import type { AgentDirectory, AgentDirectoryLiveEntry } from "@shared/types/agentDirectory";
import type {
  CanopyPopOut,
  CanopySnapshot,
  CanopyTerminalData,
  CanopyTerminalView,
  CanopyTrashEntry,
} from "@shared/types/ipc/canopy";
import type { FleetSnapshot } from "@shared/types/ipc/fleet";
import { LOCAL_HOST_ID } from "@shared/types/remoteHosts";
import { AppDialog } from "@/components/ui/AppDialog";
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
// The plugin's own module loads over `plugin://` and has its own suites: here
// the pane records what Canopy mounted, with a control of the view's own.
const pluginMounts = vi.hoisted(
  () => [] as Array<{ host: string; mountId: string; viewId: string; kitHostInstalled: boolean }>
);
const installKitHost = vi.hoisted(() => vi.fn());
vi.mock("@/components/Plugin/PluginHostedView", async () => {
  const { createPortal } = await import("react-dom");
  return {
    PluginHostedView: (props: {
      host: string;
      mountId: string;
      source: { view: { id: string } };
    }) => {
      pluginMounts.push({
        host: props.host,
        mountId: props.mountId,
        viewId: props.source.view.id,
        kitHostInstalled: installKitHost.mock.calls.length > 0,
      });
      return (
        <div data-testid="plugin-view">
          <input aria-label="Plugin filter" />
          {/* A dialog the view opened: drawn into the page, outside its box. */}
          {createPortal(<input aria-label="Plugin dialog field" />, document.body)}
        </div>
      );
    },
  };
});
vi.mock("@/services/plugin/appPluginKitHost", () => ({
  installAppPluginKitHost: installKitHost,
}));
const lifecycle = vi.hoisted(() => new Set<(phase: string) => void>());
vi.mock("@/lib/viewCacheState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/viewCacheState")>()),
  subscribeProjectViewLifecycle: (listener: (phase: string) => void) => {
    lifecycle.add(listener);
    return () => lifecycle.delete(listener);
  },
}));

import { CanopyView } from "../CanopyView";
import type { CanopyAssistantItem } from "../canopyAssistants";
import { standaloneCanopyFrame } from "../canopyFrame";
import { CANOPY_TITLE } from "../canopyTerms";
import { _resetCanopyWatchBurstForTests } from "../CanopyTerminal";
import { __resetCanopyPlaceForTests } from "../CanopyPlace";
import { __resetCanopySeenForTests } from "@/lib/canopySeen";
import { resolveCanopyReplyDictation } from "@/services/canopyReplyDictation";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { load as loadTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";
import { useCanopyStore } from "@/store/canopyStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { useProjectStore } from "@/store/projectStore";
import { useUIStore } from "@/store/uiStore";
import { isMac } from "@/lib/platform";
import {
  _resetPluginHostedViewsStoreForTest,
  usePluginHostedViewsStore,
} from "@/store/pluginHostedViewsStore";
import type { PluginCanopyHostedViewDescriptor } from "@shared/types/plugin";

// The service mock never evaluates the real module, so nothing builds it.
await loadTerminalService();

const NOW = Date.now();

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
      // The docked global assistant, still attaching: enough to draw its pane.
      help: {
        onGlobalAssistantChanged: vi.fn(() => () => {}),
        attachGlobalAssistant: vi.fn(() => new Promise(() => {})),
        detachGlobalAssistant: vi.fn(async () => {}),
      },
    },
    configurable: true,
    writable: true,
  });
  return canopy;
}

function hostFrame(refusal: string | null = null) {
  const decisions = {
    close: vi.fn(),
    goToRun: vi.fn(),
    restoreElsewhere: vi.fn(),
    openAssistant: vi.fn(async (_item: CanopyAssistantItem) => refusal),
    takesTerminalSize: "on-use" as const,
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

/** The terminal waits a moment between watches, sparing a run stepped straight past. */
async function answerWatch(runId: string, watchId: number, screen: string) {
  await vi.waitFor(() => expect(watches.some((watch) => watch.runId === runId)).toBe(true));
  const watch = watches.find((candidate) => candidate.runId === runId)!;
  await act(async () => watch.answer({ watchId, snapshot: { data: screen, cols: 80, rows: 24 } }));
  // It paints once its character widths are set, which can take a task longer.
  await vi.waitFor(() => expect(xterm.current!.writes).toContain(screen));
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
    resume: null,
    trashExpanded: false,
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
    expect(useCanopyStore.getState().orders.all).toBeDefined();
    expect(useCanopyStore.getState().orders.project).toBeUndefined();
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
    expect(selectedRun()).toBe(`canopy-card-${other}`);
    await answerWatch(other, 8, "OTHER");
    expect(canopy.unwatchTerminal).toHaveBeenCalledWith(7);
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

  it("offers no way to a pane where the host has none, by button, menu or key", async () => {
    const { frame } = hostFrame();
    render(<CanopyView frame={{ ...frame, goToRun: null }} />);
    await settle();

    await act(async () => {
      fireEvent.click(card("second"));
    });
    await settle();
    expect(surface()!.textContent).not.toContain("Go to terminal");

    await act(async () => {
      fireEvent.contextMenu(card("second"));
    });
    await settle();
    expect(screen.getByRole("menuitem", { name: /Reply/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Go to terminal/ })).toBeNull();
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    });

    await act(async () => {
      fireEvent.keyDown(card("second"), { key: "Enter" });
    });
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(switchToHostMock).not.toHaveBeenCalled();
    expect(surface()).not.toBeNull();
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
    expect(host.close).not.toHaveBeenCalled();
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

    fireEvent.contextMenu(card("first"), { clientX: 5, clientY: 5 });
    const items = await within(document.body).findAllByRole("menuitem", { hidden: true });
    await act(async () => {
      fireEvent.keyDown(items[0]!, { key: "Escape" });
    });
    await vi.waitFor(() => expect(document.querySelector("[role=menu]")).toBeNull());
    expect(host.close).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.keyDown(card("first"), { key: "Escape" });
    });
    expect(host.close).toHaveBeenCalledTimes(1);
  });

  it("keeps Escape for a dialog open over the inbox, even past a new closer", async () => {
    const host = hostFrame();
    const closeDialog = vi.fn();
    const shown = (frame: typeof host.frame, dialogOpen: boolean) => (
      <>
        <CanopyView frame={frame} />
        <AppDialog isOpen={dialogOpen} onClose={closeDialog}>
          <AppDialog.Title>Park agent</AppDialog.Title>
        </AppDialog>
      </>
    );
    const view = render(shown(host.frame, false));
    await settle();
    view.rerender(shown(host.frame, true));
    await settle();

    const replaced = hostFrame();
    view.rerender(shown(replaced.frame, true));
    await settle();
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    expect(closeDialog).toHaveBeenCalledTimes(1);
    expect(host.close).not.toHaveBeenCalled();
    expect(replaced.close).not.toHaveBeenCalled();

    view.rerender(shown(replaced.frame, false));
    await settle();
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    expect(replaced.close).toHaveBeenCalledTimes(1);
    expect(host.close).not.toHaveBeenCalled();
  });

  it("leaves a held Escape, and one an input method took, alone", async () => {
    const host = hostFrame();
    render(<CanopyView frame={host.frame} />);
    await settle();

    await act(async () => {
      fireEvent.keyDown(card("first"), { key: "Escape", repeat: true });
      fireEvent.keyDown(card("first"), { key: "Escape", isComposing: true });
    });

    expect(host.close).not.toHaveBeenCalled();
  });

  it("leaves Escape in the terminal to the agent", async () => {
    const host = hostFrame();
    render(<CanopyView frame={host.frame} />);
    await settle();
    await answerWatch(selectedRun()!.replace(/^canopy-card-/, ""), 7, "SCREEN");

    // In one task, as xterm does it: the gesture the key opens ends with the next.
    fireEvent.keyDown(document.querySelector("[data-canopy-terminal]")!, { key: "Escape" });
    xterm.current!.emitData("\x1b");

    expect(canopy.terminalInput).toHaveBeenCalledWith(7, "\x1b");
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
    await answerWatch("first", 7, "SCREEN");

    await vi.waitFor(() => expect(resolveCanopyReplyDictation().ok).toBe(true));
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
      const host = hostFrame(refusal);
      render(<CanopyView frame={host.frame} />);
      await settle();
      await chooseAssistant();

      await pressAssistantButton("Open in Assistant");

      expect(host.openAssistant).toHaveBeenCalledTimes(1);
      expect(host.openAssistant.mock.calls[0]![0].subject).toEqual(assistantEntry().subject);
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
      expect(surface()).not.toBeNull();
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

  it("shows nothing once Canopy is hidden, and comes back with it", async () => {
    render(<CanopyView frame={hostFrame().frame} />);
    await settle();
    expect(surface()).not.toBeNull();

    await act(async () => {
      useCanopyStore.getState().applySnapshot({ ...snapshot, mode: "hidden", activated: false });
    });
    expect(surface()).toBeNull();

    await act(async () => {
      useCanopyStore.getState().applySnapshot({ ...snapshot, mode: "unset" });
    });
    await settle();
    expect(surface()).not.toBeNull();
    expect(card("first")).not.toBeNull();
  });

  it("reads nothing at all when it opens on a hidden Canopy", async () => {
    useCanopyStore.setState({
      mode: "hidden",
      snapshot: { ...snapshot, mode: "hidden", activated: false },
    });
    render(<CanopyView frame={hostFrame().frame} />);
    await settle();

    expect(surface()).toBeNull();
    expect(useCanopyStore.getState().isOpen).toBe(false);
    expect(canopy.setActive).not.toHaveBeenCalled();
    expect(canopy.watchTerminal).not.toHaveBeenCalled();
  });

  it("keeps the place a host closed for, when it unmounts the inbox after", async () => {
    let closeForTerminal: (listedRunId: string) => void = () => {};
    const host = hostFrame();
    host.goToRun.mockImplementation(
      (_run, panel: { closeForTerminal: typeof closeForTerminal }) => {
        closeForTerminal = panel.closeForTerminal;
      }
    );
    const view = render(<CanopyView frame={host.frame} />);
    await settle();
    await act(async () => {
      fireEvent.keyDown(card("first"), { key: "Enter" });
    });

    await act(async () => closeForTerminal("first"));
    view.unmount();

    expect(useCanopyStore.getState().resume?.runId).toBe("first");
  });

  it("lets everything go with the host", async () => {
    const host = hostFrame();
    const unsubscribe = vi.fn();
    canopy.onSnapshotUpdated.mockReturnValue(unsubscribe);
    const view = render(<CanopyView frame={host.frame} />);
    await settle();
    expect(useCanopyStore.getState().isOpen).toBe(true);
    const shownRun = selectedRun()!.replace(/^canopy-card-/, "");
    await answerWatch(shownRun, 7, "SCREEN");

    view.unmount();
    await settle();

    expect(useCanopyStore.getState().isOpen).toBe(false);
    expect(canopy.setActive).toHaveBeenLastCalledWith(false);
    expect(canopy.unwatchTerminal).toHaveBeenCalledWith(7);
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    expect(host.close).not.toHaveBeenCalled();
  });
});

function canopyPluginView(viewId: string, title: string): PluginCanopyHostedViewDescriptor {
  return {
    id: `plugin-view:acme.beads/${viewId}`,
    pluginId: "acme.beads",
    viewId,
    location: "canopy",
    name: `Beads ${title}`,
    title,
    pluginName: "Beads",
    iconId: "list",
    componentPath: `plugin://acme.beads/__dtv-1/${viewId}.js`,
  };
}

describe("app-wide plugin views in the Canopy window (#16344)", () => {
  const TRIAGE = canopyPluginView("triage", "Triage");

  function offer(views: PluginCanopyHostedViewDescriptor[]) {
    act(() => usePluginHostedViewsStore.setState({ views }));
  }

  function pluginRow(title: string) {
    return within(surface()!).getByRole("option", { name: new RegExp(title) });
  }

  async function showPlugin(title: string) {
    await act(async () => {
      fireEvent.click(pluginRow(title));
    });
    await vi.waitFor(() => expect(screen.queryByTestId("plugin-view")).not.toBeNull());
  }

  beforeEach(() => {
    pluginMounts.length = 0;
    _resetPluginHostedViewsStoreForTest();
  });
  afterEach(() => {
    _resetPluginHostedViewsStoreForTest();
    useCanopyStore.setState({ globalDocked: false });
  });

  it("adds nothing while no plugin offers a view", async () => {
    render(<CanopyView frame={hostFrame().frame} />);
    await settle();
    expect(document.querySelector("[data-canopy-plugins]")).toBeNull();
  });

  it("lists the offered views and fills the pane with the one chosen, as Canopy's own", async () => {
    render(<CanopyView frame={hostFrame().frame} />);
    await settle();
    offer([canopyPluginView("timesheet", "Timesheet"), TRIAGE]);

    const rows = within(surface()!)
      .getAllByRole("option")
      .filter((row) => row.hasAttribute("data-canopy-plugin-row"));
    expect(rows.map((row) => row.textContent)).toEqual(["TimesheetBeads", "TriageBeads"]);
    // Focus alone starts nothing: the view mounts when it is chosen.
    act(() => pluginRow("Triage").focus());
    expect(pluginMounts).toEqual([]);

    await showPlugin("Triage");
    // The kit's host is in before the view first draws: a kit control reads it as it renders.
    expect(pluginMounts[0]).toEqual({
      host: "canopy",
      mountId: `canopy:${TRIAGE.id}`,
      viewId: TRIAGE.id,
      kitHostInstalled: true,
    });
    expect(pluginRow("Triage").getAttribute("aria-selected")).toBe("true");
    // No run reads as the one in the pane while the plugin's view is.
    expect(selectedRun()).toBeUndefined();
    expect(document.querySelector("[data-canopy-detail]")).toBeNull();
  });

  it("gives the pane back to the run the person picks, or to a search", async () => {
    render(<CanopyView frame={hostFrame().frame} />);
    await settle();
    offer([TRIAGE]);
    await showPlugin("Triage");

    await act(async () => {
      fireEvent.click(card("second"));
    });
    expect(screen.queryByTestId("plugin-view")).toBeNull();
    expect(selectedRun()).toBe("canopy-card-second");
    expect(pluginRow("Triage").getAttribute("aria-selected")).toBe("false");

    await showPlugin("Triage");
    const search = within(surface()!).getByRole("combobox", { name: "Search agents" });
    // Even a search that matches no agent: it is the inbox the person went back to.
    await act(async () => {
      fireEvent.change(search, { target: { value: "nothing matches this" } });
    });
    expect(screen.queryByTestId("plugin-view")).toBeNull();
  });

  it("keeps ⌘↑/⌘↓ inside the view, its dialogs included, the view's own", async () => {
    render(<CanopyView frame={hostFrame().frame} />);
    await settle();
    offer([TRIAGE]);
    await showPlugin("Triage");
    const step = { key: "ArrowDown", ...(isMac() ? { metaKey: true } : { altKey: true }) };

    for (const name of ["Plugin filter", "Plugin dialog field"]) {
      const field = screen.getByRole("textbox", { name });
      const press = createEvent.keyDown(field, step);
      await act(async () => {
        fireEvent(field, press);
      });
      expect(press.defaultPrevented).toBe(false);
      expect(screen.queryByTestId("plugin-view")).not.toBeNull();
    }
    // From the search, the list and the docked global assistant they still
    // step through the agents, taking the pane back.
    act(() => useCanopyStore.setState({ globalDocked: true }));
    const from = [
      within(surface()!).getByRole("combobox", { name: "Search agents" }),
      document.querySelector<HTMLElement>("[data-canopy-list]")!,
      document.querySelector<HTMLElement>("[data-canopy-global]")!,
    ];
    for (const target of from) {
      await showPlugin("Triage");
      await act(async () => {
        fireEvent.keyDown(target, step);
      });
      expect(screen.queryByTestId("plugin-view")).toBeNull();
      expect(selectedRun()).toBeDefined();
    }
  });

  it("keeps the view up when the keyboard drops out of it", async () => {
    render(<CanopyView frame={hostFrame().frame} />);
    await settle();
    offer([TRIAGE]);
    await showPlugin("Triage");

    act(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(document.activeElement).toBe(document.body);
    // The fleet moves while the keyboard is nowhere: no run is gone to.
    act(() => useFleetSnapshotStore.setState({ snapshot: { ...FLEET, changedAt: NOW + 1 } }));
    await settle();
    expect(screen.queryByTestId("plugin-view")).not.toBeNull();
    expect(selectedRun()).toBeUndefined();
  });

  it("gives the pane back when the plugin stops offering the view", async () => {
    render(<CanopyView frame={hostFrame().frame} />);
    await settle();
    offer([TRIAGE]);
    await showPlugin("Triage");

    offer([]);
    expect(screen.queryByTestId("plugin-view")).toBeNull();
    expect(document.querySelector("[data-canopy-plugins]")).toBeNull();
    expect(document.querySelector("[data-canopy-detail]")).not.toBeNull();
  });

  it("keeps Escape from closing Canopy, handing the keyboard back to the view's row", async () => {
    const host = hostFrame();
    render(<CanopyView frame={host.frame} />);
    await settle();
    offer([TRIAGE]);
    await showPlugin("Triage");

    const input = screen.getByRole("textbox", { name: "Plugin filter" });
    act(() => input.focus());
    await act(async () => {
      fireEvent.keyDown(input, { key: "Escape" });
    });
    expect(host.close).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(pluginRow("Triage"));
    expect(screen.queryByTestId("plugin-view")).not.toBeNull();
    // A dialog of the view's own takes its Escape where it listens, past this box.
    const seen = vi.fn();
    document.addEventListener("keydown", seen);
    const dialogField = screen.getByRole("textbox", { name: "Plugin dialog field" });
    act(() => dialogField.focus());
    await act(async () => {
      fireEvent.keyDown(dialogField, { key: "Escape" });
    });
    document.removeEventListener("keydown", seen);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(dialogField);
    // Z there is the view's letter, not Canopy's undo.
    const press = new KeyboardEvent("keydown", { key: "z", bubbles: true, cancelable: true });
    act(() => {
      screen.getByTestId("plugin-view").dispatchEvent(press);
    });
    expect(press.defaultPrevented).toBe(false);
  });

  it("lists the views with no agent running, and says how to start one beside them", async () => {
    useFleetSnapshotStore.setState({ snapshot: { ...FLEET, runs: [] } });
    render(<CanopyView frame={hostFrame().frame} />);
    await settle();
    offer([TRIAGE]);

    expect(pluginRow("Triage")).not.toBeNull();
    expect(
      within(surface()!).getAllByText("Launch an agent from the toolbar and it shows up here.")
    ).toHaveLength(1);
    await showPlugin("Triage");
    expect(screen.queryByText("Launch an agent from the toolbar and it shows up here.")).toBeNull();
  });
});

describe("taking up a dialog popped out into the window (#16338)", () => {
  const popOut = (over: Partial<CanopyPopOut> = {}): CanopyPopOut => ({
    hostId: LOCAL_HOST_ID,
    query: "",
    selection: null,
    roleFilter: "all",
    unreadOnly: false,
    keptUnread: [],
    archivedExpanded: false,
    trashExpanded: false,
    workOf: null,
    ...over,
  });

  function search() {
    return surface()!.querySelector<HTMLInputElement>("input[role=combobox]")!;
  }

  /** The row an opening lands on by itself, and the other one. */
  async function defaultAndOther(): Promise<{ landed: string; other: string }> {
    const view = render(<CanopyView frame={hostFrame().frame} />);
    await settle();
    const landed = selectedRun()!.replace(/^canopy-card-/, "");
    view.unmount();
    useCanopyStore.setState({ isOpen: false, popOutLanding: null });
    return { landed, other: landed === "first" ? "second" : "first" };
  }

  afterEach(() =>
    useCanopyStore.setState({ popOutLanding: null, roleFilter: "all", unreadOnly: false })
  );

  it("offers no window of its own to pop out into", async () => {
    render(<CanopyView frame={hostFrame().frame} />);
    await settle();

    expect(within(surface()!).queryByRole("button", { name: "Open in new window" })).toBeNull();
  });

  it("moves a window already open to the dialog's row and filters", async () => {
    render(<CanopyView frame={hostFrame().frame} />);
    await settle();
    const landed = selectedRun()!.replace(/^canopy-card-/, "");
    const other = landed === "first" ? "second" : "first";

    await act(async () => {
      useCanopyStore
        .getState()
        .receivePopOut(
          popOut({ selection: { kind: "worker", runId: other }, trashExpanded: true })
        );
    });
    await settle();

    expect(selectedRun()).toBe(`canopy-card-${other}`);
    expect(document.activeElement).toBe(search());
    expect(useCanopyStore.getState().trashExpanded).toBe(true);
    expect(useCanopyStore.getState().popOutLanding).toBeNull();
  });

  it("puts the dialog's search back in an open window", async () => {
    render(<CanopyView frame={hostFrame().frame} />);
    await settle();

    await act(async () => {
      useCanopyStore.getState().receivePopOut(popOut({ query: "deploy" }));
    });
    await settle();

    expect(search().value).toBe("deploy");
    expect(useCanopyStore.getState().popOutLanding).toBeNull();
  });

  it("lands a new window on the dialog's row, not the one an opening picks", async () => {
    const { other } = await defaultAndOther();
    useCanopyStore
      .getState()
      .receivePopOut(popOut({ selection: { kind: "worker", runId: other } }));

    render(<CanopyView frame={hostFrame().frame} />);
    await settle();

    expect(selectedRun()).toBe(`canopy-card-${other}`);
    expect(useCanopyStore.getState().popOutLanding).toBeNull();
  });

  it("lands as any opening does when the dialog's row has gone", async () => {
    const { landed } = await defaultAndOther();
    useCanopyStore
      .getState()
      .receivePopOut(popOut({ selection: { kind: "worker", runId: "gone" } }));

    render(<CanopyView frame={hostFrame().frame} />);
    await settle();

    expect(selectedRun()).toBe(`canopy-card-${landed}`);
    expect(useCanopyStore.getState().popOutLanding).toBeNull();
  });

  it("gives way to the user acting in the window first", async () => {
    render(<CanopyView frame={hostFrame().frame} />);
    await settle();
    const landed = selectedRun()!.replace(/^canopy-card-/, "");
    const other = landed === "first" ? "second" : "first";
    // Rows that never load hold the landing back until the user acts.
    useFleetSnapshotStore.setState({ snapshot: null });
    await act(async () => {
      useCanopyStore
        .getState()
        .receivePopOut(popOut({ selection: { kind: "worker", runId: other } }));
    });
    expect(useCanopyStore.getState().popOutLanding).not.toBeNull();
    await act(async () => {
      fireEvent.pointerDown(surface()!);
    });
    useFleetSnapshotStore.setState({ snapshot: FLEET });
    await settle();

    expect(useCanopyStore.getState().popOutLanding).toBeNull();
    expect(selectedRun()).not.toBe(`canopy-card-${other}`);
  });

  it("waits for a terminal's match before taking the dialog's row as gone", async () => {
    render(<CanopyView frame={hostFrame().frame} />);
    await settle();
    const landed = selectedRun()!.replace(/^canopy-card-/, "");
    const other = landed === "first" ? "second" : "first";
    let answer!: (runIds: string[]) => void;
    canopy.searchScreens.mockImplementation(
      () => new Promise<string[]>((resolve) => (answer = resolve))
    );

    await act(async () => {
      useCanopyStore
        .getState()
        .receivePopOut(popOut({ query: "needle", selection: { kind: "worker", runId: other } }));
    });
    // Past the search's wait on the typing: the terminals are asked, not yet answered.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(canopy.searchScreens).toHaveBeenCalled();
    expect(useCanopyStore.getState().popOutLanding).not.toBeNull();

    await act(async () => answer([other]));
    await settle();

    expect(selectedRun()).toBe(`canopy-card-${other}`);
    expect(useCanopyStore.getState().popOutLanding).toBeNull();
  });

  it("keeps the dialog's assistant when its role filter comes with it", async () => {
    const second = assistantEntry();
    second.subject = { ...second.subject, terminalId: "help-1", lane: 1 };
    directory = { ...directory, entries: [assistantEntry(), second] };
    render(<CanopyView frame={hostFrame().frame} />);
    await settle();
    const rows = () => [...document.querySelectorAll<HTMLElement>("[data-canopy-assistant]")];
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    const assistantId = decodeURIComponent(rows()[1]!.id.replace(/^canopy-assistant-/, ""));

    await act(async () => {
      useCanopyStore
        .getState()
        .receivePopOut(
          popOut({ roleFilter: "assistants", selection: { kind: "assistant", assistantId } })
        );
    });
    await settle();

    expect(useCanopyStore.getState().roleFilter).toBe("assistants");
    expect(rows()[1]!.getAttribute("aria-selected")).toBe("true");
    expect(rows()[0]!.getAttribute("aria-selected")).not.toBe("true");
    expect(useCanopyStore.getState().popOutLanding).toBeNull();
  });

  it("gives up on rows that never come", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      useFleetSnapshotStore.setState({ snapshot: null });
      useCanopyStore
        .getState()
        .receivePopOut(popOut({ selection: { kind: "worker", runId: "first" } }));
      render(<CanopyView frame={hostFrame().frame} />);
      await act(async () => {});
      await act(async () => {
        vi.advanceTimersByTime(9_999);
      });
      expect(useCanopyStore.getState().popOutLanding).not.toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(useCanopyStore.getState().popOutLanding).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
