import { create } from "zustand";
import type {
  PluginCapabilityConsentDecision,
  PluginCapabilityConsentRequestEvent,
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

const resolvers = new Map<string, (decision: PluginCapabilityConsentDecision) => void>();

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
    const resolve = resolvers.get(current.requestId);
    resolvers.delete(current.requestId);
    resolve?.(decision);
    advance(set, queue);
  },

  drop: (requestId) => {
    const { current, queue } = get();
    const resolve = resolvers.get(requestId);
    resolvers.delete(requestId);
    resolve?.("rejected");
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
    resolvers.clear();
    set({ queue: [], current: null });
  },
}));

/**
 * Push a consent prompt into the queue and return a Promise that resolves with
 * the user's decision. The returned Promise never rejects — callers branch on
 * the discriminated decision value.
 */
export function requestPluginCapabilityConsent(
  item: Omit<PendingPluginCapabilityConsent, "enqueuedAt">
): Promise<PluginCapabilityConsentDecision> {
  return new Promise((resolve) => {
    if (resolvers.has(item.requestId)) {
      console.warn(
        `[PluginCapabilityConfirmStore] duplicate requestId rejected: ${item.requestId}`
      );
      resolve("rejected");
      return;
    }
    resolvers.set(item.requestId, resolve);
    usePluginCapabilityConfirmStore.getState().enqueue({ ...item, enqueuedAt: Date.now() });
  });
}

/** Test-only escape hatch — resets store and clears the resolver map. */
export function __resetPluginCapabilityConfirmStoreForTesting(): void {
  usePluginCapabilityConfirmStore.getState().reset();
}
