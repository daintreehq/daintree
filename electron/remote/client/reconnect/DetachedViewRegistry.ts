import type { HostConnectionState, HostId } from "../../../../shared/types/remoteHosts.js";

export interface DetachedViewRegistryOptions {
  /** Whether the view still belongs to this host by its authoritative binding. */
  isBoundTo(webContentsId: number, hostId: HostId): boolean;
  /** Settles true once calls can reach the host, false if it never got there. */
  whenReady(hostId: HostId): Promise<boolean>;
  /** Tell the views still on this host to refetch what they show. */
  resync(hostId: HostId, webContentsIds: readonly number[]): void;
}

/**
 * The views an explicit disconnect cut off from their host.
 *
 * Disconnecting discards the connection with its endpoints, so the next
 * connection starts with no record of any view: it has nothing to reopen and
 * its first session is not a reconnect, so {@link ResyncCoordinator} never
 * hears of them. This keeps them past the discard and, once a replacement
 * connection can take calls, tells the ones still bound there to resync. Their
 * first call through the new connection reopens their endpoints and streams.
 */
export class DetachedViewRegistry {
  private readonly detached = new Map<HostId, Set<number>>();

  constructor(private readonly options: DetachedViewRegistryOptions) {}

  remember(hostId: HostId, webContentsIds: Iterable<number>): void {
    const views = this.detached.get(hostId) ?? new Set<number>();
    for (const id of webContentsIds) views.add(id);
    if (views.size > 0) this.detached.set(hostId, views);
  }

  /** The host was forgotten: its views moved to this machine and have nothing to resync. */
  forget(hostId: HostId): void {
    this.detached.delete(hostId);
  }

  has(hostId: HostId): boolean {
    return this.detached.has(hostId);
  }

  onConnectionState(hostId: HostId, state: HostConnectionState): void {
    if (state.status !== "connected") return;
    const views = this.detached.get(hostId);
    if (!views) return;
    this.detached.delete(hostId);
    void this.options.whenReady(hostId).then(
      (ready) => this.settle(hostId, views, ready),
      () => this.settle(hostId, views, false)
    );
  }

  private settle(hostId: HostId, views: Set<number>, ready: boolean): void {
    const bound = [...views].filter((id) => this.options.isBoundTo(id, hostId));
    if (bound.length === 0) return;
    if (!ready) {
      // Try again on the next connection rather than lose them.
      this.remember(hostId, bound);
      return;
    }
    try {
      this.options.resync(hostId, bound);
    } catch (error) {
      console.error("[RemoteHosts] Resync after an explicit reconnect failed:", error);
    }
  }
}
