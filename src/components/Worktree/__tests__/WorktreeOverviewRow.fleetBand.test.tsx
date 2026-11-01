// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { WorktreeState } from "@shared/types";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import type { PtyPanelData } from "@shared/types/panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { usePanelStore } from "@/store/panelStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { WorktreeOverviewRow } from "../WorktreeOverviewRow";
import { SESSION_COLORS } from "../terminalStateConfig";

// The overview row draws each session the way its pane does (#16057): amber
// only for an unread Canopy ask, a hand-back unread or finished, an error wait
// blocked, and a prompt that asks nothing in words alone.

vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
  }
});

const WT = "/repo-wt-1";

const worktree = {
  id: WT,
  worktreeId: WT,
  path: WT,
  name: "wt-1",
  branch: "feature/one",
  isCurrent: false,
  isMainWorktree: false,
  worktreeChanges: null,
  lastActivityTimestamp: 1_000,
} as WorktreeState;

const ASK = { kind: "asked", quote: "Run it?", readAt: 1, seen: false } as const;

beforeEach(() => {
  Reflect.set(window, "electron", {
    plugin: { onWorktreeCardStatusesChanged: vi.fn(() => () => {}) },
  });
  useProjectStore.setState({
    currentProject: { id: "proj-a", name: "App", path: "/repo", emoji: "", lastOpened: 0 },
  });
});

afterEach(() => {
  cleanup();
  usePanelStore.setState({ panelsById: {}, panelIds: [], panelIdsByWorktreeId: {} });
  useFleetSnapshotStore.setState({ snapshot: null });
});

/** Claude panes in the worktree, each at the given observed stop, and the fleet's rows for them. */
function seed(
  sessions: Array<{ id: string; pane?: Partial<PtyPanelData>; run?: Partial<FleetRunRow> }>
) {
  const panels = sessions.map(
    ({ id, pane }) =>
      ({
        id,
        kind: "terminal",
        title: `Claude ${id}`,
        lastObservedTitle: `task ${id}`,
        location: "grid",
        worktreeId: WT,
        cwd: WT,
        cols: 80,
        rows: 24,
        launchAgentId: "claude",
        agentState: "waiting",
        ...pane,
      }) as PtyPanelData
  );
  usePanelStore.setState({
    panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
    panelIds: panels.map((p) => p.id),
    panelIdsByWorktreeId: { [WT]: panels.map((p) => p.id) },
  });
  useFleetSnapshotStore.getState().applySnapshot({
    runs: sessions.map(({ id, run }) => ({
      runId: id,
      workspaceId: "proj-a",
      spawnedAt: 1,
      cwd: WT,
      agentState: "waiting" as const,
      ...run,
    })),
    changedAt: 2,
    degraded: false,
    lastSuccessfulAt: 2,
  });
}

function renderRow() {
  const store = createWorktreeStore();
  store.setState({ worktrees: new Map([[WT, worktree]]) });
  setCurrentViewStore(store);
  render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={store}>
        <div role="grid">
          <WorktreeOverviewRow
            worktree={worktree}
            cellId="overview-cell"
            chipState={null}
            isCurrent={false}
            isSelected={false}
            isCursor={false}
            isSelecting={false}
            isLast
            onActivate={vi.fn()}
            onToggleSelect={vi.fn()}
            onBeforeMenuAction={vi.fn()}
            onFocusLost={vi.fn()}
          />
        </div>
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
}

const sessionButton = (id: string) =>
  screen
    .getAllByRole("button")
    .find((b) => (b.getAttribute("aria-label") ?? "").endsWith(`task ${id}`))!;
const sessionName = (id: string) => sessionButton(id).getAttribute("aria-label");
/** Whether the session's drawn glyph wears a state's hue. */
const wears = (id: string, state: keyof typeof SESSION_COLORS) =>
  Array.from(sessionButton(id).querySelectorAll("*")).some((el) =>
    el.classList.contains(SESSION_COLORS[state])
  );

describe("WorktreeOverviewRow sessions from the fleet band", () => {
  it("draws amber only for the unread ask, and names a bare prompt nothing", () => {
    act(() =>
      seed([
        { id: "ask", run: { canopy: ASK } },
        { id: "prompt" },
        { id: "done", run: { handBack: { stoppedAt: 1, seenAt: 2 } } },
      ])
    );
    renderRow();
    expect(sessionName("ask")).toMatch(/, waiting: /);
    expect(sessionName("done")).toMatch(/, finished: /);
    expect(sessionName("prompt")).not.toMatch(/waiting|finished|unread/);
    expect(wears("ask", "waiting")).toBe(true);
    expect(wears("prompt", "waiting")).toBe(false);
    expect(wears("done", "waiting")).toBe(false);
    expect(sessionButton("prompt").querySelectorAll("svg, [data-glyph-box]").length).toBe(
      sessionButton("ask").querySelectorAll("svg, [data-glyph-box]").length - 1
    );
  });

  it("counts the strip's waiting from needs-you alone, with blocked and unread apart", () => {
    act(() =>
      seed([
        { id: "ask", run: { canopy: ASK } },
        { id: "prompt" },
        { id: "review", run: { handBack: { stoppedAt: 1 } } },
        { id: "error", pane: { waitingReason: "error" }, run: { waitingReason: "error" } },
      ])
    );
    renderRow();
    const strip = screen
      .getAllByRole("button")
      .find((b) => (b.getAttribute("aria-label") ?? "").startsWith("4 active sessions"));
    expect(strip?.getAttribute("aria-label")).toBe(
      "4 active sessions: 1 blocked, 1 waiting, 1 unread"
    );
    const indicators = strip!.querySelector('[data-testid="collapsed-session-indicators"]')!;
    const segments = Array.from(indicators.querySelectorAll<HTMLElement>("[data-state]")).map(
      (seg) => seg.dataset.state
    );
    expect(segments.sort()).toEqual(["blocked", "unread", "waiting"]);
  });
});
