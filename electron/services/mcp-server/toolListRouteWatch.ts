/**
 * Tells a workspace-bound session when its tool list moved (#13350).
 *
 * A bound session's `tools/list` is answered from wherever its workspace can be
 * reached: a Shell view driving it from another machine, whose manifest holds
 * only what a host may run there; a view on this machine; or, with neither, the
 * host's base surface. Those are different lists, and nothing told the client
 * when the route moved between them, so it found out at its next restart, as
 * tools that had quietly gone.
 *
 * Each listing records the route it was answered from. A routing event re-reads
 * every recorded route, and a session whose route moved is sent one
 * `notifications/tools/list_changed` and forgotten until it lists again, so a
 * client that never re-lists is told once rather than on every flap. Routes are
 * compared rather than manifests: re-reading one costs nothing and wakes no
 * view, and a move that leaves the list as it was costs one harmless re-list.
 */
export class ToolListRouteWatch {
  private readonly listed = new Map<string, { route: string; describe: () => string }>();
  private checkQueued = false;

  constructor(private readonly notify: (sessionId: string) => void) {}

  /** Record the route a listing is answered from, read before it is fetched. */
  noteListed(sessionId: string, describe: () => string): void {
    this.listed.set(sessionId, { route: describe(), describe });
  }

  forget(sessionId: string): void {
    this.listed.delete(sessionId);
  }

  clear(): void {
    this.listed.clear();
  }

  /** A route may have moved. Coalesced to one pass per microtask. */
  check(): void {
    if (this.checkQueued || this.listed.size === 0) return;
    this.checkQueued = true;
    queueMicrotask(() => {
      this.checkQueued = false;
      for (const [sessionId, entry] of [...this.listed]) {
        let route: string;
        try {
          route = entry.describe();
        } catch (err) {
          console.warn(`[MCP] Could not read session ${sessionId}'s route:`, err);
          continue;
        }
        if (route === entry.route) continue;
        this.listed.delete(sessionId);
        this.notify(sessionId);
      }
    });
  }
}
