// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render as rtlRender, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";

/** The app root provides tooltips; the rows' action buttons need one. */
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: TooltipProvider });
import type { FleetSnapshot } from "@shared/types/ipc/fleet";
import type { CanopyCard, CanopySnapshot } from "@shared/types/ipc/canopy";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
  }
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: vi.fn(),
    configurable: true,
  });
});

afterAll(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: originalScrollIntoView,
    configurable: true,
  });
});

const dispatchMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: dispatchMock } }));
// The pane's live terminal needs a canvas and a PTY host; the list is what is tested here.
vi.mock("../CanopyTerminal", () => ({
  CanopyTerminal: ({ runId }: { runId: string }) => (
    <div data-canopy-terminal="" data-run={runId}>
      <textarea aria-label="Terminal input" />
    </div>
  ),
}));
vi.mock("@/components/Terminal/HybridInputBar", () => ({ HybridInputBar: () => null }));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

import { notify } from "@/lib/notify";
import { CanopyView } from "../CanopyView";
import { CANOPY_BETA_TERMS, CANOPY_WAITLIST_URL } from "../canopyTerms";
import { useCanopyStore } from "@/store/canopyStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { useProjectStore } from "@/store/projectStore";
import { __resetCanopySeenForTests } from "@/lib/canopySeen";
import { __resetCanopyPlaceForTests } from "../CanopyPlace";
import { CANOPY_REVEAL_MS } from "../canopyOrder";

const NOW = Date.now();

function run(runId: string, overrides: Partial<FleetSnapshot["runs"][number]> = {}) {
  return {
    runId,
    workspaceId: "p1",
    spawnedAt: NOW - 3_600_000,
    cwd: "/repo",
    agentId: "claude" as const,
    ...overrides,
  };
}

