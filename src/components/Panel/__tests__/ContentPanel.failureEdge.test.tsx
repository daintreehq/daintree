// @vitest-environment jsdom
/**
 * The red edge stays only until the user has had the failed pane in front of
 * them (#16140): focused, its window focused, its view visible, Canopy and
 * Home off it, for the hand-back dwell. This renders the real chrome derivation
 * and error-wait debounce, and feeds the failure store record writes the way
 * the store orchestrator does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { AgentState } from "@shared/types/agent";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";
import { HAND_BACK_SEEN_DWELL_MS } from "@shared/utils/runHandBack";

vi.mock("@/components/Terminal/TerminalContextMenu", () => ({
  TerminalContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    selector({ worktrees: new Map() }),
  useWorktreeStoreOptional: (selector: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    selector({ worktrees: new Map() }),
}));

vi.mock("@/hooks/useWorktreeColorMap", () => ({
  useWorktreeColorMap: () => undefined,
}));

vi.mock("@/components/DragDrop", () => ({
  useIsDragging: () => false,
}));

vi.mock("@/components/Terminal/SubagentChip", () => ({
  SubagentChip: () => null,
}));

const mockState = {
  panel: {} as Record<string, unknown>,
};

vi.mock("@/store", () => ({
  usePreferencesStore: (
    selector: (s: { showGridAgentHighlights: boolean; showAgentTaskTitles: boolean }) => unknown
  ) => selector({ showGridAgentHighlights: false, showAgentTaskTitles: true }),
  usePanelStore: (selector: (s: { panelsById: Record<string, unknown> }) => unknown) =>
    selector({ panelsById: { "t-1": { id: "t-1", kind: "terminal", ...mockState.panel } } }),
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

import { ContentPanel } from "../ContentPanel";
import { usePanelStore } from "@/store/panelStore";
import { useCanopyStore } from "@/store/canopyStore";
import { useProjectHomeStore } from "@/store/projectHomeStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import {
  _resetPanelFailureStoreForTest,
  observePanelFailures,
  usePanelFailureStore,
} from "@/store/panelFailureStore";

interface PaneProps {
  agentState?: AgentState;
  isFocused?: boolean;
  location?: "grid" | "dock" | "dialog";
  isExited?: boolean;
  exitCode?: number | null;
  submitStatus?: "slow" | "stalled" | "failed";
}

function pane(props: PaneProps) {
  return (
    <ContentPanel
      id="t-1"
      title="Claude"
      kind="terminal"
      agentId="claude"
      isFocused={false}
      isMultiPanelGrid
      onFocus={() => {}}
      onClose={() => {}}
      onToggleMaximize={() => {}}
      {...props}
    >
      <div data-testid="panel-body" />
    </ContentPanel>
  );
}

let prevRecords: Record<string, PanelInstance> | undefined;

/**
 * One write of the pane's record, as the panel store holds it and the
 * orchestrator reads it. `alongside` lands in the same commit, the way the
 * pane's own props move with the same store write.
 */
function record(fields: Partial<PtyPanelData>, alongside?: () => void) {
  mockState.panel = fields;
  const panel: PtyPanelData = {
    id: "t-1",
    kind: "terminal",
    title: "Claude",
    location: "grid",
    cwd: "/repo",
    cols: 80,
    rows: 24,
    ...fields,
  };
  const next = { "t-1": panel };
  act(() => {
    observePanelFailures(next, prevRecords);
    alongside?.();
  });
  prevRecords = next;
}

const seenMarks = () => usePanelFailureStore.getState().seen["t-1"];

let windowFocused = true;
let documentHidden = false;

