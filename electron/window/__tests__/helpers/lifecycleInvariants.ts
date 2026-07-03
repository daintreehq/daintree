/**
 * Lifecycle invariant assertions shared by ProjectViewManager test suites.
 *
 * Deliberately duck-typed: this helper never imports electron or production
 * modules, so it stays inert under each test file's own vi.mock collar. It
 * reads only the public ProjectViewManager surface plus the mock-window shape
 * the suites already use (contentView.children as a real array).
 *
 * Call at settled points (after switches/gates resolve and immediates flush) —
 * mid-flight a cold gate legitimately holds two "active"-state entries (the
 * incoming view and the outgoing bridge), which invariant 3 accounts for.
 */
import { expect } from "vitest";

interface WebContentsLike {
  id: number;
  isDestroyed(): boolean;
}

interface ViewLike {
  webContents?: WebContentsLike | undefined;
}

interface ViewEntryLike {
  projectId: string;
  state: string;
  view: ViewLike;
}

export interface ManagerLike {
  getActiveProjectId(): string | null;
  getOutgoingBridgeProjectId(): string | null;
  getAllViews(): ViewEntryLike[];
  getAllWebContentsIds(): number[];
  getProjectIdForWebContents(webContentsId: number): string | null;
}

export interface WindowLike {
  isDestroyed(): boolean;
  contentView: { children: unknown[] };
}

/**
 * Assert the manager's cross-referenced state is self-consistent:
 *
 * 1. `views` and `webContentsToProject` agree in both directions, and no
 *    entry retains a destroyed webContents.
 * 2. The active project id resolves to a live entry in the "active" state.
 * 3. Only the active project and an open paint gate's outgoing bridge may
 *    hold the "active" state.
 * 4. No orphaned project children: every attached child that maps to a
 *    project is the active view or the pending gate's outgoing bridge, and
 *    the active view (when set) is actually attached.
 */
export function assertLifecycleInvariants(manager: ManagerLike, win: WindowLike): void {
  const entries = manager.getAllViews();
  const activeProjectId = manager.getActiveProjectId();
  const bridgeProjectId = manager.getOutgoingBridgeProjectId();

  const entryWcIds: number[] = [];
  for (const entry of entries) {
    const wc = entry.view.webContents;
    expect(wc, `entry ${entry.projectId} lost its webContents but is still tracked`).toBeTruthy();
    if (!wc) continue;
    expect(
      wc.isDestroyed(),
      `entry ${entry.projectId} retains a destroyed webContents (wc ${wc.id})`
    ).toBe(false);
    expect(
      manager.getProjectIdForWebContents(wc.id),
      `webContentsToProject disagrees with views for wc ${wc.id}`
    ).toBe(entry.projectId);
    entryWcIds.push(wc.id);
  }
  expect(
    [...manager.getAllWebContentsIds()].sort((a, b) => a - b),
    "webContentsToProject holds ids with no backing view entry"
  ).toEqual(entryWcIds.sort((a, b) => a - b));

  if (activeProjectId !== null) {
    const active = entries.find((entry) => entry.projectId === activeProjectId);
    expect(active, `active project ${activeProjectId} has no view entry`).toBeTruthy();
    expect(active?.state, `active project ${activeProjectId} is not in the "active" state`).toBe(
      "active"
    );
  }

  for (const entry of entries) {
    if (entry.state !== "active") continue;
    expect(
      entry.projectId === activeProjectId || entry.projectId === bridgeProjectId,
      `entry ${entry.projectId} is "active" but is neither the active project nor a gate bridge`
    ).toBe(true);
  }

  if (!win.isDestroyed()) {
    for (const child of win.contentView.children as ViewLike[]) {
      const wc = child?.webContents;
      if (!wc || wc.isDestroyed()) continue;
      const projectId = manager.getProjectIdForWebContents(wc.id);
      // Non-project children (welcome view, parked portals) own their own
      // attach lifecycle — only project views are orphan candidates here.
      if (projectId === null) continue;
      expect(
        projectId === activeProjectId || projectId === bridgeProjectId,
        `orphaned project view still attached: ${projectId} (wc ${wc.id})`
      ).toBe(true);
    }
    if (activeProjectId !== null) {
      const active = entries.find((entry) => entry.projectId === activeProjectId);
      if (active) {
        expect(
          win.contentView.children,
          `active project ${activeProjectId}'s view is not attached to the window`
        ).toContain(active.view);
      }
    }
  }
}

/**
 * Track simulated per-view producer ports against the eviction/cache
 * callbacks, mirroring the main.ts wiring (onViewEvicted/onViewCached both
 * close the view's worktree + workspace ports). Tests call `openFor` when a
 * view would have a port brokered and wire the two callbacks into the manager
 * options; `assertNoPortsForDeadViews` then proves no closed/evicted view
 * still holds an open port.
 */
export function createPortLedger() {
  const open = new Set<number>();
  const evicted: number[] = [];
  const cached: number[] = [];
  return {
    openFor(wcId: number): void {
      open.add(wcId);
    },
    onViewEvicted(wcId: number): void {
      evicted.push(wcId);
      open.delete(wcId);
    },
    onViewCached(wcId: number): void {
      cached.push(wcId);
      open.delete(wcId);
    },
    get openIds(): number[] {
      return [...open];
    },
    evicted,
    cached,
    assertNoPortsForDeadViews(manager: ManagerLike): void {
      const liveIds = new Set(manager.getAllWebContentsIds());
      for (const wcId of open) {
        expect(liveIds.has(wcId), `port left open for a dead view (wc ${wcId})`).toBe(true);
      }
    },
  };
}
