/**
 * A fixture-driven stand-in for the two bridges a plugin view talks to:
 * `window.electron.plugin` (`invoke`, `on`, `onPanel`) and the view-lifecycle
 * half of `window.electron.app`. Every SDK view hook reaches the host through
 * those two (`react/hostBridge.ts`), so installing this is enough to run a real
 * panel view outside Daintree — in a plain browser page or in vitest/jsdom.
 *
 * Browser-safe by construction: no Node import anywhere on this path.
 */

/** What a channel answers with, or a function computing it from the call's args. */
export type ChannelFixture = unknown | ((...args: unknown[]) => unknown);

const PENDING = Symbol.for("daintree.preview.pending");

interface PendingMarker {
  readonly [PENDING]: true;
}

function isPendingMarker(value: unknown): value is PendingMarker {
  return typeof value === "object" && value !== null && PENDING in value;
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * The failure shapes the real host produces, in the form they arrive over the
 * bridge — so the SDK's own hooks turn them into what a view sees in Daintree
 * (`HostDisconnectedError`, `OutcomeUnknownError`, a prefixed `Error`).
 *
 * Use one as a fixture value, or throw one from a fixture function.
 */
export const hostResponses = {
  /** The call's arguments failed the channel's schema. */
  schemaError(detail = "invalid arguments"): Error {
    return new Error(`SCHEMA_ERROR: ${detail}`);
  },
  /** The plugin lacks a capability the call needs. */
  permissionRequired(detail = "a required capability is not declared"): Error {
    return new Error(`PERMISSION_REQUIRED: ${detail}`);
  },
  /** The view's host is not connected; the call never reached it. */
  disconnected(message = "The host this view runs on is not connected"): Error {
    return coded("HOST_DISCONNECTED", message);
  },
  /** The link dropped mid-call; the host may or may not have run it. */
  outcomeUnknown(
    message = "The link to the host dropped before the call finished; it may or may not have run"
  ): Error {
    return coded("OUTCOME_UNKNOWN", message);
  },
  /** Never settles — the view's loading state, held for as long as the preview lives. */
  pending(): PendingMarker {
    return { [PENDING]: true };
  },
} as const;

/** One call the view made into the bridge, in order. */
export type MockViewHostCall =
  | { kind: "invoke"; pluginId: string; channel: string; args: unknown[] }
  | { kind: "on"; pluginId: string; channel: string }
  | { kind: "onPanel"; pluginId: string; channel: string; panelId: string };

export interface MockViewHostOptions {
  /**
   * The plugin this host serves. Set, a call or subscription from any other
   * plugin id is refused, as it would address nothing in Daintree.
   */
  pluginId?: string;
  /** Answers per channel. A channel with no fixture rejects, as an unhandled one does in Daintree. */
  channels?: Record<string, ChannelFixture>;
  /** Start as a cached (hidden, background) project view. */
  viewCached?: boolean;
}

/** The bridge objects, in the shape `react/hostBridge.ts` reads them. */
export interface MockViewHostBridges {
  plugin: {
    invoke(pluginId: string, channel: string, ...args: unknown[]): Promise<unknown>;
    on(pluginId: string, channel: string, callback: (payload: unknown) => void): () => void;
    onPanel(
      pluginId: string,
      channel: string,
      panelId: string,
      callback: (payload: unknown) => void
    ): () => void;
  };
  app: {
    isViewCached(): boolean;
    onViewCached(callback: () => void): () => void;
    onViewWarmActivated(callback: () => void): () => void;
  };
}

export interface MockViewHost {
  readonly bridges: MockViewHostBridges;
  /** Every call the view has made, oldest first. */
  readonly calls: readonly MockViewHostCall[];
  /** The argument lists of every `invoke` on `channel`. */
  invocations(channel: string): unknown[][];
  /** Replace (or, with `undefined`, remove) one channel's fixture. */
  setChannel(channel: string, fixture: ChannelFixture | undefined): void;
  /** Deliver a broadcast to every `on` subscriber of `channel`. Returns how many received it. */
  push(channel: string, payload: unknown): number;
  /** Deliver a per-panel event to `onPanel` subscribers of `channel` for `panelId`. */
  pushPanel(channel: string, panelId: string, payload: unknown): number;
  /** Live subscribers on `channel`, `on` and `onPanel` together. */
  subscriberCount(channel: string): number;
  /** Whether the project view currently reads as cached. */
  readonly viewCached: boolean;
  /**
   * Cache the view (fires the cached edge) or warm-activate it (fires the
   * warm-activated edge). A no-op when the state already matches.
   */
  setViewCached(cached: boolean): void;
  /**
   * Put the bridges on `globalThis.electron`, where the SDK looks for them.
   * Returns the restore function, which puts back whatever was there before.
   */
  install(target?: object): () => void;
}

interface Subscriber {
  pluginId: string;
  channel: string;
  panelId?: string;
  callback: (payload: unknown) => void;
}

function deliver(subscribers: Iterable<Subscriber>, payload: unknown): number {
  let delivered = 0;
  // Copied first: a subscriber that unsubscribes (or subscribes) while handling
  // the event must not change who receives this one.
  for (const subscriber of [...subscribers]) {
    delivered += 1;
    try {
      subscriber.callback(payload);
    } catch (error) {
      // One throwing subscriber must not starve the rest, as in the app. Still
      // surfaced, so a broken view does not fail silently.
      console.error("[plugin preview] an event subscriber threw", error);
    }
  }
  return delivered;
}

function listen(set: Set<() => void>, callback: () => void): () => void {
  const entry = () => callback();
  set.add(entry);
  return () => {
    set.delete(entry);
  };
}

export function createMockViewHost(options: MockViewHostOptions = {}): MockViewHost {
  const channels = new Map<string, ChannelFixture>(Object.entries(options.channels ?? {}));
  const calls: MockViewHostCall[] = [];
  const subscribers = new Set<Subscriber>();
  const cachedListeners = new Set<() => void>();
  const warmListeners = new Set<() => void>();
  let viewCached = options.viewCached === true;

  function subscribe(subscriber: Subscriber): () => void {
    subscribers.add(subscriber);
    // Idempotent by construction: React StrictMode runs effect cleanups twice
    // over a mount's life, and a Set delete is safe to repeat.
    return () => {
      subscribers.delete(subscriber);
    };
  }

  const servedPlugin = options.pluginId;
  const servesPlugin = (pluginId: string) =>
    servedPlugin === undefined || pluginId === servedPlugin;

  async function answer(pluginId: string, channel: string, args: unknown[]): Promise<unknown> {
    if (!servesPlugin(pluginId)) {
      throw new Error(`No plugin "${pluginId}" is running in this preview`);
    }
    if (!channels.has(channel)) {
      throw new Error(`No handler registered for channel "${channel}"`);
    }
    const fixture = channels.get(channel);
    const value = typeof fixture === "function" ? await fixture(...args) : fixture;
    if (isPendingMarker(value)) return new Promise<never>(() => {});
    if (value instanceof Error) throw value;
    // Cloned, as the real bridge's structured clone does: a view mutating what
    // it received must not reach back into the fixture.
    return value === undefined ? undefined : structuredClone(value);
  }

  const bridges: MockViewHostBridges = {
    plugin: {
      invoke(pluginId, channel, ...args) {
        calls.push({ kind: "invoke", pluginId, channel, args });
        return answer(pluginId, channel, args);
      },
      on(pluginId, channel, callback) {
        calls.push({ kind: "on", pluginId, channel });
        return subscribe({ pluginId, channel, callback });
      },
      onPanel(pluginId, channel, panelId, callback) {
        calls.push({ kind: "onPanel", pluginId, channel, panelId });
        return subscribe({ pluginId, channel, panelId, callback });
      },
    },
    app: {
      isViewCached: () => viewCached,
      onViewCached: (callback) => listen(cachedListeners, callback),
      onViewWarmActivated: (callback) => listen(warmListeners, callback),
    },
  };

  return {
    bridges,
    calls,
    invocations(channel) {
      return calls.flatMap((call) =>
        call.kind === "invoke" && call.channel === channel ? [call.args] : []
      );
    },
    setChannel(channel, fixture) {
      if (fixture === undefined) channels.delete(channel);
      else channels.set(channel, fixture);
    },
    push(channel, payload) {
      return deliver(
        [...subscribers].filter(
          (s) => servesPlugin(s.pluginId) && s.channel === channel && s.panelId === undefined
        ),
        payload
      );
    },
    pushPanel(channel, panelId, payload) {
      return deliver(
        [...subscribers].filter(
          (s) => servesPlugin(s.pluginId) && s.channel === channel && s.panelId === panelId
        ),
        payload
      );
    },
    subscriberCount(channel) {
      let count = 0;
      for (const subscriber of subscribers) if (subscriber.channel === channel) count += 1;
      return count;
    },
    get viewCached() {
      return viewCached;
    },
    setViewCached(cached) {
      if (cached === viewCached) return;
      viewCached = cached;
      for (const listener of [...(cached ? cachedListeners : warmListeners)]) listener();
    },
    install(target = globalThis) {
      const previous = Object.getOwnPropertyDescriptor(target, "electron");
      Object.defineProperty(target, "electron", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: { plugin: bridges.plugin, app: bridges.app },
      });
      let restored = false;
      return () => {
        if (restored) return;
        restored = true;
        if (previous) Object.defineProperty(target, "electron", previous);
        else delete (target as { electron?: unknown }).electron;
      };
    },
  };
}
