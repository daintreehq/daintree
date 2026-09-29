import {
  PLUGIN_PUSH_MAX_BATCH_SIZE,
  PLUGIN_PUSH_MAX_PAYLOAD_BYTES,
} from "../../../shared/config/pluginBudgets.js";
import { getProjectRendererTargets } from "../../ipc/utils.js";
import { PLUGIN_PUSH_BATCH_CHANNEL, type PluginPushBatchEntry } from "./pluginPushProtocol.js";

/** The slice of `Electron.WebContents` the batcher sends through. */
export interface PluginPushTarget {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

/**
 * Called once per plugin per flush with what was actually handed to IPC:
 * `messages` counts deliveries (one push reaching two renderers counts two)
 * and `bytes` sums their estimated payload sizes. Pushes dropped because their
 * renderer was destroyed before the flush are not counted.
 */
export type PluginPushFlushObserver = (pluginId: string, messages: number, bytes: number) => void;

interface QueuedPush {
  pluginId: string;
  entry: PluginPushBatchEntry;
  bytes: number;
}

interface Destination {
  target: PluginPushTarget;
  queue: QueuedPush[];
}

export interface PluginPushBatcherOptions {
  schedule?: (flush: () => void) => void;
  maxBatchSize?: number;
  maxBatchBytes?: number;
}

/**
 * Coalesces plugin pushes into one IPC message per renderer per macrotask.
 *
 * Ordering is FIFO per renderer, across every plugin and channel on the
 * transport, so the relative order a renderer observes is exactly the order
 * the pushes were made. Nothing is merged or dropped except for a renderer
 * that no longer exists; a flush over the entry or byte cap goes out as
 * several consecutive messages.
 */
export class PluginPushBatcher {
  private readonly destinations = new Map<number, Destination>();
  private scheduled = false;
  private observer: PluginPushFlushObserver | null = null;
  private readonly schedule: (flush: () => void) => void;
  private readonly maxBatchSize: number;
  private readonly maxBatchBytes: number;

  constructor(options: PluginPushBatcherOptions = {}) {
    this.schedule = options.schedule ?? ((flush) => void setImmediate(flush));
    this.maxBatchSize = Math.max(1, options.maxBatchSize ?? PLUGIN_PUSH_MAX_BATCH_SIZE);
    this.maxBatchBytes = options.maxBatchBytes ?? PLUGIN_PUSH_MAX_PAYLOAD_BYTES;
  }

  /** Install (or with `null`, remove) the per-flush metering hook. */
  setFlushObserver(observer: PluginPushFlushObserver | null): void {
    this.observer = observer;
  }

  enqueue(
    target: PluginPushTarget,
    pluginId: string,
    channel: string,
    envelope: unknown,
    bytes: number
  ): void {
    let destination = this.destinations.get(target.id);
    // A recycled id means the old renderer is gone; its queue goes with it.
    if (destination && destination.target !== target && destination.target.isDestroyed()) {
      destination = undefined;
    }
    if (!destination) {
      destination = { target, queue: [] };
      this.destinations.set(target.id, destination);
    }
    destination.queue.push({ pluginId, entry: [channel, envelope], bytes });
    if (!this.scheduled) {
      this.scheduled = true;
      this.schedule(() => this.flush());
    }
  }

  /** Deliver everything queued now. Safe to call at any time. */
  flush(): void {
    this.scheduled = false;
    if (this.destinations.size === 0) return;
    const destinations = [...this.destinations.values()];
    this.destinations.clear();
    const totals = new Map<string, { messages: number; bytes: number }>();
    for (const { target, queue } of destinations) {
      if (isGone(target)) continue;
      for (const chunk of this.chunk(queue)) {
        try {
          target.send(
            PLUGIN_PUSH_BATCH_CHANNEL,
            chunk.map((push) => push.entry)
          );
        } catch {
          // A renderer torn down mid-flush; the rest of its queue has nowhere to go.
          break;
        }
        for (const push of chunk) {
          const total = totals.get(push.pluginId);
          if (total) {
            total.messages += 1;
            total.bytes += push.bytes;
          } else {
            totals.set(push.pluginId, { messages: 1, bytes: push.bytes });
          }
        }
      }
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
        (current.length >= this.maxBatchSize || bytes + push.bytes > this.maxBatchBytes)
      ) {
        yield current;
        current = [];
        bytes = 0;
      }
      current.push(push);
      bytes += push.bytes;
    }
    if (current.length > 0) yield current;
  }

  /** Test seam: renderers with pushes waiting for the next flush. */
  pendingDestinationCount(): number {
    return this.destinations.size;
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

export interface PluginPushRoute {
  pluginId: string;
  /** The binding's project, or `null` for an app-global plugin. */
  projectId: string | null;
  /** The full `plugin:{pluginId}:{channel}` transport channel. */
  channel: string;
  /** `null` for a broadcast; otherwise the single panel the push targets. */
  panelId: string | null;
  payload: unknown;
  /** Estimated payload size, for metering only. */
  bytes: number;
  /**
   * Renderers (webContents ids) known to hold `panelId` for this plugin. An
   * empty answer — the panel has not been reported yet, which a push racing
   * the lifecycle batch can see — falls back to the full scope below.
   */
  locatePanel?: (panelId: string, pluginId: string) => readonly number[];
}

/**
 * Queue one plugin push for every renderer that should receive it.
 *
 * Scope is the binding's project views (every renderer for an unbound plugin).
 * A targeted push narrows that to the renderer(s) holding the panel, so the
 * other renderers never deserialize it; the preload still filters by panel id
 * as a second line of defence.
 */
export function routePluginPush(route: PluginPushRoute): void {
  let targets: readonly PluginPushTarget[] = getProjectRendererTargets(route.projectId);
  if (route.panelId !== null && route.locatePanel && targets.length > 1) {
    const holders = route.locatePanel(route.panelId, route.pluginId);
    if (holders.length > 0) {
      const narrowed = targets.filter((target) => holders.includes(target.id));
      if (narrowed.length > 0) targets = narrowed;
    }
  }
  if (targets.length === 0) return;
  const envelope = { panelId: route.panelId, payload: route.payload };
  const batcher = getPluginPushBatcher();
  for (const target of targets) {
    batcher.enqueue(target, route.pluginId, route.channel, envelope, route.bytes);
  }
}
