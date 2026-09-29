// @vitest-environment jsdom
// Run: npx vitest bench --run src/components/Terminal/__bench__/terminalContextMenuSubs.bench.tsx
//
// Every pane, tab, dock item and sidebar row keeps a TerminalContextMenu
// mounted, open or not. This mounts 20 of them through the real Radix menu,
// the real worktree ordering hooks and zustand stand-ins for the panel and
// worktree stores, then pushes the traffic an active fleet produces: worktree
// snapshot changes to a worktree none of the panels live in, activity writes
// on the panels themselves, and fleet snapshot pushes.
import { bench, describe, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useStore } from "zustand";
import type { WorktreeSnapshot } from "@shared/types";
import type { FleetRunRow } from "@shared/types/ipc/fleet";

const counters = vi.hoisted(() => ({ bodyRenders: 0, orderCalls: 0 }));

const MENU_COUNT = 20;
const WORKTREE_COUNT = 30;
const UPDATES = 100;

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

// Called exactly once per menu body render, so it doubles as the render count.
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

function snapshot(i: number, stamp: number): WorktreeSnapshot {
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

const map = new Map<string, WorktreeSnapshot>();
for (let i = 0; i < WORKTREE_COUNT; i++) map.set(`wt-${i}`, snapshot(i, 0));
stores.worktrees.setState({ worktrees: map });

const panelsById: Record<string, Record<string, unknown>> = {};
for (let i = 0; i < MENU_COUNT; i++) {
  panelsById[`panel-${i}`] = {
    id: `panel-${i}`,
    kind: "terminal",
    title: `Agent ${i}`,
    location: "grid",
    worktreeId: `wt-${i % 5}`,
    cwd: `/repo/wt-${i % 5}`,
    launchAgentId: "claude",
    detectedAgentId: "claude",
    agentState: "working",
  };
}
stores.panels.setState({ panelsById });

const runs: FleetRunRow[] = Array.from({ length: MENU_COUNT }, (_, i) => ({
  runId: `panel-${i}`,
  workspaceId: "p1",
  spawnedAt: 1,
  cwd: `/repo/wt-${i % 5}`,
}));

let seq = 0;
// The unrelated worktree (wt-29) changes status: a fresh Map with one snapshot replaced.
function worktreeTick(): void {
  const next = new Map(stores.worktrees.getState().worktrees);
  next.set(`wt-${WORKTREE_COUNT - 1}`, snapshot(WORKTREE_COUNT - 1, ++seq));
  stores.worktrees.setState({ worktrees: next });
}
// Mirrors `updateActivity`: one panel record replaced, `panelsById` respread.
function activityWrite(i: number): void {
  const id = `panel-${i % MENU_COUNT}`;
  stores.panels.setState((s) => ({
    panelsById: {
      ...s.panelsById,
      [id]: { ...s.panelsById[id], activityHeadline: `step ${++seq}`, lastActiveAt: seq },
    },
  }));
}
function fleetPush(): void {
  useFleetSnapshotStore.getState().applySnapshot({
    runs: runs.map((r) => ({ ...r })),
    changedAt: ++seq,
    degraded: false,
    lastSuccessfulAt: seq,
  });
}

function traffic(): void {
  for (let i = 0; i < UPDATES; i++) {
    act(() => worktreeTick());
    act(() => activityWrite(i));
    act(() => fleetPush());
  }
}

await primeRadix();
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
act(() => fleetPush());

const openRenders: number[] = [];
function openAndCheck(): number {
  const pane = screen.getByTestId("pane-3");
  counters.bodyRenders = 0;
  const start = performance.now();
  fireEvent.contextMenu(pane, { clientX: 10, clientY: 10 });
  const elapsed = performance.now() - start;
  openRenders.push(counters.bodyRenders);
  // Correct on the first frame: the worktree submenu and the snooze item
  // (fleet-known run) are there as soon as the menu is.
  if (!screen.queryByRole("menuitem", { name: "Move to worktree" })) {
    throw new Error("Move to worktree missing on first open frame");
  }
  if (!screen.queryByRole("menuitem", { name: /Snooze/ })) {
    throw new Error("Snooze missing on first open frame");
  }
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  if (screen.queryByRole("menu")) throw new Error("menu did not close");
  return elapsed;
}

const ROUNDS = 5;
const totals: number[] = [];
for (let r = 0; r < ROUNDS; r++) {
  counters.bodyRenders = 0;
  counters.orderCalls = 0;
  const start = performance.now();
  traffic();
  const ms = performance.now() - start;
  totals.push(ms);
  process.stderr.write(
    `[ctxmenu] round ${r + 1}: ${UPDATES} worktree ticks + ${UPDATES} activity writes + ${UPDATES} fleet pushes, ${MENU_COUNT} menus — body renders ${counters.bodyRenders}, orderWorktreesLikeSidebar calls ${counters.orderCalls}, ${ms.toFixed(1)} ms\n`
  );
}
const opens: number[] = [];
for (let r = 0; r < 10; r++) opens.push(openAndCheck());
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
process.stderr.write(
  `[ctxmenu] traffic median ${median(totals).toFixed(1)} ms; open-to-content median ${median(opens).toFixed(2)} ms, body renders per open ${median(openRenders)}\n`
);

describe(`TerminalContextMenu subscriptions (${MENU_COUNT} mounted menus)`, () => {
  bench(`${UPDATES}× worktree tick + activity write + fleet push`, traffic, { iterations: 10 });
  bench("open to content, then close", () => void openAndCheck(), { iterations: 50 });
});
