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
import { CANOPY_WAITLIST_URL, CanopyView } from "../CanopyView";
import { CANOPY_BETA_TERMS } from "../canopyTerms";
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
    trash: vi.fn(async () => {}),
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
    activate: vi.fn(async (on: boolean) => ({ ...snapshot, activated: on })),
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
  useCanopyStore.setState({ isOpen: true, snapshot: canopySnapshot });
});

afterEach(() => {
  useCanopyStore.setState({
    isOpen: false,
    snapshot: null,
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
    expect(canopy.activate).toHaveBeenCalledWith(true);
    // On: the user's own agents, in the inbox.
    expect(document.querySelector("[data-testid=canopy-dialog] [role=listbox]")).not.toBeNull();
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
    fireEvent.click(screenButton(dialog, "Join waitlist"));
    expect(openExternal).toHaveBeenLastCalledWith(CANOPY_WAITLIST_URL);
    expect(new URL(CANOPY_WAITLIST_URL).protocol).toBe("https:");
    expect(screenButton(dialog, "Join waitlist")).toBeTruthy();
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
    const { container } = render(<CanopyView />);
    await frames();
    const [first, second] = cards(container);
    fireEvent.keyDown(first!, { key: "e" });
    expect(canopy.archive).toHaveBeenCalledWith("waiting", { spawnedAt: NOW - 3_600_000 });
    expect(document.activeElement).toBe(second);
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
      "Archive",
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
    const { container } = render(<CanopyView />);
    await frames();
    fireEvent.keyDown(cards(container)[0]!, { key: "Backspace", metaKey: true, ctrlKey: true });
    // The first press only arms it.
    expect(canopy.trash).not.toHaveBeenCalled();
    fireEvent.keyDown(cards(container)[0]!, { key: "Backspace", metaKey: true, ctrlKey: true });
    expect(canopy.trash).toHaveBeenCalledWith("done", { spawnedAt: NOW - 3_600_000 });
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
