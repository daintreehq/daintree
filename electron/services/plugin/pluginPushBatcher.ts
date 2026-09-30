import {
  PLUGIN_PUSH_MAX_BATCH_SIZE,
  PLUGIN_PUSH_MAX_PAYLOAD_BYTES,
} from "../../../shared/config/pluginBudgets.js";
import { getProjectRendererTargets } from "../../ipc/utils.js";
import { PLUGIN_PUSH_BATCH_CHANNEL, type PluginPushBatchEntry } from "./pluginPushProtocol.js";
import { getPluginPushListenerRegistry } from "./pluginPushListenerRegistry.js";

/** The slice of `Electron.WebContents` the batcher sends through. */
export interface PluginPushTarget {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

/**
 * Called once per plugin per flush with what was actually handed to IPC:
 * `messages` counts deliveries (one push reaching two renderers counts two)
 * and `bytes` sums their estimated payload sizes. Pushes that reached no
 * renderer (destroyed, out of scope, aimed at a closed panel, or with no
 * subscriber there) are not counted.
 */
export type PluginPushFlushObserver = (pluginId: string, messages: number, bytes: number) => void;

/**
 * Where a targeted push's panel lives, as the lifecycle broker knows it:
 * the renderers (webContents ids) holding it, or `"closed"` once the panel was
 * reported removed and nothing holds it any more. An empty list means "not
 * reported yet", which a push racing the lifecycle batch can see.
 */
export type PluginPushPanelLocation = readonly number[] | "closed";

export interface PluginPushRoute {
  pluginId: string;
  /** The binding's project, or `null` for an app-global plugin. */
  projectId: string | null;
  /** The full `plugin:{pluginId}:{channel}` transport channel. */
  channel: string;
  /** `null` for a broadcast; otherwise the single panel the push targets. */
  panelId: string | null;
  /**
   * Delivered as is, later, on the next flush — so it must be a value nothing
   * mutates after this call. Plugin-supplied payloads are snapshotted by the
   * host before they get here.
   */
  payload: unknown;
  /** Estimated payload size, for metering and batch splitting. */
  bytes: number;
  /** Consulted at flush time, so a panel that moved renderer is followed. */
  locatePanel?: (panelId: string, pluginId: string) => PluginPushPanelLocation;
}

/** The renderers a scope covers: the project's views, or every renderer for `null`. */
export type PluginPushScopeResolver = (projectId: string | null) => readonly PluginPushTarget[];

/**
 * Whether renderer `targetId` has a subscriber a push on `channel` (targeted at
 * `panelId`, or `null` for a broadcast) would be dispatched to. Must answer
 * true for a renderer it knows nothing about.
 */
export type PluginPushListenerFilter = (
  targetId: number,
  channel: string,
  panelId: string | null
) => boolean;

interface QueuedPush {
  route: PluginPushRoute;
  entry: PluginPushBatchEntry;
}

export interface PluginPushBatcherOptions {
  schedule?: (flush: () => void) => void;
  maxBatchSize?: number;
  maxBatchBytes?: number;
  resolveScope?: PluginPushScopeResolver;
  hasListener?: PluginPushListenerFilter;
}

/**
 * Coalesces plugin pushes into one IPC message per renderer per macrotask.
 *
 * Pushes are queued with their routing inputs, not their recipients: which
 * renderers receive a push is decided at flush time, against the renderers and
 * panel locations that exist then, so a panel that moved or a renderer that
 * was replaced between the push and the flush is followed rather than missed.
 *
 * Ordering is FIFO per renderer, across every plugin and channel on the
 * transport, so the relative order a renderer observes is exactly the order
 * the pushes were made. Nothing is merged; a flush over the entry or byte cap
 * goes out as several consecutive messages. A push is dropped only when it has
 * nowhere to go (no live renderer in scope, its panel is closed, or no renderer
 * in scope reported a subscriber for it) or, alone among its batch, when IPC
 * refuses to serialize it.
 */
export class PluginPushBatcher {
  private queue: QueuedPush[] = [];
  private scheduled = false;
  private observer: PluginPushFlushObserver | null = null;
  private readonly schedule: (flush: () => void) => void;
  private readonly maxBatchSize: number;
  private readonly maxBatchBytes: number;
  private readonly resolveScope: PluginPushScopeResolver;
  private readonly hasListener: PluginPushListenerFilter;

