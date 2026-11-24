import type { WorktreePortRetiredNotice } from "../../shared/types/worktree-port.js";
import { fanoutEventToPorts, type FanoutLogger, type FanoutPort } from "./worktreePortFanout.js";

const RETIRED_NOTICE: WorktreePortRetiredNotice = { type: "port-retired" };

/**
 * The workspace host's live worktree ports. Main's broker names each one when
 * it attaches it, because transferring the port here neutered Main's own
 * handle: closing that handle reaches nothing, so Main retires a port by name
 * instead, and only the host can actually close it (#17037).
 */
export class WorktreePortRegistry<TPort extends FanoutPort> {
  /** In attach order; only the registry and its fan-out change it. */
  readonly ports: TPort[] = [];
  private readonly byId = new Map<number, TPort>();

  add(port: TPort, portId: number): void {
    // The broker never reuses a token, but a name must keep meaning one port.
    const previous = this.byId.get(portId);
    if (previous && previous !== port) this.detach(portId);
    this.ports.push(port);
    this.byId.set(portId, port);
  }

  /** Drop a port that closed from either side. */
  forget(port: TPort): void {
    const idx = this.ports.indexOf(port);
    if (idx >= 0) this.ports.splice(idx, 1);
    for (const [id, candidate] of this.byId) {
      if (candidate === port) {
        this.byId.delete(id);
        break;
      }
    }
  }

  /**
   * Stop posting into the port Main retired and close it, telling the view
   * first so it does not read the close as this host going away. False for an
   * id this host never held or already let go: a port to the host's previous
   * process, or one that closed on its own first.
   */
  detach(portId: number): boolean {
    const port = this.byId.get(portId);
    if (!port) return false;
    // Forget before closing: `close()` fires the port's own close listener,
    // which then finds nothing left to remove.
    this.forget(port);
    try {
      port.postMessage(RETIRED_NOTICE);
    } catch {
      // A port that can't take the notice is closing anyway.
    }
    try {
      port.close();
    } catch {
      // Already closed; it is out of the fan-out either way.
    }
    return true;
  }

  /** Post `event` to every port, forgetting any the post fails on. */
  fanout(event: unknown, logger?: FanoutLogger): void {
    fanoutEventToPorts(this.ports, event, logger, (port) => this.forget(port));
  }
}
