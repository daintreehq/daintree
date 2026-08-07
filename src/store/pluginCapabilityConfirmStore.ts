import { create } from "zustand";
import {
  PLUGIN_CAPABILITY_CONSENT_TIMEOUT_MS,
  type PluginCapabilityConsentDecision,
  type PluginCapabilityConsentRequestEvent,
} from "@shared/types/pluginCapabilityConsent";

/**
 * One pending just-in-time capability consent prompt (#10524). Stored in a FIFO
 * queue; only the first item drives the visible modal so concurrent first-use
 * prompts from different plugins never stack overlapping dialogs. Mirrors the
 * plugin-MCP confirm store but for host capabilities rather than MCP tools.
 */
export interface PendingPluginCapabilityConsent extends PluginCapabilityConsentRequestEvent {
  enqueuedAt: number;
}

interface PluginCapabilityConfirmState {
  queue: PendingPluginCapabilityConsent[];
  current: PendingPluginCapabilityConsent | null;
}

interface PluginCapabilityConfirmActions {
  enqueue: (item: PendingPluginCapabilityConsent) => void;
  resolveCurrent: (decision: PluginCapabilityConsentDecision) => void;
  drop: (requestId: string) => void;
  reset: () => void;
}

interface PendingResolver {
  resolve: (decision: PluginCapabilityConsentDecision) => void;
  /** Kept so a repeat request for the same id can share this outcome. */
  promise: Promise<PluginCapabilityConsentDecision>;
  timer: ReturnType<typeof setTimeout>;
}

const resolvers = new Map<string, PendingResolver>();

function advance(
  set: (partial: Partial<PluginCapabilityConfirmState>) => void,
  queue: PendingPluginCapabilityConsent[]
) {
  if (queue.length === 0) {
    set({ current: null, queue: [] });
    return;
  }
  const [next, ...rest] = queue;
  set({ current: next, queue: rest });
}

export const usePluginCapabilityConfirmStore = create<
  PluginCapabilityConfirmState & PluginCapabilityConfirmActions
>((set, get) => ({
  queue: [],
  current: null,

  enqueue: (item) => {
    const { current, queue } = get();
    if (current === null) {
      set({ current: item });
    } else {
      set({ queue: [...queue, item] });
    }
  },

  resolveCurrent: (decision) => {
    const { current, queue } = get();
    if (current === null) return;
    const entry = resolvers.get(current.requestId);
    resolvers.delete(current.requestId);
    if (entry) {
      clearTimeout(entry.timer);
      entry.resolve(decision);
    }
    advance(set, queue);
  },

  drop: (requestId) => {
    const { current, queue } = get();
    const entry = resolvers.get(requestId);
    if (entry) {
      resolvers.delete(requestId);
      clearTimeout(entry.timer);
      entry.resolve("rejected");
    }
    if (current?.requestId === requestId) {
      advance(set, queue);
      return;
    }
    const filtered = queue.filter((item) => item.requestId !== requestId);
    if (filtered.length !== queue.length) {
      set({ queue: filtered });
    }
  },

  reset: () => {
    for (const { timer } of resolvers.values()) clearTimeout(timer);
    resolvers.clear();
    set({ queue: [], current: null });
  },
}));

/**
 * Push a consent prompt into the queue and return a Promise that resolves with
 * the user's decision. The returned Promise never rejects — callers branch on
 * the discriminated decision value.
 *
 * A `requestId` already in flight returns that request's existing promise rather
 * than queueing a second dialog. Main deliberately re-pushes an unacknowledged
 * prompt (#11708), so a repeat is the *same* request arriving twice, not a
 * collision — ids are main-minted UUIDs. Treating a repeat as an error and
 * resolving it "rejected", as this did before, surfaced to the plugin as a user
 * denial that never happened, which is the very failure mode #11708 exists to
 * remove.
 */
export function requestPluginCapabilityConsent(
  item: Omit<PendingPluginCapabilityConsent, "enqueuedAt">
): Promise<PluginCapabilityConsentDecision> {
  const { requestId } = item;
  const existing = resolvers.get(requestId);
  if (existing) return existing.promise;

  let settle!: (decision: PluginCapabilityConsentDecision) => void;
  const promise = new Promise<PluginCapabilityConsentDecision>((resolve) => {
    settle = resolve;
  });
  // Safety net: an abandoned dialog settles itself as "timeout" so the gating
  // promise never hangs and the stale prompt is evicted from the store. The
  // resolver is pre-deleted before delegating state cleanup to drop(), which
  // then finds no resolver and only advances the queue (#10841).
  const timer = setTimeout(() => {
    const entry = resolvers.get(requestId);
    if (!entry) return;
    resolvers.delete(requestId);
    entry.resolve("timeout");
    usePluginCapabilityConfirmStore.getState().drop(requestId);
  }, PLUGIN_CAPABILITY_CONSENT_TIMEOUT_MS);
  resolvers.set(requestId, { resolve: settle, promise, timer });
  usePluginCapabilityConfirmStore.getState().enqueue({ ...item, enqueuedAt: Date.now() });
  return promise;
}

/** Test-only escape hatch — resets store and clears the resolver map. */
export function __resetPluginCapabilityConfirmStoreForTesting(): void {
  usePluginCapabilityConfirmStore.getState().reset();
}
