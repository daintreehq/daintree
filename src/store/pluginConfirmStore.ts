import { create } from "zustand";

/**
 * User decision on a plugin-action confirmation. Unlike the MCP confirm
 * flow there is no `"timeout"` — plugin dispatch has no main-process
 * deadline racing the dialog, so the modal stays open until the user
 * decides (or the bridge unmounts and drops it as `"rejected"`).
 */
export type PluginConfirmationDecision = "approved" | "rejected";

/**
 * One pending confirmation surfaced for a plugin action whose
 * host-computed `effectiveDanger` is `"confirm"`. Stored in a FIFO queue;
 * only the first item drives the visible modal so concurrent dispatches
 * never stack overlapping dialogs.
 */
export interface PendingPluginConfirm {
  requestId: string;
  pluginId: string;
  actionId: string;
  actionTitle: string;
  actionDescription: string;
  enqueuedAt: number;
}

interface PluginConfirmState {
  queue: PendingPluginConfirm[];
  current: PendingPluginConfirm | null;
}

interface PluginConfirmActions {
  enqueue: (item: PendingPluginConfirm) => void;
  resolveCurrent: (decision: PluginConfirmationDecision) => void;
  drop: (requestId: string) => void;
  reset: () => void;
}

/**
 * Module-level resolver map keyed by `requestId` UUID — never by
 * `actionId`, since two concurrent confirmations for the same action would
 * otherwise collide and the second would silently overwrite the first.
 * Lives outside React state because resolvers are functions and Zustand
 * state changes are async-batched; keeping them here preserves the
 * deterministic enqueue/resolve order.
 */
const resolvers = new Map<string, (decision: PluginConfirmationDecision) => void>();

function advance(
  set: (partial: Partial<PluginConfirmState>) => void,
  queue: PendingPluginConfirm[]
) {
  if (queue.length === 0) {
    set({ current: null, queue: [] });
    return;
  }
  const [next, ...rest] = queue;
  set({ current: next, queue: rest });
}

export const usePluginConfirmStore = create<PluginConfirmState & PluginConfirmActions>(
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
      const resolve = resolvers.get(current.requestId);
      resolvers.delete(current.requestId);
      resolve?.(decision);
      advance(set, queue);
    },

    drop: (requestId) => {
      const { current, queue } = get();
      const resolve = resolvers.get(requestId);
      resolvers.delete(requestId);
      // A dropped request must not leave its caller's promise pending —
      // resolve it as "rejected" so the dispatch closure returns cleanly.
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
  })
);

/**
 * Push a confirmation request into the queue and return a Promise that
 * resolves with the user's decision. The returned Promise never rejects —
 * callers branch on the discriminated decision value.
 */
export function requestPluginConfirmation(
  item: Omit<PendingPluginConfirm, "enqueuedAt">
): Promise<PluginConfirmationDecision> {
  return new Promise((resolve) => {
    if (resolvers.has(item.requestId)) {
      // Replacing a live resolver would orphan the original promise. UUID
      // collisions are vanishingly unlikely, so log and refuse rather than
      // silently drop work; this also lets tests catch misuse.
      console.warn(`[PluginConfirmStore] duplicate requestId rejected: ${item.requestId}`);
      resolve("rejected");
      return;
    }
    resolvers.set(item.requestId, resolve);
    usePluginConfirmStore.getState().enqueue({ ...item, enqueuedAt: Date.now() });
  });
}

/** Test-only escape hatch — resets store and clears the resolver map. */
export function __resetPluginConfirmStoreForTesting(): void {
  usePluginConfirmStore.getState().reset();
}