const canopySnapshot: CanopySnapshot = {
  mode: "on",
  activated: true,
  tier: "priority",
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

function installElectron(
  snapshot: CanopySnapshot = canopySnapshot,
  branchOf: (runId: string) => Promise<string | null> = async (runId) => `feature/${runId}`
) {
  const canopy = {
    onSnapshotUpdated: vi.fn(() => () => {}),
    setActive: vi.fn(async () => snapshot),
    refresh: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
    trash: vi.fn(async (): Promise<number | null> => null),
    untrash: vi.fn(async () => {}),
    reread: vi.fn(async () => {}),
    setShown: vi.fn(async () => {}),
    archive: vi.fn(
      async (
        runId: string,
        target: { spawnedAt: number },
        _expectTurn?: number
      ): Promise<unknown> => ({
        runId,
        spawnedAt: target.spawnedAt,
        turn: 0,
        readTurn: 0,
        markedUnreadAt: null,
        version: 1,
      })
    ),
    unarchive: vi.fn(async () => {}),
    setScope: vi.fn(async () => {}),
    markSeen: vi.fn(async (_runId: string, _looking?: boolean, _place?: string) => {}),
    // Each read change answers with the mark it left, as main does.
    setRead: vi.fn(
      async (runId: string, target: { spawnedAt: number }, read: boolean, turn?: number) => ({
        runId,
        spawnedAt: target.spawnedAt,
        turn: turn ?? 0,
        readTurn: read ? (turn ?? 0) : 0,
        markedUnreadAt: read ? null : NOW,
        version: 2,
      })
    ),
    markAllRead: vi.fn(async (targets: Array<{ runId: string; spawnedAt: number; turn: number }>) =>
      targets.map((target) => ({
        ...target,
        readTurn: target.turn,
        markedUnreadAt: null,
        version: 2,
      }))
    ),
    restoreReads: vi.fn(async (_restores: unknown[]) => {}),
    runBranch: vi.fn((runId: string, _target: { spawnedAt: number }) => branchOf(runId)),
    captureBackdrop: vi.fn(async () => null),
    rename: vi.fn(async (_runId: string, _target: { spawnedAt: number }, _title: string) => {}),
    setMode: vi.fn(async (mode: CanopySnapshot["mode"], _expectRevision?: number) => ({
      ...snapshot,
      mode,
      modeRevision: 5,
      activated: mode === "on",
    })),
  };
  Object.defineProperty(window, "electron", {
    value: { canopy, terminal: { restore: vi.fn() }, system: { openExternal: vi.fn() } },
    configurable: true,
    writable: true,
  });
  return canopy;
}

function screenButton(root: HTMLElement, name: string): HTMLElement {
  const found = [...root.querySelectorAll<HTMLElement>("button")].find(
    (button) => button.textContent?.trim() === name
  );
  if (!found) throw new Error(`No button "${name}"`);
  return found;
}

/** Drain the landing effect's two animation frames. */
async function frames() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

beforeEach(() => {
  __resetCanopySeenForTests();
  __resetCanopyPlaceForTests();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  useProjectStore.setState({
    projects: [{ id: "p1", path: "/repo", name: "app", emoji: "🌳", lastOpened: NOW }],
  });
  useFleetSnapshotStore.setState({
    snapshot: {
      runs: [
        run("waiting", { agentState: "waiting", waitingReason: "approval", since: NOW - 60_000 }),
        run("asking", { agentState: "waiting", waitingReason: "question", since: NOW - 40_000 }),
        run("working", { agentState: "working", since: NOW - 30_000 }),
      ],
      changedAt: NOW,
      degraded: false,
      lastSuccessfulAt: NOW,
    },
  });
  useCanopyStore.setState({ isOpen: true, snapshot: canopySnapshot, mode: "on" });
});

afterEach(() => {
  useCanopyStore.setState({
    isOpen: false,
    snapshot: null,
    mode: "unset",
    scope: "all",
    orders: {},
    unreadOnly: false,
  });
  window.localStorage.removeItem("daintree-canopy-order");
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

/** A reading that puts a working agent above everything: stuck on the same step. */
function stuckCard(runId: string): CanopyCard {
  return {
    runId,
    spawnedAt: NOW - 3_600_000,
    revision: 2,
    category: "working",
    confidence: 0.9,
    attentionProbability: 0.9,
    attentionScore: 95,
    priority: 95,
    stage: "described",
    wordsFromEarlierRead: false,
    priorityFromEarlierRead: false,
    wordsCategory: "working",
    describing: false,
    task: null,
    headline: "Retrying the same failing install",
    summary: null,
    question: null,
    options: [],
    secretPrompt: false,
    risk: "unknown",
    riskReason: null,
    action: null,
    progress: null,
    steps: null,
    tests: "unknown",
    changes: "unknown",
    handledAt: null,
    activity: null,
    glance: { recap: null, said: null, doing: null, action: null },
    statusLine: null,
    contextLeft: null,
    stalledSince: null,
    observedAt: NOW + 10_000,
  };
}

/** A run with turns the user hasn't read. */
function unreadMark(runId: string, turn: number) {
  return { runId, spawnedAt: NOW - 3_600_000, turn, readTurn: 0, markedUnreadAt: null, version: 1 };
}

function liveRun(container: HTMLElement) {
  return container.ownerDocument.querySelector("[data-canopy-terminal]")?.getAttribute("data-run");
}

function cards(container: HTMLElement) {
  return [...container.ownerDocument.querySelectorAll<HTMLElement>("[data-canopy-card]")];
}

function terminalInput(container: HTMLElement) {
  return container.ownerDocument.querySelector<HTMLTextAreaElement>(
    "[data-canopy-terminal] textarea"
  )!;
}

describe("CanopyView", () => {
  it("reads nothing until the user turns it on, showing a demo and what it sends", async () => {
    const canopy = installElectron({ ...canopySnapshot, activated: false, tier: "free" });
    useCanopyStore.setState({ snapshot: { ...canopySnapshot, activated: false, tier: "free" } });
    render(<CanopyView />);
    await frames();
    const dialog = document.querySelector<HTMLElement>("[data-testid=canopy-dialog]")!;
    expect(dialog.textContent).toContain(
      "sends your agents' terminal output to Daintree's servers"
    );
    // What it sends, how far redaction goes, and how to stop, said where consent is given.
    expect(dialog.textContent).toContain("recent scrollback");
    expect(dialog.textContent).toContain("This can miss some secrets.");
    expect(dialog.textContent).toContain("Settings > Canopy");
    // The keyboard lands on the offer's heading: Enter alone agrees to nothing.
    expect(document.activeElement?.id).toBe("canopy-pitch-title");
    fireEvent.click(screenButton(dialog, "Privacy policy"));
    expect(window.electron.system.openExternal).toHaveBeenLastCalledWith(
      "https://daintree.org/privacy"
    );
    // The demo's made-up agents, never the user's own runs, and nothing streamed.
    const rows = [...dialog.querySelectorAll<HTMLElement>("[data-canopy-card]")];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.id.startsWith("canopy-demo-"))).toBe(true);
    expect(rows.every((row) => row.closest("[inert]") !== null)).toBe(true);
    expect(dialog.querySelector("[role=listbox]")).toBeNull();
    expect(dialog.querySelector("[data-canopy-terminal]")).toBeNull();
    expect(canopy.markSeen).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screenButton(dialog, "Turn on Canopy"));
    });
    expect(canopy.setMode).toHaveBeenCalledWith("on");
    // On: the user's own agents, in the inbox.
    expect(document.querySelector("[data-testid=canopy-dialog] [role=listbox]")).not.toBeNull();
  });

  it("hides Canopy from its offer, closing it with a way back", async () => {
    const off = {
      ...canopySnapshot,
      mode: "unset" as const,
      activated: false,
      tier: "free" as const,
    };
    const canopy = installElectron(off);
    useCanopyStore.setState({ snapshot: off, mode: "unset" });
    const notifySpy = vi.mocked(notify);
    notifySpy.mockClear();
    render(<CanopyView />);
    await frames();
    const dialog = document.querySelector<HTMLElement>("[data-testid=canopy-dialog]")!;
    await act(async () => {
      fireEvent.click(screenButton(dialog, "Hide Canopy"));
    });
    expect(canopy.setMode).toHaveBeenCalledWith("hidden");
    expect(useCanopyStore.getState()).toMatchObject({ isOpen: false, mode: "hidden" });
    const [options] = notifySpy.mock.calls.at(-1)!;
    expect(options).toMatchObject({
      title: "Canopy hidden",
      message: "Show it again from Settings > Canopy.",
    });

    await act(async () => {
      options.action!.onClick();
    });
    // Against the revision the hide left: main changes nothing if Canopy has moved on since.
    expect(canopy.setMode).toHaveBeenLastCalledWith("unset", 5);
    expect(useCanopyStore.getState().mode).toBe("unset");
  });

  it("undoes against its own hide, never a later one it heard of since", async () => {
    const off = {
      ...canopySnapshot,
      mode: "unset" as const,
      activated: false,
      tier: "free" as const,
    };
    const canopy = installElectron(off);
    useCanopyStore.setState({ snapshot: off, mode: "unset" });
    const notifySpy = vi.mocked(notify);
    notifySpy.mockClear();
    render(<CanopyView />);
    await frames();
    const dialog = document.querySelector<HTMLElement>("[data-testid=canopy-dialog]")!;
    await act(async () => {
      fireEvent.click(screenButton(dialog, "Hide Canopy"));
    });
    const [options] = notifySpy.mock.calls.at(-1)!;
    // Shown and hidden again from Settings while the toast is up.
    act(() => {
      useCanopyStore
        .getState()
        .applySnapshot({ ...off, mode: "unset", modeRevision: 6, sequence: 10 });
      useCanopyStore
        .getState()
        .applySnapshot({ ...off, mode: "hidden", modeRevision: 7, sequence: 11 });
    });
    await act(async () => {
      options.action!.onClick();
    });
    // Main refuses it: revision 5 is no longer where Canopy stands.
    expect(canopy.setMode).toHaveBeenLastCalledWith("unset", 5);
  });

  it("says where to show Canopy when its Undo fails", async () => {
    const off = {
      ...canopySnapshot,
      mode: "unset" as const,
      activated: false,
      tier: "free" as const,
    };
    const canopy = installElectron(off);
    useCanopyStore.setState({ snapshot: off, mode: "unset" });
    const notifySpy = vi.mocked(notify);
    notifySpy.mockClear();
    render(<CanopyView />);
    await frames();
    const dialog = document.querySelector<HTMLElement>("[data-testid=canopy-dialog]")!;
    await act(async () => {
      fireEvent.click(screenButton(dialog, "Hide Canopy"));
    });
    const [options] = notifySpy.mock.calls.at(-1)!;
    canopy.setMode.mockRejectedValueOnce(new Error("rate limited"));
    await act(async () => {
      options.action!.onClick();
    });
    const [failure] = notifySpy.mock.calls.at(-1)!;
    expect(failure).toMatchObject({ type: "error", title: "Couldn't show Canopy" });
    failure.action!.onClick();
    expect(dispatchMock).toHaveBeenLastCalledWith(
      "app.settings.openTab",
      { tab: "canopy" },
      { source: "user" }
    );
  });

  it("keeps the offer open, saying so, when hiding Canopy fails", async () => {
    const off = {
      ...canopySnapshot,
      mode: "unset" as const,
      activated: false,
      tier: "free" as const,
    };
    const canopy = installElectron(off);
    canopy.setMode.mockRejectedValueOnce(new Error("rate limited"));
    useCanopyStore.setState({ snapshot: off, mode: "unset" });
    vi.mocked(notify).mockClear();
    render(<CanopyView />);
    await frames();
    const dialog = document.querySelector<HTMLElement>("[data-testid=canopy-dialog]")!;
    await act(async () => {
      fireEvent.click(screenButton(dialog, "Hide Canopy"));
    });
    expect(useCanopyStore.getState().isOpen).toBe(true);
    expect(dialog.textContent).toContain("Couldn't hide Canopy. Try again.");
    expect(vi.mocked(notify)).not.toHaveBeenCalled();
  });

  it("tells a free user every time that the beta is free, and a paying one never", async () => {
    installElectron({ ...canopySnapshot, tier: "free" });
    useCanopyStore.setState({ snapshot: { ...canopySnapshot, tier: "free" } });
    const free = render(<CanopyView />);
    await frames();
    const notice = CANOPY_BETA_TERMS;
    const dialog = document.querySelector<HTMLElement>("[data-testid=canopy-dialog]")!;
    expect(dialog.textContent).toContain(notice);
    // No free tier promised past the beta.
    expect(dialog.textContent).not.toContain("slower queue");
    expect(dialog.textContent).not.toContain("$");
    const openExternal = vi.mocked(window.electron.system.openExternal);
    fireEvent.click(screenButton(dialog, "Send feedback"));
    expect(openExternal).toHaveBeenLastCalledWith(
      "mailto:greg@daintree.org?subject=Canopy%20beta%20feedback"
    );
    // The waitlist is a page on the website, opened in the browser.
    fireEvent.click(screenButton(dialog, "Paid plan waitlist"));
    expect(openExternal).toHaveBeenLastCalledWith(CANOPY_WAITLIST_URL);
    expect(new URL(CANOPY_WAITLIST_URL).protocol).toBe("https:");
    expect(screenButton(dialog, "Paid plan waitlist")).toBeTruthy();
    free.unmount();

    installElectron();
    useCanopyStore.setState({ snapshot: canopySnapshot });
    render(<CanopyView />);
    await frames();
    expect(document.querySelector("[data-testid=canopy-dialog]")?.textContent).not.toContain(
      notice
    );
  });

  it("shows a pressed refresh as busy until it is done", async () => {
    const canopy = installElectron();
    let done!: () => void;
    canopy.refresh.mockImplementation(() => new Promise<void>((resolve) => (done = resolve)));
    render(<CanopyView />);
    await frames();
    const dialog = document.querySelector<HTMLElement>("[data-testid=canopy-dialog]")!;
    const button = dialog.querySelector<HTMLElement>('button[aria-label="Refresh"]')!;
    expect(button.getAttribute("aria-busy")).toBeNull();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(button.getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      done();
    });
    expect(button.getAttribute("aria-busy")).toBeNull();
  });

  it("keeps the panel's keys behind a button rather than a standing footer", async () => {
    installElectron();
    render(<CanopyView />);
    await frames();
    const dialog = document.querySelector<HTMLElement>("[data-testid=canopy-dialog]")!;
    expect(document.body.textContent).not.toContain("Take the first choice");
    const button = dialog.querySelector<HTMLElement>('button[aria-label="Keyboard shortcuts"]')!;
    await act(async () => {
      fireEvent.click(button);
    });
    expect(document.body.textContent).toContain("Take the first choice");
    // Every way the list moves, and what Cmd+W does where the keyboard is.
    expect(document.body.textContent).toContain("Move down or up");
    expect(document.body.textContent).toContain("First or last agent");
    expect(document.body.textContent).toContain("Close Canopy");
    // Off the Mac, only from a reply: the terminal keeps Ctrl+W for the shell.
    expect(document.body.textContent).toMatch(/trash the agent's terminal/i);
  });

  it("steps to the next agent with ⌘↓ from inside its terminal, keeping the keyboard in the pane", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    expect(liveRun(container)).toBe("waiting");
    terminalInput(container).focus();
    fireEvent.keyDown(terminalInput(container), { key: "ArrowDown", metaKey: true });
    expect(liveRun(container)).toBe("asking");
    await frames();
    expect(document.activeElement).toBe(terminalInput(container));
    // Clamped at the top rather than wrapping.
    fireEvent.keyDown(terminalInput(container), { key: "ArrowUp", metaKey: true });
    fireEvent.keyDown(terminalInput(container), { key: "ArrowUp", metaKey: true });
    expect(liveRun(container)).toBe("waiting");
  });

  it("steps between agents with Alt+↑/↓ off the Mac, and leaves Ctrl+↑/↓ to the terminal", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    const [first, second] = cards(container);
    fireEvent.keyDown(first!, { key: "ArrowDown", ctrlKey: true });
    expect(liveRun(container)).toBe("waiting");
    fireEvent.keyDown(first!, { key: "ArrowDown", altKey: true });
    expect(liveRun(container)).toBe("asking");
    expect(document.activeElement).toBe(second);
  });

  it("archives the selected run with E and moves the cursor on to the next", async () => {
    const canopy = installElectron();
    vi.mocked(notify).mockClear();
    const { container } = render(<CanopyView />);
    await frames();
    const [first, second] = cards(container);
    await act(async () => {
      fireEvent.keyDown(first!, { key: "e" });
    });
    expect(canopy.archive).toHaveBeenCalledWith("waiting", { spawnedAt: NOW - 3_600_000 });
    expect(document.activeElement).toBe(second);
    // The user archived it and watched it go: no toast. Z takes it back.
    expect(vi.mocked(notify)).not.toHaveBeenCalled();
    fireEvent.keyDown(second!, { key: "z" });
    expect(canopy.unarchive).toHaveBeenCalledWith("waiting", { spawnedAt: NOW - 3_600_000 });
  });

  it("renames the selected run from F2 on its row, in its title bar", async () => {
    const canopy = installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    fireEvent.keyDown(cards(container)[0]!, { key: "F2" });
    await frames();
    const field = document.querySelector<HTMLInputElement>(
      "[data-canopy-detail] [data-canopy-rename] input"
    )!;
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: "auth fix" } });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(canopy.rename).toHaveBeenCalledWith(
      "waiting",
      { spawnedAt: NOW - 3_600_000 },
      "auth fix"
    );
    expect(useCanopyStore.getState().isOpen).toBe(true);
  });

  it("leaves a rename with Escape, and the panel stays open", async () => {
    const canopy = installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    fireEvent.keyDown(cards(container)[0]!, { key: "F2" });
    await frames();
    const field = document.querySelector<HTMLInputElement>(
      "[data-canopy-detail] [data-canopy-rename] input"
    )!;
    fireEvent.change(field, { target: { value: "never mind" } });
    fireEvent.keyDown(field, { key: "Escape" });
    await frames();
    expect(document.querySelector("[data-canopy-rename]")).toBeNull();
    expect(canopy.rename).not.toHaveBeenCalled();
    expect(useCanopyStore.getState().isOpen).toBe(true);
    expect(document.activeElement?.getAttribute("aria-keyshortcuts")).toBe("F2");
  });

  it("takes an archive back with Z pressed before main has answered it", async () => {
    const canopy = installElectron();
    let land: (mark: unknown) => void = () => {};
    canopy.archive.mockImplementationOnce(() => new Promise((resolve) => (land = resolve)));
    const { container } = render(<CanopyView />);
    await frames();
    const [first, second] = cards(container);
    fireEvent.keyDown(first!, { key: "e" });
    fireEvent.keyDown(second!, { key: "z" });
    expect(canopy.unarchive).not.toHaveBeenCalled();
    await act(async () => {
      land({
        runId: "waiting",
        spawnedAt: NOW - 3_600_000,
        turn: 1,
        readTurn: 1,
        markedUnreadAt: null,
        version: 2,
      });
    });
    expect(canopy.unarchive).toHaveBeenCalledWith("waiting", { spawnedAt: NOW - 3_600_000 });
  });

  it("undoes the newest action pressed, whichever main answers last", async () => {
    const canopy = installElectron();
    let land: (mark: unknown) => void = () => {};
    canopy.archive.mockImplementationOnce(() => new Promise((resolve) => (land = resolve)));
    const { container } = render(<CanopyView />);
    await frames();
    const [first, second] = cards(container);
    fireEvent.keyDown(first!, { key: "e" });
    // U on the next run, answered before the archive is.
    await act(async () => {
      fireEvent.keyDown(second!, { key: "u" });
    });
    await act(async () => {
      land({
        runId: "waiting",
        spawnedAt: NOW - 3_600_000,
        turn: 1,
        readTurn: 1,
        markedUnreadAt: null,
        version: 2,
      });
    });
    // Holding Z undoes once; the repeat takes nothing more.
    fireEvent.keyDown(second!, { key: "z" });
    fireEvent.keyDown(second!, { key: "z", repeat: true });
    expect(canopy.restoreReads).toHaveBeenCalledTimes(1);
    expect(canopy.unarchive).not.toHaveBeenCalled();
  });

  it("takes back archiving the last run with Z, though the list is empty", async () => {
    useFleetSnapshotStore.setState({
      snapshot: {
        runs: [run("done", { agentState: "completed", since: NOW - 60_000 })],
        changedAt: NOW,
        degraded: false,
        lastSuccessfulAt: NOW,
      },
    });
    const canopy = installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    await act(async () => {
      fireEvent.keyDown(cards(container)[0]!, { key: "e" });
    });
    act(() => {
      useCanopyStore.getState().applySnapshot({
        ...canopySnapshot,
        sequence: 50,
        dispositions: [{ runId: "done", spawnedAt: NOW - 3_600_000, kind: "archived", at: NOW }],
      });
    });
    await frames();
    // Focus went to Refresh in the header, outside the list.
    const dialog = document.querySelector<HTMLElement>("[data-testid=canopy-dialog]")!;
    const refresh = dialog.querySelector<HTMLElement>('button[aria-label="Refresh"]')!;
    refresh.focus();
    fireEvent.keyDown(refresh, { key: "z" });
    expect(canopy.unarchive).toHaveBeenCalledWith("done", { spawnedAt: NOW - 3_600_000 });
  });

  it("shows only this project's agents when asked, and tells main to read only those", async () => {
    const canopy = installElectron();
    (window as { __DAINTREE_INITIAL_PROJECT__?: unknown }).__DAINTREE_INITIAL_PROJECT__ = {
      id: "p1",
    };
    const fleet = useFleetSnapshotStore.getState().snapshot!;
    useFleetSnapshotStore.setState({
      snapshot: {
        ...fleet,
        runs: [
          ...fleet.runs,
          run("elsewhere", { workspaceId: "p2", agentState: "waiting", since: NOW - 10_000 }),
        ],
      },
    });
    const { container, getByRole } = render(<CanopyView />);
    await frames();
    expect(cards(container).some((card) => card.id.endsWith("elsewhere"))).toBe(true);
    fireEvent.click(getByRole("radio", { name: "This project" }));
    expect(cards(container).some((card) => card.id.endsWith("elsewhere"))).toBe(false);
    expect(canopy.setScope).toHaveBeenLastCalledWith("p1");
    act(() => useCanopyStore.getState().setScope("all"));
  });

  it("lands on the most urgent card and moves between cards with the arrows", async () => {
    installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    const [first, second] = cards(container);
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(first);
  });

  it("says above the pane which project and branch the selected agent is in", async () => {
    const canopy = installElectron();
    render(<CanopyView />);
    await frames();
    await act(async () => {});
    const place = document.querySelector<HTMLElement>("[data-canopy-place]");
    expect(place?.textContent).toContain("🌳");
    expect(place?.textContent).toContain("app");
    expect(place?.textContent).toContain("feature/waiting");
    expect(canopy.runBranch).toHaveBeenCalledWith("waiting", { spawnedAt: NOW - 3_600_000 });
  });

  it("keeps one place bar as the cursor moves, naming the run it lands on", async () => {
    installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    const [first, second] = cards(container);
    fireEvent.keyDown(first!, { key: "ArrowDown" });
    fireEvent.keyDown(second!, { key: "ArrowDown" });
    await act(async () => {});
    const bars = document.querySelectorAll<HTMLElement>("[data-canopy-place]");
    expect(bars).toHaveLength(1);
    expect(bars[0]!.textContent).toContain("feature/working");
    const pane = document.querySelector<HTMLElement>("[data-canopy-detail]");
    expect(pane?.getAttribute("aria-describedby")).toBe(bars[0]!.id);
  });

  it("still names the folder when the branch can't be read", async () => {
    installElectron(canopySnapshot, async () => {
      throw new Error("Too many requests");
    });
    render(<CanopyView />);
    await frames();
    await act(async () => {});
    const place = document.querySelector<HTMLElement>("[data-canopy-place]");
    expect(place?.textContent).toContain("app");
    expect(place?.textContent).toContain("repo");
    expect(place?.textContent).toContain("in folder");
  });

  it("names the worktree instead when the folder has no branch to say", async () => {
    useFleetSnapshotStore.setState({
      snapshot: {
        runs: [
          run("detached", {
            cwd: "/worktrees/login-fix",
            spawnedAt: NOW - 1_234,
            agentState: "waiting",
            waitingReason: "approval",
            since: NOW - 60_000,
          }),
        ],
        changedAt: NOW,
        degraded: false,
        lastSuccessfulAt: NOW,
      },
    });
    installElectron(canopySnapshot, async () => null);
    render(<CanopyView />);
    await frames();
    await act(async () => {});
    const place = document.querySelector<HTMLElement>("[data-canopy-place]");
    expect(place?.textContent).toContain("app");
    expect(place?.textContent).toContain("login-fix");
    expect(place?.textContent).not.toContain("on branch");
  });

  it("tells main the panel is open, and closed again on unmount", async () => {
    const canopy = installElectron();
    const { unmount } = render(<CanopyView />);
    expect(canopy.setActive).toHaveBeenCalledWith(true);
    unmount();
    expect(canopy.setActive).toHaveBeenLastCalledWith(false);
  });

  it("goes to a terminal in this project before closing, and stays open if that fails", async () => {
    installElectron();
    (window as { __DAINTREE_INITIAL_PROJECT__?: unknown }).__DAINTREE_INITIAL_PROJECT__ = {
      id: "p1",
    };
    dispatchMock.mockResolvedValueOnce({ ok: false });
    const { container } = render(<CanopyView />);
    await frames();
    fireEvent.keyDown(cards(container)[0]!, { key: "Enter" });
    expect(dispatchMock).toHaveBeenCalledWith(
      "pilot.openRun",
      { runId: "waiting", workspaceId: "p1" },
      { source: "user" }
    );
    await act(async () => {});
    expect(useCanopyStore.getState().isOpen).toBe(true);
    delete (window as { __DAINTREE_INITIAL_PROJECT__?: unknown }).__DAINTREE_INITIAL_PROJECT__;
  });

  it("reads a run the arrow keys move onto, as a click would", async () => {
    installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    const [first, second] = cards(container);
    fireEvent.keyDown(first!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);
    expect(second!.hasAttribute("data-unread")).toBe(false);
    expect(liveRun(container)).toBe("asking");
  });

  it("opens a run's terminal on a click, not a hover, and reads it through the turn it showed", async () => {
    const canopy = installElectron({
      ...canopySnapshot,
      reads: [unreadMark("waiting", 2), unreadMark("asking", 1)],
    });
    const { container } = render(<CanopyView />);
    await frames();
    const [first, second] = cards(container);
    expect(liveRun(container)).toBe("waiting");
    // Landing on the first run when the panel opens reads nothing by itself.
    expect(first!.getAttribute("data-unread")).toBe("true");
    expect(canopy.setRead).not.toHaveBeenCalled();

    fireEvent.pointerMove(second!);
    expect(liveRun(container)).toBe("waiting");

    fireEvent.click(first!);
    expect(canopy.setRead).toHaveBeenCalledWith("waiting", { spawnedAt: NOW - 3_600_000 }, true, 2);
    fireEvent.click(second!);
    expect(liveRun(container)).toBe("asking");
  });

  it("marks the selected run read or unread with U, and takes it back with Z", async () => {
    const canopy = installElectron({ ...canopySnapshot, reads: [unreadMark("waiting", 1)] });
    const { container } = render(<CanopyView />);
    await frames();
    const [first] = cards(container);
    fireEvent.keyDown(first!, { key: "u" });
    expect(canopy.setRead).toHaveBeenLastCalledWith(
      "waiting",
      { spawnedAt: NOW - 3_600_000 },
      true,
      1
    );
    // The undo is offered once main has answered with what the change left.
    await act(async () => {});
    fireEvent.keyDown(first!, { key: "z" });
    expect(canopy.restoreReads).toHaveBeenCalledWith([
      { mark: unreadMark("waiting", 1), expectVersion: 2 },
    ]);
    // One deep: a second Z has nothing left to undo.
    fireEvent.keyDown(first!, { key: "z" });
    expect(canopy.restoreReads).toHaveBeenCalledTimes(1);
  });

  it("marks every unread run listed read with ⌥U, by the key's place rather than its character", async () => {
    const canopy = installElectron({
      ...canopySnapshot,
      reads: [unreadMark("waiting", 2), unreadMark("asking", 1)],
    });
    const { container } = render(<CanopyView />);
    await frames();
    // On a Mac ⌥U is the umlaut dead key: the event carries no "u".
    fireEvent.keyDown(cards(container)[0]!, { key: "Dead", code: "KeyU", altKey: true });
    expect(canopy.markAllRead).toHaveBeenCalledWith([
      { runId: "waiting", spawnedAt: NOW - 3_600_000, turn: 2 },
      { runId: "asking", spawnedAt: NOW - 3_600_000, turn: 1 },
    ]);
  });

  it("filters to the unread, keeping a row read since until the filter is turned off", async () => {
    installElectron({ ...canopySnapshot, reads: [unreadMark("asking", 1)] });
    const { container } = render(<CanopyView />);
    await frames();
    const ids = () => cards(container).map((card) => card.id.replace("canopy-card-", ""));
    expect(ids()).toEqual(["waiting", "asking", "working"]);
    fireEvent.click(screenButton(container.ownerDocument.body, "Unread1"));
    expect(ids()).toEqual(["asking"]);
    // Read while listed: it stays, rather than vanishing under the user.
    act(() =>
      useCanopyStore.setState({
        snapshot: { ...canopySnapshot, reads: [{ ...unreadMark("asking", 1), readTurn: 1 }] },
      })
    );
    expect(ids()).toEqual(["asking"]);
    fireEvent.click(screenButton(container.ownerDocument.body, "Unread"));
    expect(ids()).toEqual(["waiting", "asking", "working"]);
  });

  it("says first what needs you, then what is unread", async () => {
    installElectron({ ...canopySnapshot, reads: [unreadMark("working", 1)] });
    const { container } = render(<CanopyView />);
    await frames();
    expect(container.ownerDocument.body.textContent).toContain("2 need you · 1 unread");
  });

  it("offers each row's actions on a right-click, with their keys", async () => {
    const canopy = installElectron({ ...canopySnapshot, reads: [unreadMark("waiting", 1)] });
    const { container } = render(<CanopyView />);
    await frames();
    fireEvent.contextMenu(cards(container)[0]!, { clientX: 5, clientY: 5 });
    const items = await within(document.body).findAllByRole("menuitem", { hidden: true });
    expect(items.map((item) => item.firstChild?.textContent)).toEqual([
      "Go to terminal",
      "Reply",
      "Mark as read",
      "Read again",
      "Archive",
      "Rename…",
      "Trash terminal…",
    ]);
    expect(
      items
        .find((item) => item.textContent?.startsWith("Archive"))
        ?.getAttribute("aria-keyshortcuts")
    ).toBe("E");
    fireEvent.click(items.find((item) => item.textContent?.startsWith("Archive"))!);
    expect(canopy.archive).toHaveBeenCalledWith("waiting", { spawnedAt: NOW - 3_600_000 });
  });

  it("shows neither the offer nor the inbox until main says whether Canopy is on", async () => {
    useCanopyStore.setState({ snapshot: null });
    const canopy = installElectron();
    // Main hasn't answered yet.
    canopy.setActive.mockReturnValue(new Promise(() => {}));
    render(<CanopyView />);
    const dialog = document.querySelector<HTMLElement>("[data-testid=canopy-dialog]")!;
    expect(dialog.textContent).not.toContain("Turn on Canopy");
    expect(dialog.querySelector("[role=listbox]")).toBeNull();
    expect(dialog.querySelector("[aria-busy=true]")).not.toBeNull();
    // The keyboard waits inside the dialog, not on whatever opened it.
    await frames();
    expect(document.activeElement).toBe(dialog.querySelector("[aria-busy=true]"));
  });

  it("hands the keyboard straight from the loading panel to the inbox replacing it", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    try {
      useCanopyStore.setState({ snapshot: null });
      const canopy = installElectron();
      let answer: (snapshot: CanopySnapshot) => void = () => {};
      canopy.setActive.mockReturnValue(
        new Promise<CanopySnapshot>((resolve) => {
          answer = resolve;
        })
      );
      render(<CanopyView />);
      await frames();
      // Main answers: the inbox replaces the loading panel.
      await act(async () => {
        answer(canopySnapshot);
      });
      // Never back on the opener in between, where keys reach the grid.
      expect(document.activeElement).not.toBe(opener);
      expect(document.activeElement?.closest("[data-testid=canopy-dialog]")).not.toBeNull();
    } finally {
      opener.remove();
    }
  });

  it("reads a row's screen again from its menu, for a reading that looks wrong", async () => {
    const canopy = installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    fireEvent.contextMenu(cards(container)[0]!, { clientX: 5, clientY: 5 });
    const items = await within(document.body).findAllByRole("menuitem", { hidden: true });
    await act(async () => {
      fireEvent.click(items.find((item) => item.textContent === "Read again")!);
    });
    expect(canopy.reread).toHaveBeenCalledWith("waiting", { spawnedAt: NOW - 3_600_000 });
  });

  it("offers every project when this one has no agents, and says when status is unavailable", async () => {
    useCanopyStore.setState({ scope: "project" });
    window.__DAINTREE_INITIAL_PROJECT__ = {
      id: "elsewhere",
    } as typeof window.__DAINTREE_INITIAL_PROJECT__;
    try {
      installElectron();
      const view = render(<CanopyView />);
      await frames();
      expect(document.body.textContent).toContain("No agents in this project");
      fireEvent.click(screenButton(document.body, "Show all projects"));
      expect(useCanopyStore.getState().scope).toBe("all");
      view.unmount();

      // Daintree can't see its agents: no claim that there are none.
      useCanopyStore.setState({ isOpen: true, scope: "project" });
      useFleetSnapshotStore.setState({
        snapshot: {
          ...useFleetSnapshotStore.getState().snapshot!,
          runs: [],
          degraded: true,
          lastSuccessfulAt: NOW - 120_000,
        },
      });
      render(<CanopyView />);
      await frames();
      expect(document.body.textContent).toContain("Agent status is unavailable");
      expect(document.body.textContent).toContain("Can't tell who needs you right now");
      expect(document.body.textContent).not.toContain("No agents");
    } finally {
      delete window.__DAINTREE_INITIAL_PROJECT__;
    }
  });

  it("starts a rename in the pane from the row's menu", async () => {
    installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    fireEvent.contextMenu(cards(container)[1]!, { clientX: 5, clientY: 5 });
    const items = await within(document.body).findAllByRole("menuitem", { hidden: true });
    const rename = items.find((item) => item.textContent?.startsWith("Rename"))!;
    expect(rename.getAttribute("aria-keyshortcuts")).toBe("F2");
    fireEvent.click(rename);
    await frames();
    // The run it was asked for is the one open, its name ready to type over —
    // once the menu has finished handing focus about.
    await vi.waitFor(() =>
      expect(document.activeElement?.closest("[data-canopy-rename]")).not.toBeNull()
    );
    expect(document.activeElement?.closest("[data-canopy-detail]")?.id).toBe(
      `canopy-detail-${cards(container)[1]!.id.replace(/^canopy-card-/, "")}`
    );
  });

  it("arms Trash from the menu for the pane to confirm, rather than trashing at once", async () => {
    const canopy = installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    fireEvent.contextMenu(cards(container)[1]!, { clientX: 5, clientY: 5 });
    const items = await within(document.body).findAllByRole("menuitem", { hidden: true });
    fireEvent.click(items.find((item) => item.textContent?.startsWith("Trash"))!);
    expect(canopy.trash).not.toHaveBeenCalled();
    // The run it named is open, its Trash armed: the second press trashes it.
    expect(liveRun(container)).toBe("asking");
    await vi.waitFor(() =>
      expect(container.ownerDocument.body.textContent).toContain(
        "Press Trash terminal again to trash it"
      )
    );
    fireEvent.keyDown(cards(container)[1]!, { key: "Backspace", metaKey: true, ctrlKey: true });
    expect(canopy.trash).toHaveBeenCalledWith("asking", { spawnedAt: NOW - 3_600_000 });
  });

  it("offers no Undo for an archive main refused, only the error", async () => {
    const canopy = installElectron();
    canopy.archive.mockRejectedValueOnce(new Error("rate limited"));
    const notifySpy = vi.mocked(notify);
    notifySpy.mockClear();
    const { container } = render(<CanopyView />);
    await frames();
    fireEvent.keyDown(cards(container)[0]!, { key: "e" });
    await vi.waitFor(() => expect(notifySpy).toHaveBeenCalled());
    const titles = notifySpy.mock.calls.map(([options]) => options.title);
    expect(titles).toEqual(["Couldn't archive"]);
    fireEvent.keyDown(cards(container)[0]!, { key: "z" });
    expect(canopy.unarchive).not.toHaveBeenCalled();
  });

  it("announces nothing for an archive main refused without an error", async () => {
    const canopy = installElectron();
    canopy.archive.mockResolvedValueOnce(null);
    vi.mocked(notify).mockClear();
    const { container } = render(<CanopyView />);
    await frames();
    fireEvent.keyDown(cards(container)[0]!, { key: "e" });
    await act(async () => {});
    expect(vi.mocked(notify)).not.toHaveBeenCalled();
    fireEvent.keyDown(cards(container)[0]!, { key: "z" });
    expect(canopy.unarchive).not.toHaveBeenCalled();
  });

  it("forgets a Trash armed from the menu once the user moves to another run", async () => {
    const canopy = installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    fireEvent.contextMenu(cards(container)[0]!, { clientX: 5, clientY: 5 });
    const items = await within(document.body).findAllByRole("menuitem", { hidden: true });
    fireEvent.click(items.find((item) => item.textContent?.startsWith("Trash"))!);
    await vi.waitFor(() => expect(liveRun(container)).toBe("waiting"));
    fireEvent.click(cards(container)[1]!);
    fireEvent.click(cards(container)[0]!);
    // Back on it, one press only arms Trash again.
    fireEvent.keyDown(cards(container)[0]!, { key: "Backspace", metaKey: true, ctrlKey: true });
    expect(canopy.trash).not.toHaveBeenCalled();
  });

  it("counts what needs you across the whole inbox while the Unread filter is on", async () => {
    installElectron({ ...canopySnapshot, reads: [unreadMark("working", 1)] });
    const { container } = render(<CanopyView />);
    await frames();
    fireEvent.click(screenButton(container.ownerDocument.body, "Unread1"));
    expect(cards(container).map((card) => card.id)).toEqual(["canopy-card-working"]);
    expect(container.ownerDocument.body.textContent).toContain("2 need you · 1 unread");
  });

  it("opens the selected row's menu from Shift+F10", async () => {
    installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    fireEvent.keyDown(cards(container)[0]!, { key: "F10", shiftKey: true });
    expect(await within(document.body).findByRole("menu", { hidden: true })).not.toBeNull();
  });

  it("trashes the selected run from the list with its chord pressed twice", async () => {
    useFleetSnapshotStore.setState({
      snapshot: {
        runs: [run("done", { agentState: "completed", since: NOW - 60_000 })],
        changedAt: NOW,
        degraded: false,
        lastSuccessfulAt: NOW,
      },
    });
    const canopy = installElectron();
    canopy.trash.mockResolvedValue(7);
    const { container } = render(<CanopyView />);
    await frames();
    fireEvent.keyDown(cards(container)[0]!, { key: "Backspace", metaKey: true, ctrlKey: true });
    // The first press only arms it.
    expect(canopy.trash).not.toHaveBeenCalled();
    vi.mocked(notify).mockClear();
    await act(async () => {
      fireEvent.keyDown(cards(container)[0]!, { key: "Backspace", metaKey: true, ctrlKey: true });
    });
    expect(canopy.trash).toHaveBeenCalledWith("done", { spawnedAt: NOW - 3_600_000 });
    // The trash keeps it only briefly and its countdown is behind the panel:
    // the way back is the toast's Undo, and Z.
    const toast = vi.mocked(notify).mock.calls.at(-1)![0];
    expect(toast.title).toBe("Terminal trashed");
    const undo = toast.actions?.find((action) => action.label === "Undo");
    expect(undo).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "z" });
    });
    // By the receipt the trash gave, so only that trash of that terminal comes back.
    expect(canopy.untrash).toHaveBeenCalledWith(7);
  });

  it("says nothing needs you only once the open's readings are in, and qualifies it when reads fail", async () => {
    const working = {
      snapshot: {
        runs: [run("working", { agentState: "working", since: NOW - 30_000 })],
        changedAt: NOW,
        degraded: false,
        lastSuccessfulAt: NOW,
      },
    };
    useFleetSnapshotStore.setState(working);
    // Opening, with words still owed for the working run.
    const owed = { ...canopySnapshot, wordsDue: ["working"] };
    useCanopyStore.setState({ snapshot: owed });
    installElectron(owed);
    const first = render(<CanopyView />);
    await frames();
    expect(first.container.ownerDocument.body.textContent).toContain("Checking who needs you…");
    first.unmount();

    useCanopyStore.setState({ isOpen: true });
    useFleetSnapshotStore.setState(working);
    const failing = { ...canopySnapshot, lastError: "Couldn't reach Canopy" };
    useCanopyStore.setState({ snapshot: failing });
    installElectron(failing);
    render(<CanopyView />);
    await frames();
    expect(document.body.textContent).toContain("Nothing needs you that Canopy could read");
  });

  it("counts as seen only the urgent asks it shows, not those the Unread filter hides", async () => {
    // "working" reads as urgent, but it has nothing unread; "asking" has.
    const snap = {
      ...canopySnapshot,
      cards: [stuckCard("working")],
      reads: [unreadMark("asking", 1)],
    };
    useCanopyStore.setState({ snapshot: snap, unreadOnly: true, acknowledged: {} });
    installElectron(snap);
    render(<CanopyView />);
    await frames();
    expect(cards(document.body).map((card) => card.id)).not.toContain("canopy-card-working");
    expect(useCanopyStore.getState().acknowledged.working).toBeUndefined();

    act(() => useCanopyStore.getState().setUnreadOnly(false));
    await frames();
    // Shown now: its ask leaves the toolbar badge.
    expect(useCanopyStore.getState().acknowledged.working).toBe(`${NOW - 3_600_000}:2`);
  });

  it('withholds "Nothing needs you" while a read waits to be retried or agent status is unavailable', async () => {
    const working = (degraded: boolean) => ({
      snapshot: {
        runs: [run("working", { agentState: "working", since: NOW - 30_000 })],
        changedAt: NOW,
        degraded,
        lastSuccessfulAt: NOW,
      },
    });
    useFleetSnapshotStore.setState(working(false));
    // A settled, calm reading, so only the retry holds the conclusion back.
    const calm = {
      ...stuckCard("working"),
      priority: 5,
      attentionScore: 5,
      headline: "Running the suite",
    };
    const retrying = { ...canopySnapshot, cards: [calm], waiting: "retrying" as const };
    useCanopyStore.setState({ snapshot: retrying });
    installElectron(retrying);
    const first = render(<CanopyView />);
    await frames();
    expect(document.body.textContent).toContain("Checking who needs you…");
    // Once the retry is through, the conclusion stands.
    act(() => useCanopyStore.getState().applySnapshot({ ...canopySnapshot, cards: [calm] }));
    await frames();
    expect(document.body.textContent).toContain("Nothing needs you");
    expect(document.body.textContent).not.toContain("Checking who needs you…");
    first.unmount();

    useCanopyStore.setState({ isOpen: true, snapshot: canopySnapshot });
    useFleetSnapshotStore.setState(working(true));
    installElectron();
    render(<CanopyView />);
    await frames();
    expect(document.body.textContent).toContain("Can't tell who needs you right now");
  });

  it("lists a working run with the rest and lands on the top of the list", async () => {
    useFleetSnapshotStore.setState({
      snapshot: {
        runs: [run("working", { agentState: "working", since: NOW - 30_000 })],
        changedAt: NOW,
        degraded: false,
        lastSuccessfulAt: NOW,
      },
    });
    installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    expect(cards(container).map((card) => card.id)).toEqual(["canopy-card-working"]);
    expect(liveRun(container)).toBe("working");
    expect(container.ownerDocument.body.textContent).not.toContain("Everything else");
  });

  it("tells main when a look at the shown run starts and ends, and starts none while the window is away", async () => {
    const canopy = installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    const marked = () => canopy.markSeen.mock.calls.map(([id, looking]) => `${id}:${looking}`);
    expect(marked()).toEqual(["waiting:true"]);
    fireEvent.click(cards(container)[1]!);
    expect(marked()).toEqual(["waiting:true", "waiting:false", "asking:true"]);
    // A snapshot landing re-renders the panel but is no new look.
    act(() => useCanopyStore.setState({ snapshot: { ...canopySnapshot, refreshedAt: NOW + 1 } }));
    expect(marked()).toEqual(["waiting:true", "waiting:false", "asking:true"]);

    vi.mocked(document.hasFocus).mockReturnValue(false);
    fireEvent.click(cards(container)[2]!);
    expect(marked()).toEqual(["waiting:true", "waiting:false", "asking:true", "asking:false"]);
  });

  it("holds the order under the pointer, and re-ranks once the user leaves it alone", async () => {
    installElectron();
    useCanopyStore.setState({
      orders: {
        all: {
          ids: ["waiting", "asking", "working"],
          rankedFor: canopySnapshot.refreshedAt,
          urgent: [],
        },
      },
    });
    const { container } = render(<CanopyView />);
    await frames();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const order = () => cards(container).map((card) => card.id.replace("canopy-card-", ""));
    expect(order()).toEqual(["waiting", "asking", "working"]);

    const list = container.ownerDocument.querySelector<HTMLElement>("[role=listbox]")!;
    fireEvent.pointerEnter(list);
    // A scan lands that reads the working agent above the question, though
    // not as an urgent ask: only the hold decides when it moves.
    act(() =>
      useCanopyStore.setState({
        snapshot: {
          ...canopySnapshot,
          refreshedAt: NOW + 10_000,
          cards: [{ ...stuckCard("working"), priority: 84, attentionScore: 84 }],
        },
      })
    );
    expect(order()).toEqual(["waiting", "asking", "working"]);
    fireEvent.pointerLeave(list);
    // Not the moment the pointer leaves: the list was just ranked.
    expect(order()).toEqual(["waiting", "asking", "working"]);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(order()).toEqual(["waiting", "working", "asking"]);
  });

  it("places an ask that turns urgent at once, even under the pointer", async () => {
    installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    const order = () => cards(container).map((card) => card.id.replace("canopy-card-", ""));
    expect(order()).toEqual(["waiting", "asking", "working"]);
    fireEvent.pointerEnter(container.ownerDocument.querySelector<HTMLElement>("[role=listbox]")!);
    act(() =>
      useCanopyStore.setState({
        snapshot: { ...canopySnapshot, refreshedAt: NOW + 10_000, cards: [stuckCard("working")] },
      })
    );
    expect(order()).toEqual(["working", "waiting", "asking"]);
  });

  it("shows every run at once while the cards it is owed are written, and places each as it lands", async () => {
    const owed = { ...canopySnapshot, wordsDue: ["working"] };
    installElectron(owed);
    useCanopyStore.setState({ snapshot: owed });
    const { container } = render(<CanopyView />);
    await frames();
    const order = () => cards(container).map((card) => card.id.replace("canopy-card-", ""));
    expect(order()).toEqual(["waiting", "asking", "working"]);
    // Placing runs as their scores land is what the open is for: the pointer
    // resting on the list doesn't hold it.
    fireEvent.pointerEnter(container.ownerDocument.querySelector<HTMLElement>("[role=listbox]")!);
    act(() =>
      useCanopyStore.setState({
        snapshot: {
          ...canopySnapshot,
          cards: [{ ...stuckCard("working"), priority: 84, attentionScore: 84 }],
        },
      })
    );
    await frames();
    expect(order()).toEqual(["waiting", "working", "asking"]);
  });

  it("stops revealing once the cards it was owed have landed, and holds still after", async () => {
    const owed = { ...canopySnapshot, wordsDue: ["working"] };
    installElectron(owed);
    useCanopyStore.setState({ snapshot: owed });
    const { container } = render(<CanopyView />);
    await frames();
    const revealing = () =>
      container.ownerDocument.querySelector("[data-canopy-list][data-revealing]") !== null;
    expect(revealing()).toBe(true);
    act(() => useCanopyStore.setState({ snapshot: canopySnapshot }));
    await frames();
    expect(revealing()).toBe(false);
    // Revealed: a score landing under the pointer waits, as always.
    fireEvent.pointerEnter(container.ownerDocument.querySelector<HTMLElement>("[role=listbox]")!);
    act(() =>
      useCanopyStore.setState({
        snapshot: {
          ...canopySnapshot,
          refreshedAt: NOW + 20_000,
          cards: [{ ...stuckCard("working"), priority: 84, attentionScore: 84 }],
        },
      })
    );
    await frames();
    expect(cards(container).map((card) => card.id.replace("canopy-card-", ""))).toEqual([
      "waiting",
      "asking",
      "working",
    ]);
  });

  it("shows the runs main is still reading for the first time, and moves them as readings land", async () => {
    // The snapshot in hand is from before the open; main's answer says it is reading.
    installElectron({ ...canopySnapshot, busy: true });
    useCanopyStore.setState({ snapshot: { ...canopySnapshot, active: false } });
    const { container } = render(<CanopyView />);
    await frames();
    const order = () => cards(container).map((card) => card.id.replace("canopy-card-", ""));
    expect(order()).toEqual(["waiting", "asking", "working"]);
    act(() =>
      useCanopyStore.setState({
        snapshot: { ...canopySnapshot, busy: true, cards: [stuckCard("working")] },
      })
    );
    await frames();
    expect(order()).toEqual(["working", "waiting", "asking"]);
  });

  it("holds still like always once the open's readings have had their time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const owed = { ...canopySnapshot, wordsDue: ["working"] };
    installElectron(owed);
    useCanopyStore.setState({ snapshot: owed });
    const { container } = render(<CanopyView />);
    const order = () => cards(container).map((card) => card.id.replace("canopy-card-", ""));
    expect(order()).toEqual(["waiting", "asking", "working"]);
    act(() => {
      vi.advanceTimersByTime(CANOPY_REVEAL_MS);
    });
    fireEvent.pointerEnter(container.ownerDocument.querySelector<HTMLElement>("[role=listbox]")!);
    act(() =>
      useCanopyStore.setState({
        snapshot: {
          ...owed,
          refreshedAt: NOW + 20_000,
          cards: [{ ...stuckCard("working"), priority: 84, attentionScore: 84 }],
        },
      })
    );
    expect(order()).toEqual(["waiting", "asking", "working"]);
  });

  it("opens in the order it was left, or ranked before it shows when something was read meanwhile", async () => {
    installElectron();
    const first = render(<CanopyView />);
    await frames();
    const order = () => cards(document.body).map((card) => card.id.replace("canopy-card-", ""));
    expect(order()).toEqual(["waiting", "asking", "working"]);
    act(() => useCanopyStore.setState({ isOpen: false }));
    first.unmount();

    act(() => useCanopyStore.setState({ isOpen: true }));
    const second = render(<CanopyView />);
    await frames();
    expect(order()).toEqual(["waiting", "asking", "working"]);
    act(() => useCanopyStore.setState({ isOpen: false }));
    second.unmount();

    // Read while closed: the list opens in its new order, with no move to see.
    act(() =>
      useCanopyStore.setState({
        snapshot: { ...canopySnapshot, refreshedAt: NOW + 10_000, cards: [stuckCard("working")] },
      })
    );
    act(() => useCanopyStore.setState({ isOpen: true }));
    render(<CanopyView />);
    expect(order()).toEqual(["working", "waiting", "asking"]);
  });
});
