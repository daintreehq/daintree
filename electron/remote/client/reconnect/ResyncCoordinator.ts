import type { HostId, HostPreviousEnd } from "../../../../shared/types/remoteHosts.js";

/** A session came up on a host connection that had a session before it. */
export interface SessionAttachedInfo {
  /** The host kept this Shell's endpoints (and everything they carried) across the gap. */
  resumed: boolean;
  /**
   * Views whose endpoints this Shell reopened on a fresh session. The host had
   * dropped them, so nothing it pushed before the gap reached them and its
   * endpoint-side state starts over.
   */
  reopened: readonly number[];
  /**
   * The host's process restarted in the gap: the terminals the views showed
   * ended with it, rather than running on unseen as they do when a session
   * merely expired.
   */
  hostRestarted?: boolean;
  /** How the restarted host's previous process ended, when it recorded an unclean end. */
  previousEnd?: HostPreviousEnd;
}

export type ViewResyncReason = "reconnected" | "host-restarted";

export interface ResyncCoordinatorOptions {
  /** Tell one local view to refetch what it shows from its host. */
  resync(
    webContentsId: number,
    hostId: HostId,
    reason: ViewResyncReason,
    previousEnd?: HostPreviousEnd
  ): void;
}

/**
 * Decides which views must rehydrate after a reconnect, and tells each once.
 *
 * A resumed session needs nothing from here: the host kept its endpoints,
 * terminals replay from its rings, and it announces a `reattached` resync
 * itself for every endpoint that missed events while the link was down.
 * A fresh session is the case the host cannot announce — it has no record of
 * the old endpoints — so every view whose endpoint was reopened is told here,
 * after its streams have already been moved onto the new session.
 */
export class ResyncCoordinator {
  constructor(private readonly options: ResyncCoordinatorOptions) {}

  onSessionAttached(hostId: HostId, info: SessionAttachedInfo): void {
    if (info.resumed) return;
    const reason: ViewResyncReason = info.hostRestarted ? "host-restarted" : "reconnected";
    const previousEnd = info.hostRestarted ? info.previousEnd : undefined;
    for (const webContentsId of new Set(info.reopened)) {
      try {
        if (previousEnd) this.options.resync(webContentsId, hostId, reason, previousEnd);
        else this.options.resync(webContentsId, hostId, reason);
      } catch (error) {
        console.error("[RemoteHosts] Resync after reconnect failed:", error);
      }
    }
  }
}
