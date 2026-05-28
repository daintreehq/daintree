import { create } from "zustand";
import type { PluginCapability } from "@shared/types/plugin";
import type {
  PluginMcpConsentDecision,
  PluginMcpConsentReason,
  PluginMcpDangerTier,
} from "@shared/types/pluginMcpConsent";

/**
 * One pending consent prompt surfaced for a plugin-MCP tool call. Stored in a
 * FIFO queue; only the first item drives the visible modal so concurrent
 * plugin tool calls never stack overlapping dialogs.
 *
 * `descriptionDisplay` is the host-sanitised tool description — ANSI/OSC
 * stripped in main. The renderer must render it as a plain React text node;
 * no HTML, no Markdown, no `dangerouslySetInnerHTML`.
 *
 * `argsSummary` is pre-redacted via `summarizeMcpArgs`; raw args never cross
 * the IPC boundary. Empty string when the call carried no args or when the
 * tier is D0.
 */
export interface PendingPluginMcpConsent {
  requestId: string;
  pluginId: string;
  serverId: string;
  toolName: string;
  pluginDisplayName: string;
  descriptionDisplay: string;
  argsSummary: string;
  dangerTier: PluginMcpDangerTier;
  declaredCapabilities: readonly PluginCapability[];
  reason: PluginMcpConsentReason;
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

const resolvers = new Map<string, (decision: PluginMcpConsentDecision) => void>();

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
    resolvers.set(item.requestId, resolve);
    usePluginMcpConfirmStore.getState().enqueue({ ...item, enqueuedAt: Date.now() });
  });
}

/** Test-only escape hatch — resets store and clears the resolver map. */
export function __resetPluginMcpConfirmStoreForTesting(): void {
  usePluginMcpConfirmStore.getState().reset();
}
