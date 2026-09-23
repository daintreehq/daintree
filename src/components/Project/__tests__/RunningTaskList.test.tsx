// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { primeRadix } from "@/components/ui/radix-loader";
import type { PtyPanelData } from "@shared/types/panel";
import { RunningTaskList, resetDismissedTasks } from "../RunningTaskList";

const WORKTREE_ID = "wt-1";

const storeState = {
  panelIds: [] as string[],
  panelsById: {} as Record<string, PtyPanelData>,
  activateTerminal: vi.fn(),
  restartTerminal: vi.fn(),
};

vi.mock("@/store/panelStore", () => ({
  usePanelStore: (selector: (s: typeof storeState) => unknown) => selector(storeState),
}));

vi.mock("@/store/slices/panelRegistry/selectors", () => ({
  getNarrowPanel: (byId: Record<string, PtyPanelData>, id: string) => byId[id],
}));

const killMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/clients", () => ({ terminalClient: { kill: (id: string) => killMock(id) } }));

// The elapsed-time tick is irrelevant here and would keep a timer alive past
// the test.
vi.mock("@/hooks/useVisibilityAwareInterval", () => ({ useVisibilityAwareInterval: () => {} }));

class StubResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(async () => {
  await primeRadix();
});

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  storeState.panelIds = [];
  storeState.panelsById = {};
});