  constructor(options: PluginPushBatcherOptions = {}) {
    this.schedule = options.schedule ?? ((flush) => void setImmediate(flush));
    this.maxBatchSize = Math.max(1, options.maxBatchSize ?? PLUGIN_PUSH_MAX_BATCH_SIZE);
    this.maxBatchBytes = options.maxBatchBytes ?? PLUGIN_PUSH_MAX_PAYLOAD_BYTES;
    this.resolveScope =
      options.resolveScope ?? ((projectId) => getProjectRendererTargets(projectId));
    this.hasListener =
      options.hasListener ??
      ((targetId, channel, panelId) =>
        getPluginPushListenerRegistry().shouldDeliver(targetId, channel, panelId));
  }

  /** Install (or with `null`, remove) the per-flush metering hook. */
  setFlushObserver(observer: PluginPushFlushObserver | null): void {
    this.observer = observer;
  }

  enqueue(route: PluginPushRoute): void {
    this.queue.push({
      route,
      entry: [route.channel, { panelId: route.panelId, payload: route.payload }],
    });
    if (!this.scheduled) {
      this.scheduled = true;
      this.schedule(() => this.flush());
    }
  }

  /** Deliver everything queued now. Safe to call at any time. */
  flush(): void {
    this.scheduled = false;
    if (this.queue.length === 0) return;
    const queue = this.queue;
    this.queue = [];

    const scopes = new Map<string | null, readonly PluginPushTarget[]>();
    const destinations = new Map<PluginPushTarget, QueuedPush[]>();
    for (const push of queue) {
      for (const target of this.targetsFor(push.route, scopes)) {
        const pushes = destinations.get(target);
        if (pushes) pushes.push(push);
        else destinations.set(target, [push]);
      }
    }

    const totals = new Map<string, { messages: number; bytes: number }>();
    const count = (push: QueuedPush): void => {
      const total = totals.get(push.route.pluginId);
      if (total) {
        total.messages += 1;
        total.bytes += push.route.bytes;
      } else {
        totals.set(push.route.pluginId, { messages: 1, bytes: push.route.bytes });
      }
    };
    for (const [target, pushes] of destinations) {
      this.deliver(target, pushes, count);
    }

    const observer = this.observer;
    if (!observer) return;
    for (const [pluginId, { messages, bytes }] of totals) {
      try {
        observer(pluginId, messages, bytes);
      } catch {
        // Metering must never affect delivery.
      }
    }
  }

  /**
   * The live renderers one push goes to. Scope is the binding's project views
   * (every renderer for an unbound plugin). A targeted push narrows that to the
   * renderer(s) holding the panel, so the others never deserialize it; the
   * preload still filters by panel id as a second line of defence. A panel not
   * reported yet falls back to the scope — never wider — and a closed one
   * receives nothing. Last, renderers that reported no subscriber the push
   * could reach are dropped; one that never reported keeps receiving.
   */
  private targetsFor(
    route: PluginPushRoute,
    scopes: Map<string | null, readonly PluginPushTarget[]>
  ): readonly PluginPushTarget[] {
    let scope = scopes.get(route.projectId);
    if (!scope) {
      let resolved: readonly PluginPushTarget[] = [];
      try {
        resolved = this.resolveScope(route.projectId).filter((target) => !isGone(target));
      } catch {
        // No renderers can be named right now; the push has nowhere to go.
      }
      scope = resolved;
      scopes.set(route.projectId, scope);
    }
    return this.listening(route, this.panelTargets(route, scope));
  }

  private panelTargets(
    route: PluginPushRoute,
    scope: readonly PluginPushTarget[]
  ): readonly PluginPushTarget[] {
    if (route.panelId === null || !route.locatePanel || scope.length === 0) return scope;
    let location: PluginPushPanelLocation;
    try {
      location = route.locatePanel(route.panelId, route.pluginId);
    } catch {
      return scope;
    }
    if (location === "closed") return [];
    if (location.length === 0 || scope.length === 1) return scope;
    const narrowed = scope.filter((target) => location.includes(target.id));
    return narrowed.length > 0 ? narrowed : scope;
  }

