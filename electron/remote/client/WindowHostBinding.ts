import { LOCAL_HOST_ID, isLocalHostId, type HostId } from "../../../shared/types/remoteHosts.js";

/**
 * Which host each window is attached to. A window is bound to exactly one
 * host; windows never recorded here are local, so nothing is stored for the
 * single-machine case.
 */
export class WindowHostBinding {
  private readonly byWindow = new Map<number, HostId>();
  private readonly listeners = new Set<(windowId: number, hostId: HostId) => void>();

  get(windowId: number): HostId {
    return this.byWindow.get(windowId) ?? LOCAL_HOST_ID;
  }

  set(windowId: number, hostId: HostId): void {
    const previous = this.get(windowId);
    if (isLocalHostId(hostId)) this.byWindow.delete(windowId);
    else this.byWindow.set(windowId, hostId);
    if (previous !== this.get(windowId)) this.emit(windowId, this.get(windowId));
  }

  /** The window closed. */
  release(windowId: number): void {
    if (this.byWindow.delete(windowId)) this.emit(windowId, LOCAL_HOST_ID);
  }

  windowsOn(hostId: HostId): number[] {
    const ids: number[] = [];
    for (const [windowId, bound] of this.byWindow) if (bound === hostId) ids.push(windowId);
    return ids;
  }

  onChange(listener: (windowId: number, hostId: HostId) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(windowId: number, hostId: HostId): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(windowId, hostId);
      } catch (error) {
        console.error("[WindowHostBinding] listener failed:", error);
      }
    }
  }
}