afterEach(() => {
  cleanup();
  resetDismissedTasks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function seedTasks(count: number, overrides: Partial<PtyPanelData> = {}) {
  storeState.panelIds = [];
  storeState.panelsById = {};
  for (let i = 0; i < count; i++) {
    const id = `task-${i}`;
    storeState.panelIds.push(id);
    storeState.panelsById[id] = {
      id,
      kind: "terminal",
      title: `task ${i}`,
      cwd: "/repo",
      cols: 80,
      rows: 24,
      command: `cmd-${i}`,
      spawnedBy: "quickrun",
      worktreeId: WORKTREE_ID,
      location: "grid",
      runtimeStatus: "running",
      startedAt: 1_700_000_000_000,
      ...overrides,
    } as PtyPanelData;
  }
}

const openOverflow = () => fireEvent.click(screen.getByTestId("running-task-overflow"));

/** The popover's own list, so a row assertion can't match its inline twin. */
const overflowList = () => screen.getByRole("list");

describe("RunningTaskList overflow", () => {
  it("renders no disclosure while every task fits", () => {
    seedTasks(5);
    render(<RunningTaskList worktreeId={WORKTREE_ID} />);
    expect(screen.getByText("cmd-4")).toBeTruthy();
    expect(screen.queryByTestId("running-task-overflow")).toBeNull();
  });

  it("keeps the tail out of the DOM until the disclosure is opened", () => {
    seedTasks(8);
    render(<RunningTaskList worktreeId={WORKTREE_ID} />);
    expect(screen.getByText("cmd-3")).toBeTruthy();
    expect(screen.queryByText("cmd-2")).toBeNull();
  });

  it("opens the tail so every hidden task is reachable (#12001)", () => {
    seedTasks(8);
    render(<RunningTaskList worktreeId={WORKTREE_ID} />);
    openOverflow();
    for (const i of [0, 1, 2]) {
      expect(within(overflowList()).getByText(`cmd-${i}`)).toBeTruthy();
    }
  });

  it("keeps the trigger's accessible name a name, not a command dump", () => {
    // A task command is an arbitrary-length string; enumerating the hidden ones
    // would read a paragraph before the button's own state. Trimming it to a
    // bare digit would be the opposite failure, so the noun has to survive.
    seedTasks(9, { command: "x".repeat(300) });
    render(<RunningTaskList worktreeId={WORKTREE_ID} />);

    const label = screen.getByTestId("running-task-overflow").getAttribute("aria-label") ?? "";
    expect(label).toContain("4");
    expect(label.toLowerCase()).toContain("task");
    expect(label).not.toContain("xxx");
  });

  it("partitions the tasks without dropping or duplicating one", () => {
    // Counts occurrences rather than presence: a task rendered both inline and
    // in the tail would otherwise pass as "present once".
    seedTasks(11);
    render(<RunningTaskList worktreeId={WORKTREE_ID} />);

    const commands = Array.from({ length: 11 }, (_, i) => `cmd-${i}`);
    const counts = () => commands.map((c) => screen.queryAllByText(c).length);

    const inlineCounts = counts();
    expect(inlineCounts.every((n) => n <= 1)).toBe(true);
    const inlineShown = inlineCounts.filter((n) => n === 1).length;
    expect(inlineShown).toBeGreaterThan(0);
    expect(inlineShown).toBeLessThan(commands.length);

    // The trigger promises exactly the remainder.
    const trigger = screen.getByTestId("running-task-overflow");
    expect(trigger.textContent).toContain(String(commands.length - inlineShown));

    openOverflow();
    // Every task exactly once across both halves — no gap, no overlap.
    expect(counts()).toEqual(commands.map(() => 1));
  });

  it("gives each row action its own keyboard activation", () => {
    seedTasks(8);
    render(<RunningTaskList worktreeId={WORKTREE_ID} />);
    openOverflow();

    const row = within(overflowList()).getByText("cmd-0").closest("[data-task-row]")!;
    const stop = within(row as HTMLElement).getByLabelText("Stop task");

    // The row used to be a role="button" wrapping these actions, and its
    // Enter/Space handler preventDefault()ed the keydown on its way up — so
    // keyboard-stopping a task silently focused its terminal instead. Nothing
    // above an action may swallow that key.
    fireEvent.keyDown(stop, { key: "Enter" });
    fireEvent.click(stop);

    expect(killMock).toHaveBeenCalledWith("task-0");
    expect(storeState.activateTerminal).not.toHaveBeenCalled();
  });

  it("stops a hidden task, killing that task's own terminal", () => {
    seedTasks(8);
    render(<RunningTaskList worktreeId={WORKTREE_ID} />);
    openOverflow();

    const row = within(overflowList()).getByText("cmd-2").closest("[data-task-row]")!;
    fireEvent.click(within(row as HTMLElement).getByLabelText("Stop task"));
    expect(killMock).toHaveBeenCalledWith("task-2");
  });

  it("restarts a hidden failed task", () => {
    seedTasks(8, { runtimeStatus: "exited", exitCode: 1 });
    render(<RunningTaskList worktreeId={WORKTREE_ID} />);
    openOverflow();

    const row = within(overflowList()).getByText("cmd-1").closest("[data-task-row]")!;
    fireEvent.click(within(row as HTMLElement).getByLabelText("Restart task"));
    expect(storeState.restartTerminal).toHaveBeenCalledWith("task-1");
  });

  it("dismisses a hidden failed task, dropping it from the tail", () => {
    seedTasks(8, { runtimeStatus: "exited", exitCode: 1 });
    render(<RunningTaskList worktreeId={WORKTREE_ID} />);
    openOverflow();

    const row = within(overflowList()).getByText("cmd-2").closest("[data-task-row]")!;
    fireEvent.click(within(row as HTMLElement).getByLabelText("Dismiss"));
    expect(screen.queryByText("cmd-2")).toBeNull();
    expect(screen.getByTestId("running-task-overflow").textContent).toContain("2");
  });

  it("closes on focus, because focusing moves the user off this surface", () => {
    seedTasks(8);
    render(<RunningTaskList worktreeId={WORKTREE_ID} />);
    openOverflow();

    const row = within(overflowList()).getByText("cmd-2").closest("[data-task-row]")!;
    fireEvent.click(within(row as HTMLElement).getByLabelText("Focus terminal"));
    expect(storeState.activateTerminal).toHaveBeenCalledWith("task-2");
    expect(screen.queryByText("cmd-1")).toBeNull();
  });

  it("always shows the task launched last, however many came before it", () => {
    // Launching is why the user is looking at this list; the row they just
    // started must never be the one hidden behind the disclosure.
    for (const count of [1, 5, 6, 12]) {
      seedTasks(count);
      const { unmount } = render(<RunningTaskList worktreeId={WORKTREE_ID} />);
      expect(screen.getByText(`cmd-${count - 1}`)).toBeTruthy();
      unmount();
    }
  });

  it("keeps a finished task until it is dismissed", () => {
    // A quick command finishes before the user looks back; the row is the
    // one-step route to its output, so it must not clear itself.
    vi.useFakeTimers();
    try {
      seedTasks(1, { runtimeStatus: "exited", exitCode: 0 });
      render(<RunningTaskList worktreeId={WORKTREE_ID} />);
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      const row = screen.getByText("cmd-0").closest<HTMLElement>("[data-task-row]")!;
      fireEvent.click(within(row).getByLabelText("Dismiss"));
      expect(screen.queryByText("cmd-0")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a dismissal when the list unmounts and mounts again", () => {
    // Collapsing Quick Run unmounts the list; reopening must not bring back
    // what the user already cleared.
    seedTasks(2, { runtimeStatus: "exited", exitCode: 1 });
    const first = render(<RunningTaskList worktreeId={WORKTREE_ID} />);
    const row = screen.getByText("cmd-1").closest<HTMLElement>("[data-task-row]")!;
    fireEvent.click(within(row).getByLabelText("Dismiss"));
    first.unmount();

    render(<RunningTaskList worktreeId={WORKTREE_ID} />);
    expect(screen.queryByText("cmd-1")).toBeNull();
    expect(screen.getByText("cmd-0")).toBeTruthy();
  });

  it("keeps a dismissal while another worktree is shown", () => {
    seedTasks(2, { runtimeStatus: "exited", exitCode: 1 });
    const { rerender } = render(<RunningTaskList worktreeId={WORKTREE_ID} />);
    const row = screen.getByText("cmd-1").closest<HTMLElement>("[data-task-row]")!;
    fireEvent.click(within(row).getByLabelText("Dismiss"));

    rerender(<RunningTaskList worktreeId="wt-other" />);
    rerender(<RunningTaskList worktreeId={WORKTREE_ID} />);
    expect(screen.queryByText("cmd-1")).toBeNull();
  });

  it("drops the disclosure once the tail shrinks back under the cap", () => {
    seedTasks(6);
    const { rerender } = render(<RunningTaskList worktreeId={WORKTREE_ID} />);
    expect(screen.getByTestId("running-task-overflow")).toBeTruthy();

    seedTasks(4);
    rerender(<RunningTaskList worktreeId={WORKTREE_ID} />);
    expect(screen.queryByTestId("running-task-overflow")).toBeNull();
  });

  it("ignores tasks belonging to another worktree", () => {
    seedTasks(8, { worktreeId: "other-wt" });
    const { container } = render(<RunningTaskList worktreeId={WORKTREE_ID} />);
    expect(container.firstChild).toBeNull();
  });
});