  private listening(
    route: PluginPushRoute,
    targets: readonly PluginPushTarget[]
  ): readonly PluginPushTarget[] {
    if (targets.length === 0) return targets;
    return targets.filter((target) => {
      try {
        return this.hasListener(target.id, route.channel, route.panelId);
      } catch {
        return true;
      }
    });
  }

  /**
   * Send one renderer its pushes in order. A renderer torn down mid-flush ends
   * its own delivery and nothing else. Any other send failure is the payload's
   * (IPC could not serialize something structured clone accepted), so the
   * batch is retried entry by entry and only the entries that still fail are
   * dropped.
   */
  private deliver(
    target: PluginPushTarget,
    pushes: readonly QueuedPush[],
    count: (push: QueuedPush) => void
  ): void {
    for (const chunk of this.chunk(pushes)) {
      if (this.trySend(target, chunk)) {
        chunk.forEach(count);
        continue;
      }
      if (isGone(target)) return;
      for (const push of chunk) {
        if (this.trySend(target, [push])) {
          count(push);
        } else if (isGone(target)) {
          return;
        } else {
          console.warn(
            `[PluginPush] dropped a push on "${push.route.channel}" from "${push.route.pluginId}": IPC could not serialize it`
          );
        }
      }
    }
  }

  private trySend(target: PluginPushTarget, pushes: readonly QueuedPush[]): boolean {
    try {
      target.send(
        PLUGIN_PUSH_BATCH_CHANNEL,
        pushes.map((push) => push.entry)
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Split a queue into consecutive messages of at most `maxBatchSize` entries
   * and at most `maxBatchBytes`, so batching never builds a message larger than
   * the biggest single push could have been on its own.
   */
  private *chunk(queue: readonly QueuedPush[]): Generator<QueuedPush[]> {
    let current: QueuedPush[] = [];
    let bytes = 0;
    for (const push of queue) {
      if (
        current.length > 0 &&
        (current.length >= this.maxBatchSize || bytes + push.route.bytes > this.maxBatchBytes)
      ) {
        yield current;
        current = [];
        bytes = 0;
      }
      current.push(push);
      bytes += push.route.bytes;
    }
    if (current.length > 0) yield current;
  }

  /** Test seam: pushes waiting for the next flush. */
  pendingCount(): number {
    return this.queue.length;
  }
}

function isGone(target: PluginPushTarget): boolean {
  try {
    return target.isDestroyed();
  } catch {
    return true;
  }
}

let sharedBatcher: PluginPushBatcher | null = null;

/** The process-wide batcher every plugin push goes through. */
export function getPluginPushBatcher(): PluginPushBatcher {
  sharedBatcher ??= new PluginPushBatcher();
  return sharedBatcher;
}

/** Test seam: drop the shared batcher so a test starts from a clean queue. */
export function resetPluginPushBatcherForTests(): void {
  sharedBatcher = null;
}

/** Deliver everything already pushed, before a send that must follow it. */
export function flushPluginPushes(): void {
  sharedBatcher?.flush();
}

/** Queue one plugin push; its recipients are resolved when the queue flushes. */
export function routePluginPush(route: PluginPushRoute): void {
  getPluginPushBatcher().enqueue(route);
}

/**
 * Wrap a renderer-delivery collaborator so every method call first delivers
 * the plugin pushes already queued. Anything the host sends a renderer
 * directly — dispatches, prompts, reloads, badges, toasts — must never
 * overtake a panel update the plugin made before it.
 */
export function withPushFlushBarrier<T extends object>(collaborator: T): T {
  // Partial test deps leave collaborators a host never touches unset.
  if (collaborator === null || typeof collaborator !== "object") return collaborator;
  return new Proxy(collaborator, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]): unknown => {
        flushPluginPushes();
        return Reflect.apply(value, target, args);
      };
    },
  });
}
