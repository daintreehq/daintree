// @vitest-environment jsdom
/**
 * Every pane, tab, dock item and sidebar row keeps a TerminalContextMenu
 * mounted. Closed, it must not re-render for worktree status ticks, its own
 * panel's activity writes or fleet snapshot pushes; opened, it must render what
 * changed while it was closed on the very first frame. Real Radix, the real
 * ordering hooks, and zustand stand-ins for the panel and worktree stores.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "zustand";
import type { WorktreeSnapshot } from "@shared/types";
import type { FleetRunRow, FleetSnapshot } from "@shared/types/ipc/fleet";

const counters = vi.hoisted(() => ({ bodyRenders: 0, orderCalls: 0 }));
// The primitives chunk still loading: every overlay renders its fallback.
const radixCold = vi.hoisted(() => ({ current: false }));

vi.mock("@/components/ui/radix-loader", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/radix-loader")>();
  return {
    ...actual,
    useRadixPrimitives: () => {
      const loaded = actual.useRadixPrimitives();
      return radixCold.current ? null : loaded;
    },
    primeOnEvent: () => {},
  };
});

const stores = await vi.hoisted(async () => {
  const { create, createStore } = await import("zustand");
  return {
    panels: create(() => ({
      panelsById: {} as Record<string, Record<string, unknown>>,
      maximizeTarget: null,
      getPanelGroup: () => undefined,
      watchedPanels: new Set<string>(),
    })),
    worktrees: createStore(() => ({
      worktrees: new Map<string, import("@shared/types").WorktreeSnapshot>(),
      isLoading: false,
      isInitialized: true,
      isReconnecting: false,
      reconnectingAt: null as number | null,
      error: null as string | null,
    })),
  };
});

vi.mock("@/store", () => ({ usePanelStore: stores.panels }));

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: <T,>(selector: (s: ReturnType<typeof stores.worktrees.getState>) => T): T =>
    useStore(stores.worktrees, selector),
}));

vi.mock("@/lib/worktreeFilters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/worktreeFilters")>();
  return {
    ...actual,
    orderWorktreesLikeSidebar: (...args: Parameters<typeof actual.orderWorktreesLikeSidebar>) => {
      counters.orderCalls += 1;
      return actual.orderWorktreesLikeSidebar(...args);
    },
  };
});

// Called once per menu body render.
vi.mock("@/hooks/useIsHibernated", () => ({
  useIsHibernated: () => {
    counters.bodyRenders += 1;
    return false;
  },
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: vi.fn(() => Promise.resolve({ ok: true })),
    get: () => undefined,
    list: () => [],
  },
}));
vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    get: () => undefined,
    getTerminal: () => undefined,
    getSelection: () => "",
  },
}));
vi.mock("@/hooks/usePluginContextMenuItems", () => ({ usePluginContextMenuItems: () => [] }));
vi.mock("@/store/voiceRecordingStore", () => ({
  useVoiceRecordingStore: (selector: (s: unknown) => unknown) =>
    selector({ lockedTarget: null, recentTargets: [] }),
}));
vi.mock("@/store/fleetArmingStore", () => ({
  useFleetArmingStore: (selector: (s: { armedIds: Set<string> }) => unknown) =>
    selector({ armedIds: new Set<string>() }),
  isFleetArmEligible: () => true,
  collectEligibleIds: () => [],
}));
vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: (selector: (s: unknown) => unknown) =>
    selector({ activeWorktreeId: "wt-0" }),
}));
vi.mock("../TerminalHandOver", () => ({
  useOrchestratorCandidates: () => ({ candidateIds: [], refresh: () => {} }),
  TerminalHandOverMenuItems: () => null,
  TerminalHandOverDialog: () => null,
}));

import { primeRadix } from "@/components/ui/radix-loader";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { TerminalContextMenu } from "../TerminalContextMenu";

const MENU_COUNT = 4;
// Radix schedules its focus return on a zero-delay timer after the content unmounts.
const RADIX_TICK_MS = 20;

function fleetSnapshot(runs: Array<Pick<FleetRunRow, "runId" | "snooze">>): FleetSnapshot {
  return {
    runs: runs.map((run) => ({ workspaceId: "p1", spawnedAt: 1, cwd: "/repo/wt-0", ...run })),
    changedAt: 1,
    degraded: false,
    lastSuccessfulAt: 1,
  };
}

function snapshot(i: number, stamp = 0): WorktreeSnapshot {
  return {
    id: `wt-${i}`,
    worktreeId: `wt-${i}`,
    path: `/repo/wt-${i}`,
    name: `feature-${i}`,
    branch: `feature/${i}`,
    isCurrent: false,
    isMainWorktree: i === 0,
    lastActivityTimestamp: 1_700_000_000_000 + i * 1000 + stamp,
  } as WorktreeSnapshot;
}

function setWorktree(i: number, stamp = 0): void {
  const next = new Map(stores.worktrees.getState().worktrees);
  next.set(`wt-${i}`, snapshot(i, stamp));
  act(() => stores.worktrees.setState({ worktrees: next }));
}

function patchPanel(id: string, patch: Record<string, unknown>): void {
  act(() =>
    stores.panels.setState((s) => ({
      panelsById: { ...s.panelsById, [id]: { ...s.panelsById[id], ...patch } },
    }))
  );
}

function pushFleet(runs: Array<Pick<FleetRunRow, "runId" | "snooze">>): void {
  act(() => useFleetSnapshotStore.getState().applySnapshot(fleetSnapshot(runs)));
}

function renderMenus() {
  render(
    <>
      {Array.from({ length: MENU_COUNT }, (_, i) => (
        <TerminalContextMenu key={i} terminalId={`panel-${i}`}>
          <div data-testid={`pane-${i}`} tabIndex={-1}>
            pane {i}
          </div>
        </TerminalContextMenu>
      ))}
    </>
  );
}

function openMenu(i: number): void {
  fireEvent.contextMenu(screen.getByTestId(`pane-${i}`), { clientX: 10, clientY: 10 });
}

beforeAll(async () => {
  await primeRadix();
});

beforeEach(() => {
  const panelsById: Record<string, Record<string, unknown>> = {};
  for (let i = 0; i < MENU_COUNT; i++) {
    panelsById[`panel-${i}`] = {
      id: `panel-${i}`,
      kind: "terminal",
      title: `Agent ${i}`,
      location: "grid",
      worktreeId: "wt-0",
      cwd: "/repo/wt-0",
      launchAgentId: "claude",
      detectedAgentId: "claude",
    };
  }
  stores.panels.setState({ panelsById });
  stores.worktrees.setState({ worktrees: new Map([["wt-0", snapshot(0)]]) });
  useFleetSnapshotStore.setState({ snapshot: null });
  radixCold.current = false;
  counters.bodyRenders = 0;
  counters.orderCalls = 0;
});

afterEach(async () => {
  cleanup();
  await act(() => new Promise((resolve) => setTimeout(resolve, RADIX_TICK_MS)));
});

describe("TerminalContextMenu while closed", () => {
  it("skips worktree ticks, its panel's activity writes and fleet pushes", () => {
    renderMenus();
    counters.bodyRenders = 0;
    counters.orderCalls = 0;

    for (let n = 1; n <= 5; n++) {
      setWorktree(1, n);
      patchPanel(`panel-${n % MENU_COUNT}`, { activityHeadline: `step ${n}`, lastActiveAt: n });
      pushFleet([{ runId: "panel-0" }]);
    }

    expect(counters.bodyRenders).toBe(0);
    expect(counters.orderCalls).toBe(0);
  });

  it("still re-renders when the panel changes worktree", () => {
    renderMenus();
    counters.bodyRenders = 0;

    patchPanel("panel-2", { worktreeId: "wt-1" });

    expect(counters.bodyRenders).toBe(1);
  });

  it("snaps back to closed when a right-click lands before the menu can open", async () => {
    radixCold.current = true;
    renderMenus();
    openMenu(1);
    await act(async () => {});
    expect(screen.queryByRole("menu")).toBeNull();
    counters.bodyRenders = 0;
    counters.orderCalls = 0;

    setWorktree(1, 7);
    patchPanel("panel-1", { activityHeadline: "cold" });
    pushFleet([{ runId: "panel-1" }]);

    expect(counters.bodyRenders).toBe(0);
    expect(counters.orderCalls).toBe(0);
  });

  it("shows a snooze taken while closed on open", async () => {
    renderMenus();
    pushFleet([{ runId: "panel-2" }]);
    pushFleet([{ runId: "panel-2", snooze: { snoozedAt: 1, snoozedUntil: Date.now() + 60_000 } }]);

    openMenu(2);
    const snooze = screen.getByRole("menuitem", { name: /Snooze/ });
    act(() => snooze.focus());
    fireEvent.keyDown(snooze, { key: "ArrowRight" });

    expect(await screen.findByRole("menuitem", { name: /Wake now/ })).toBeTruthy();
  });

  // One body render, with live data, is the proof the first commit is current:
  // were the right-click not to raise the menu, Radix would mount the content
  // from the closed render's elements and the content's signal would correct
  // it in a second render.
  it("renders what changed while closed on the first open frame", () => {
    renderMenus();
    setWorktree(1);
    patchPanel("panel-2", { isInputLocked: true });
    pushFleet([{ runId: "panel-2" }]);
    counters.bodyRenders = 0;

    openMenu(2);

    expect(counters.bodyRenders).toBe(1);
    expect(screen.getByRole("menuitem", { name: "Move to worktree" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Unlock input" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Snooze/ })).toBeTruthy();
  });

  it("follows writes while open, and stops once the menu closes", () => {
    renderMenus();
    openMenu(1);
    expect(screen.queryByRole("menuitem", { name: "Move to worktree" })).toBeNull();

    setWorktree(1);
    expect(screen.getByRole("menuitem", { name: "Move to worktree" })).toBeTruthy();
    patchPanel("panel-1", { isInputLocked: true });
    expect(screen.getByRole("menuitem", { name: "Unlock input" })).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    counters.bodyRenders = 0;
    counters.orderCalls = 0;

    setWorktree(1, 99);
    patchPanel("panel-1", { activityHeadline: "after close" });
    pushFleet([{ runId: "panel-1", snooze: { snoozedAt: 1, snoozedUntil: Date.now() + 60_000 } }]);
    expect(counters.bodyRenders).toBe(0);
    expect(counters.orderCalls).toBe(0);
  });
});
