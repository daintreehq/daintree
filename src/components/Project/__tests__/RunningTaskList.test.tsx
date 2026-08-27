// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { primeRadix } from "@/components/ui/radix-loader";
import type { PtyPanelData } from "@shared/types/panel";
import { RunningTaskList } from "../RunningTaskList";

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
    expect(screen.getByText("cmd-4")).toBeTruthy();
    expect(screen.queryByText("cmd-5")).toBeNull();
  });

  it("opens the tail so every hidden task is reachable (#12001)", () => {
    seedTasks(8);
    render(<RunningTaskList worktreeId={WORKTREE_ID} />);
    openOverflow();
    for (const i of [5, 6, 7]) {
      expect(within(overflowList()).getByText(`cmd-${i}`)).toBeTruthy();
    }
  });

  it("keeps the trigger's accessible name bounded, not a command dump", () => {
    // A task command is an arbitrary-length string; enumerating the hidden ones
    // would read a paragraph before the button's own state.
    seedTasks(9, { command: "x".repeat(300) });
    render(<RunningTaskList worktreeId={WORKTREE_ID} />);

    const label = screen.getByTestId("running-task-overflow").getAttribute("aria-label") ?? "";
    expect(label).toContain("4");
    expect(label.length).toBeLessThan(80);
  });

  it("partitions the tasks without dropping or duplicating one", () => {
    // Reads the split off the rendered output rather than restating the
    // component's private cap.
    seedTasks(11);
    render(<RunningTaskList worktreeId={WORKTREE_ID} />);

    const commands = Array.from({ length: 11 }, (_, i) => `cmd-${i}`);
    const visible = () => commands.filter((c) => screen.queryAllByText(c).length > 0);

    const inline = visible();
    expect(inline.length).toBeGreaterThan(0);
    expect(inline.length).toBeLessThan(commands.length);

    openOverflow();
    const all = visible();
    expect(all).toHaveLength(commands.length);
    expect(new Set(all).size).toBe(commands.length);
  });

  it("keeps the trigger's count equal to what the disclosure reveals", () => {
    seedTasks(11);
    render(<RunningTaskList worktreeId={WORKTREE_ID} />);

    const shownBefore = Array.from({ length: 11 }, (_, i) => `cmd-${i}`).filter(
      (c) => screen.queryAllByText(c).length > 0
    ).length;
    const trigger = screen.getByTestId("running-task-overflow");
    expect(trigger.textContent).toContain(String(11 - shownBefore));
  });

  it("stops a hidden task, killing that task's own terminal", () => {
    seedTasks(8);
    render(<RunningTaskList worktreeId={WORKTREE_ID} />);
    openOverflow();

    const row = within(overflowList()).getByText("cmd-7").closest('[role="button"]')!;
    fireEvent.click(within(row as HTMLElement).getByLabelText("Stop task"));
    expect(killMock).toHaveBeenCalledWith("task-7");
  });

  it("restarts a hidden failed task", () => {
    seedTasks(8, { runtimeStatus: "exited", exitCode: 1 });
    render(<RunningTaskList worktreeId={WORKTREE_ID} />);
    openOverflow();

    const row = within(overflowList()).getByText("cmd-6").closest('[role="button"]')!;
    fireEvent.click(within(row as HTMLElement).getByLabelText("Restart task"));
    expect(storeState.restartTerminal).toHaveBeenCalledWith("task-6");
  });

  it("dismisses a hidden failed task, dropping it from the tail", () => {
    seedTasks(8, { runtimeStatus: "exited", exitCode: 1 });
    render(<RunningTaskList worktreeId={WORKTREE_ID} />);
    openOverflow();

    const row = within(overflowList()).getByText("cmd-7").closest('[role="button"]')!;
    fireEvent.click(within(row as HTMLElement).getByLabelText("Dismiss"));
    expect(screen.queryByText("cmd-7")).toBeNull();
    expect(screen.getByTestId("running-task-overflow").textContent).toContain("2");
  });

  it("closes on focus, because focusing moves the user off this surface", () => {
    seedTasks(8);
    render(<RunningTaskList worktreeId={WORKTREE_ID} />);
    openOverflow();

    const row = within(overflowList()).getByText("cmd-5").closest('[role="button"]')!;
    fireEvent.click(within(row as HTMLElement).getByLabelText("Focus terminal"));
    expect(storeState.activateTerminal).toHaveBeenCalledWith("task-5");
    expect(screen.queryByText("cmd-6")).toBeNull();
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
