import { create } from "zustand";
import {
  PLUGIN_MCP_CONSENT_TIMEOUT_MS,
  type PluginMcpConsentDecision,
  type PluginMcpConsentRequestEvent,
} from "@shared/types/pluginMcpConsent";

/**
 * One pending consent prompt surfaced for a plugin-MCP tool call. Stored in a
 * FIFO queue; only the first item drives the visible modal so concurrent
 * plugin tool calls never stack overlapping dialogs.
 *
 * The display fields come straight off the main-pushed
 * {@link PluginMcpConsentRequestEvent}: `descriptionDisplay` is ANSI/OSC
 * stripped in main (render as a plain text node — no HTML/Markdown) and
 * `argsSummary` is pre-redacted (raw args never cross the IPC boundary). Only
 * `enqueuedAt` is renderer-local.
 */
export interface PendingPluginMcpConsent extends PluginMcpConsentRequestEvent {
  enqueuedAt: number;
}

interface PluginMcpConfirmState {
  queue: PendingPluginMcpConsent[];
  current: PendingPluginMcpConsent | null;
}

interface PluginMcpConfirmActions {
  enqueue: (item: PendingPluginMcpConsent) => void;
  resolveCurrent: (decision: PluginMcpConsentDecision) => void;
  drop: (requestId: string) => void;
  reset: () => void;
}

interface PendingResolver {
  resolve: (decision: PluginMcpConsentDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

const resolvers = new Map<string, PendingResolver>();

function advance(
  set: (partial: Partial<PluginMcpConfirmState>) => void,
  queue: PendingPluginMcpConsent[]
) {
  if (queue.length === 0) {
    set({ current: null, queue: [] });
    return;
  }
  const [next, ...rest] = queue;
  set({ current: next, queue: rest });
}

export const usePluginMcpConfirmStore = create<PluginMcpConfirmState & PluginMcpConfirmActions>(
  (set, get) => ({
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
  })
);

/**
 * Push a consent prompt into the queue and return a Promise that resolves
 * with the user's decision. The returned Promise never rejects — callers
 * branch on the discriminated decision value.
 */
export function requestPluginMcpConsent(
  item: Omit<PendingPluginMcpConsent, "enqueuedAt">
): Promise<PluginMcpConsentDecision> {
  return new Promise((resolve) => {
    if (resolvers.has(item.requestId)) {
      console.warn(`[PluginMcpConfirmStore] duplicate requestId rejected: ${item.requestId}`);
      resolve("rejected");
      return;
    }
    const { requestId } = item;
    // Safety net: an abandoned dialog settles itself as "timeout" so the gating
    // promise never hangs and the stale prompt is evicted from the store. The
    // resolver is pre-deleted before delegating state cleanup to drop(), which
    // then finds no resolver and only advances the queue (#10841).
    const timer = setTimeout(() => {
      const entry = resolvers.get(requestId);
      if (!entry) return;
      resolvers.delete(requestId);
      entry.resolve("timeout");
      usePluginMcpConfirmStore.getState().drop(requestId);
    }, PLUGIN_MCP_CONSENT_TIMEOUT_MS);
    resolvers.set(requestId, { resolve, timer });
    usePluginMcpConfirmStore.getState().enqueue({ ...item, enqueuedAt: Date.now() });
  });
}

/** Test-only escape hatch — resets store and clears the resolver map. */
export function __resetPluginMcpConfirmStoreForTesting(): void {
  usePluginMcpConfirmStore.getState().reset();
}