function setDocumentHidden(hidden: boolean) {
  documentHidden = hidden;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

const glyphLabel = () =>
  screen
    .queryAllByRole("status")
    .map((el) => el.getAttribute("aria-label") ?? "")
    .find((label) => label.startsWith("Agent state:")) ?? null;

function setWindowFocused(focused: boolean) {
  windowFocused = focused;
  act(() => {
    window.dispatchEvent(new Event(focused ? "focus" : "blur"));
  });
}

function setStoreFocus(id: string | null) {
  act(() => usePanelStore.setState({ focusedId: id }));
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** Past the error wait's own debounce, so the edge it draws is already up. */
const ERROR_WAIT_DEBOUNCE_MS = 1_000;

function mount(props: PaneProps) {
  const view = render(pane(props));
  let current = props;
  const frame = () => view.container.querySelector<HTMLElement>('[data-panel-id="t-1"]')!;
  return {
    frame,
    edge: () => frame().classList.contains("panel-state-failed"),
    show: (next: PaneProps) => {
      current = { ...current, ...next };
      view.rerender(pane(current));
    },
    unmount: view.unmount,
  };
}

interface FailureKind {
  name: string;
  /** Raises occurrence `n` of this failure and returns the pane props that show it. */
  fail: (n: number) => PaneProps;
  /** Ends it, returning the props of a pane no longer failing. */
  recover: () => PaneProps;
  debounceMs?: number;
}

const FAILURES: FailureKind[] = [
  {
    name: "an error wait",
    fail: () => {
      record({ agentState: "waiting", waitingReason: "error" });
      return { agentState: "waiting" };
    },
    recover: () => {
      record({ agentState: "working" });
      return { agentState: "working" };
    },
    debounceMs: ERROR_WAIT_DEBOUNCE_MS,
  },
  {
    name: "a failed exit",
    fail: () => {
      record({ agentState: "exited", runtimeStatus: "exited", exitCode: 1 });
      return { agentState: "exited", isExited: true, exitCode: 1 };
    },
    // A restart clears the exit.
    recover: () => {
      record({ agentState: "working", runtimeStatus: "running" });
      return { agentState: "working", isExited: false, exitCode: null };
    },
  },
  {
    name: "a failed spawn",
    fail: () => {
      record({ spawnError: { code: "ENOENT", message: "claude: not found" } });
      return {};
    },
    recover: () => {
      record({});
      return {};
    },
  },
  {
    name: "a failed restart",
    fail: (n) => {
      record({ restartError: { message: "cwd gone", timestamp: n, recoverable: true } });
      return {};
    },
    recover: () => {
      record({});
      return {};
    },
  },
  {
    name: "a failed reconnect",
    fail: (n) => {
      record({ reconnectError: { message: "gone", type: "not_found", timestamp: n } });
      return {};
    },
    recover: () => {
      record({});
      return {};
    },
  },
  {
    name: "a failed submit",
    fail: () => {
      act(() => usePanelFailureStore.getState().noteSubmitFailure("t-1"));
      return { submitStatus: "failed" };
    },
    recover: () => ({ submitStatus: undefined }),
  },
];

beforeEach(() => {
  vi.useFakeTimers();
  windowFocused = true;
  documentHidden = false;
  vi.spyOn(document, "hasFocus").mockImplementation(() => windowFocused);
  vi.spyOn(document, "hidden", "get").mockImplementation(() => documentHidden);
  mockState.panel = {};
  prevRecords = undefined;
  _resetPanelFailureStoreForTest();
  useFleetSnapshotStore.setState({ snapshot: null });
  usePanelStore.setState({ focusedId: null, activeDockTerminalId: null });
  useCanopyStore.setState({ isOpen: false });
  useProjectHomeStore.setState({ presented: false });
});

afterEach(() => {
  cleanup();
  _resetPanelFailureStoreForTest();
  useFleetSnapshotStore.setState({ snapshot: null });
  usePanelStore.setState({ focusedId: null, activeDockTerminalId: null });
  useCanopyStore.setState({ isOpen: false });
  useProjectHomeStore.setState({ presented: false });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.each(FAILURES)("ContentPanel red edge for $name", ({ fail, recover, debounceMs }) => {
  it("draws focused or not, goes once the pane has been in front for the dwell, and stays gone", () => {
    const failing = fail(1);
    const view = mount(failing);
    advance(debounceMs ?? 0);
    expect(view.edge()).toBe(true);

    // Unfocused, no amount of time takes it away.
    advance(HAND_BACK_SEEN_DWELL_MS * 3);
    expect(view.edge()).toBe(true);

    setStoreFocus("t-1");
    view.show({ isFocused: true });
    expect(view.edge()).toBe(true);
    advance(HAND_BACK_SEEN_DWELL_MS - 1);
    expect(view.edge()).toBe(true);
    advance(1);
    expect(view.edge()).toBe(false);

    // Leaving the pane, or mounting it again, doesn't bring it back.
    setStoreFocus(null);
    view.show({ isFocused: false });
    expect(view.edge()).toBe(false);
    view.unmount();
    const again = mount({ ...failing, isFocused: false });
    advance(debounceMs ?? 0);
    expect(again.edge()).toBe(false);
  });

  it("raises it again for a new failure on the same pane", () => {
    setStoreFocus("t-1");
    const view = mount({ ...fail(1), isFocused: true });
    advance(debounceMs ?? 0);
    advance(HAND_BACK_SEEN_DWELL_MS);
    expect(view.edge()).toBe(false);

    setStoreFocus(null);
    view.show({ ...recover(), isFocused: false });
    expect(view.edge()).toBe(false);
    view.show(fail(2));
    advance(debounceMs ?? 0);
    expect(view.edge()).toBe(true);
  });
});

describe("ContentPanel red edge look", () => {
  const failedExit = FAILURES.find(({ name }) => name === "a failed exit")!;

  it("clears a pane that fails while already in front after the dwell", () => {
    setStoreFocus("t-1");
    const view = mount({ isFocused: true });
    expect(view.edge()).toBe(false);

    view.show(failedExit.fail(1));
    expect(view.edge()).toBe(true);
    advance(HAND_BACK_SEEN_DWELL_MS - 1);
    expect(view.edge()).toBe(true);
    advance(1);
    expect(view.edge()).toBe(false);
  });

  /** Each way the look can break, and how it comes back. */
  const LOOK_BREAKS: [string, () => void, () => void][] = [
    ["the window loses focus", () => setWindowFocused(false), () => setWindowFocused(true)],
    ["the view is hidden", () => setDocumentHidden(true), () => setDocumentHidden(false)],
    [
      "Canopy opens over it",
      () => act(() => useCanopyStore.setState({ isOpen: true })),
      () => act(() => useCanopyStore.setState({ isOpen: false })),
    ],
    [
      "Home covers the grid",
      () => act(() => useProjectHomeStore.setState({ presented: true })),
      () => act(() => useProjectHomeStore.setState({ presented: false })),
    ],
    ["focus moves to another pane", () => setStoreFocus("t-2"), () => setStoreFocus("t-1")],
  ];

  it.each(LOOK_BREAKS)(
    "starts the dwell over when %s partway through",
    (_label, cover, uncover) => {
      setStoreFocus("t-1");
      const view = mount({ ...failedExit.fail(1), isFocused: true });
      advance(HAND_BACK_SEEN_DWELL_MS - 10);
      cover();
      advance(5);
      uncover();

      // The first dwell's deadline passes without counting.
      advance(10);
      expect(view.edge()).toBe(true);
      advance(HAND_BACK_SEEN_DWELL_MS - 11);
      expect(view.edge()).toBe(true);
      advance(1);
      expect(view.edge()).toBe(false);
    }
  );

  it.each(LOOK_BREAKS)("counts no look while %s", (_label, cover, uncover) => {
    setStoreFocus("t-1");
    cover();
    const view = mount({ ...failedExit.fail(1), isFocused: true });
    advance(HAND_BACK_SEEN_DWELL_MS * 3);
    expect(view.edge()).toBe(true);

    uncover();
    advance(HAND_BACK_SEEN_DWELL_MS);
    expect(view.edge()).toBe(false);
  });

  it("gives a failure that replaces another partway through the dwell a dwell of its own", () => {
    const failedRestart = FAILURES.find(({ name }) => name === "a failed restart")!;
    setStoreFocus("t-1");
    const view = mount({ ...failedRestart.fail(1), isFocused: true });
    advance(HAND_BACK_SEEN_DWELL_MS - 10);
    view.show(failedRestart.fail(2));

    advance(10);
    expect(view.edge()).toBe(true);
    advance(HAND_BACK_SEEN_DWELL_MS - 11);
    expect(view.edge()).toBe(true);
    advance(1);
    expect(view.edge()).toBe(false);
  });

  it("counts nothing for a pane unmounted partway through the dwell", () => {
    setStoreFocus("t-1");
    const view = mount({ ...failedExit.fail(1), isFocused: true });
    advance(HAND_BACK_SEEN_DWELL_MS - 1);
    view.unmount();
    advance(HAND_BACK_SEEN_DWELL_MS);
    expect(seenMarks()).toBeUndefined();

    const again = mount({ agentState: "exited", isExited: true, exitCode: 1, isFocused: true });
    advance(HAND_BACK_SEEN_DWELL_MS - 1);
    expect(again.edge()).toBe(true);
    advance(1);
    expect(again.edge()).toBe(false);
  });

  it("counts a look in an open dock popover, Home or not, and none while it is shut", () => {
    setStoreFocus("t-1");
    act(() => useProjectHomeStore.setState({ presented: true }));
    mount({ ...failedExit.fail(1), isFocused: true, location: "dock" });
    advance(HAND_BACK_SEEN_DWELL_MS * 3);
    expect(seenMarks()).toBeUndefined();

    act(() => usePanelStore.setState({ activeDockTerminalId: "t-1" }));
    advance(HAND_BACK_SEEN_DWELL_MS);
    const exit = usePanelFailureStore.getState().occurrences["t-1"]?.exit?.token;
    expect(exit).toBeDefined();
    expect(seenMarks()?.exit).toBe(exit);
  });
  it("lets a seen failed exit recede like a clean one", () => {
    setStoreFocus("t-1");
    const view = mount({ ...failedExit.fail(1), isFocused: true });
    advance(HAND_BACK_SEEN_DWELL_MS);
    setStoreFocus(null);
    view.show({ isFocused: false });

    expect(view.edge()).toBe(false);
    expect(view.frame().classList.contains("panel-state-exited")).toBe(true);
  });

  it("keeps a seen failure seen when another one beside it ends, and raises a new one beside it", () => {
    setStoreFocus("t-1");
    record({
      agentState: "exited",
      runtimeStatus: "exited",
      exitCode: 1,
      restartError: { message: "cwd gone", timestamp: 1, recoverable: true },
    });
    const view = mount({ agentState: "exited", isExited: true, exitCode: 1, isFocused: true });
    advance(HAND_BACK_SEEN_DWELL_MS);
    expect(view.edge()).toBe(false);
    setStoreFocus(null);
    view.show({ isFocused: false });

    view.show(failedExit.fail(1));
    expect(view.edge()).toBe(false);

    record({
      agentState: "exited",
      runtimeStatus: "exited",
      exitCode: 1,
      spawnError: { code: "ENOENT", message: "claude: not found" },
    });
    view.show({});
    expect(view.edge()).toBe(true);
  });

  it("keeps the error wait's glyph and observed state once the edge has gone", () => {
    const errorWait = FAILURES[0]!;
    act(() =>
      useFleetSnapshotStore.setState({
        snapshot: {
          runs: [
            {
              runId: "t-1",
              workspaceId: "p1",
              spawnedAt: 0,
              cwd: "/repo",
              agentState: "waiting",
              waitingReason: "error",
            },
          ],
          changedAt: 0,
          degraded: false,
          lastSuccessfulAt: null,
        },
      })
    );
    setStoreFocus("t-1");
    const view = mount({ ...errorWait.fail(1), isFocused: true });
    advance(ERROR_WAIT_DEBOUNCE_MS);
    expect(view.edge()).toBe(true);
    const glyphBefore = glyphLabel();
    expect(glyphBefore).toMatch(/^Agent state: /);

    advance(HAND_BACK_SEEN_DWELL_MS);
    expect(view.edge()).toBe(false);
    expect(glyphLabel()).toBe(glyphBefore);
    expect(view.frame().getAttribute("data-agent-state")).toBe("waiting");
  });

  it("never redraws a seen error wait as its agent exits", () => {
    const errorWait = FAILURES[0]!;
    setStoreFocus("t-1");
    const view = mount({ ...errorWait.fail(1), isFocused: true });
    advance(ERROR_WAIT_DEBOUNCE_MS);
    advance(HAND_BACK_SEEN_DWELL_MS);
    expect(view.edge()).toBe(false);

    // Every class the frame passes through, so a single-commit flash shows.
    const drawn: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const { oldValue } of records) drawn.push(oldValue ?? "");
    });
    observer.observe(view.frame(), {
      attributes: true,
      attributeFilter: ["class"],
      attributeOldValue: true,
    });
    // The agent's exit moves its state on and leaves the wait's reason behind.
    record({ agentState: "exited", waitingReason: "error" }, () =>
      view.show({ agentState: "exited" })
    );
    for (const { oldValue } of observer.takeRecords()) drawn.push(oldValue ?? "");
    observer.disconnect();

    drawn.push(view.frame().className);
    expect(drawn.filter((value) => value.includes("panel-state-failed"))).toEqual([]);
  });
});
