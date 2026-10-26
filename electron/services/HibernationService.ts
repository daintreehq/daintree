import { logInfo, logError } from "../utils/logger.js";
import type { ProjectViewManager } from "../window/ProjectViewManager.js";

/**
 * HibernationService - Evicts a sleeping project's cached renderer. The
 * PTY-kill paths are gone: nothing hibernates on a timer (#13840) or under
 * memory pressure (#14534); Sleep (`./projectSleep.ts`) owns project teardown.
 */
export class HibernationService {
  private projectViewManagersProvider: (() => ProjectViewManager[]) | null = null;

  /**
   * Inject a lazy provider over every open window's ProjectViewManager so Sleep
   * can evict the project's cached `WebContentsView` renderer (#10668), the
   * bulk of per-project memory. Mirrors the `getAllProjectViewManagers` lambda
   * `ResourceProfileService` uses. Must stay lazy: windows open/close after
   * wiring. Never cleared on shutdown: it's a stateless closure over the window
   * registry, so it pins no stale object.
   */
  setProjectViewManagersProvider(provider: (() => ProjectViewManager[]) | null): void {
    this.projectViewManagersProvider = provider;
  }

  /**
   * Tear down a project's cached `WebContentsView` across every open window.
   * `destroyView` runs the full `cleanupEntry` teardown — detach,
   * listener removal, port cleanup, `webContents.close()` — and is a no-op when
   * the project has no cached view in that window. No-op if the provider has not
   * been wired yet.
   *
   * Skips any window where the project is on-screen: the active/foreground view,
   * or the still-visible anti-flash bridge of an open paint gate (during a cold
   * switch the outgoing project stays painted until the gate settles, even
   * though `activeProjectId` already points at the incoming project). Destroying
   * either would expose a blank/unpainted frame. Both guards are per-manager —
   * each window tracks its own active and outgoing project.
   *
   * Sleep (`./projectSleep.ts`) is the only caller. An automatic sleep passes
   * `protectMcpDispatch`, which leaves a view an MCP dispatch is waiting on in
   * place (#13845). Returns the number of windows whose cached view was torn
   * down.
   */
  evictProjectRenderer(projectId: string, options?: { protectMcpDispatch?: boolean }): number {
    const provider = this.projectViewManagersProvider;
    if (!provider) return 0;

    let managers: ProjectViewManager[];
    try {
      managers = provider();
    } catch (error) {
      // windowRegistry may be tearing down — eviction is best-effort.
      logError("user-initiated-hibernate-evict-provider-failed", error, { projectId });
      return 0;
    }

    let evictedViewCount = 0;
    for (const manager of managers) {
      try {
        if (
          manager.getActiveProjectId() === projectId ||
          manager.getOutgoingBridgeProjectId() === projectId
        ) {
          continue;
        }
        const destroyed = options
          ? manager.destroyView(projectId, options)
          : manager.destroyView(projectId);
        if (destroyed) {
          evictedViewCount++;
        }
      } catch (error) {
        // A disposing/closing ProjectViewManager can throw inside cleanupEntry.
        // Isolate per window so one failure doesn't skip the rest (#8607).
        logError("user-initiated-hibernate-evict-failed", error, { projectId });
      }
    }

    if (evictedViewCount > 0) {
      logInfo("user-initiated-hibernate-renderer-evicted", { projectId, evictedViewCount });
    }

    return evictedViewCount;
  }
}

let hibernationService: HibernationService | null = null;

export function getHibernationService(): HibernationService {
  if (!hibernationService) {
    hibernationService = new HibernationService();
  }
  return hibernationService;
}
