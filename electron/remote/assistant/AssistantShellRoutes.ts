import { assistantSlotKey } from "../../../shared/config/assistantSlots.js";
import type { HostId } from "../../../shared/types/remoteHosts.js";
import { EXCHANGE_TTL_MS } from "../exchange/AssistantExchangeStore.js";
import type { LaneRef } from "./AssistantMessagingPolicy.js";

/** Host lanes remembered at once; past it the oldest is forgotten, which only loses a preference. */
export const SHELL_ROUTES_MAX = 512;

interface Route {
  hostId: HostId;
  lane: LaneRef;
  at: number;
}

/**
 * Which of this Shell's assistant lanes last spoke to each host lane
 * (#13468): the one a message that lane starts on its own is handed to first,
 * since it is most likely answering something that assistant asked. A lane,
 * not a run: a run that replaces the asker reads its open address, so it
 * hears the answer too. In memory and best effort: a route lapses with the
 * exchange TTL, and losing one only sends the next message to the fallback
 * the receiver picks.
 */
export class AssistantShellRoutes {
  private readonly routes = new Map<string, Route>();
  private readonly now: () => number;

  constructor(deps: { now?: () => number } = {}) {
    this.now = deps.now ?? Date.now;
  }

  /** `asker` just sent to, or started, the assistant in `remote`'s slot on `hostId`. */
  remember(hostId: HostId, remote: LaneRef, asker: LaneRef): void {
    const key = routeKey(hostId, remote);
    this.routes.delete(key);
    this.prune();
    if (this.routes.size >= SHELL_ROUTES_MAX) {
      const oldest = this.routes.keys().next().value;
      if (oldest !== undefined) this.routes.delete(oldest);
    }
    this.routes.set(key, {
      hostId,
      lane: { projectId: asker.projectId, slot: asker.slot },
      at: this.now(),
    });
  }

  /** The lane here that last spoke to that host lane, while the route stands. */
  askerFor(hostId: HostId, remote: LaneRef): LaneRef | null {
    const route = this.routes.get(routeKey(hostId, remote));
    if (!route) return null;
    if (this.now() - route.at > EXCHANGE_TTL_MS) {
      this.routes.delete(routeKey(hostId, remote));
      return null;
    }
    return { ...route.lane };
  }

  /** Forgets every host but `known`: the hosts this Shell still has. */
  retainHosts(known: ReadonlySet<HostId>): void {
    for (const [key, route] of this.routes) {
      if (!known.has(route.hostId)) this.routes.delete(key);
    }
  }

  clear(): void {
    this.routes.clear();
  }

  private prune(): void {
    const now = this.now();
    for (const [key, route] of this.routes) {
      if (now - route.at > EXCHANGE_TTL_MS) this.routes.delete(key);
    }
  }
}

function routeKey(hostId: HostId, remote: LaneRef): string {
  return `${hostId}\0${assistantSlotKey(remote.projectId, remote.slot)}`;
}
