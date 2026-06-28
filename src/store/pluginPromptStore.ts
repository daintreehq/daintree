import { create } from "zustand";
import type {
  PluginUiPromptRequest,
  PluginUiPromptParams,
  PluginUiPromptResultValue,
} from "@shared/types/pluginUiPrompt";

/**
 * The dismiss/cancel outcome for a prompt kind — `false` for a confirm (the
 * user did not confirm), `undefined` for quick-pick / input-box. Used whenever a
 * prompt is resolved without an explicit answer (Escape, click-away, or a
 * main-process cancel after the plugin unloads).
 */
export function dismissValueFor(kind: PluginUiPromptParams["kind"]): PluginUiPromptResultValue {
  return kind === "confirm" ? false : undefined;
}

/**
 * One pending imperative UI prompt surfaced for a plugin (#10522). Stored in a
 * FIFO queue; only the first item drives the visible dialog so concurrent
 * prompts never stack overlapping surfaces.
 *
 * Unlike `pluginConfirmStore`, the `resolve` callback lives INSIDE the queue
 * item (in Zustand state) rather than a module-level `Map`. A module-scoped map
 * is wiped when Vite recreates the module on HMR, orphaning any in-flight
 * promise; co-locating the resolver with its item keeps the two in lockstep.
 */
export interface PendingUiPrompt {
  promptId: string;
  pluginId: string;
  params: PluginUiPromptParams;
  /** Resolves the promise returned by {@link enqueueUiPrompt}. */
  resolve: (value: PluginUiPromptResultValue) => void;
}

interface PluginPromptState {
  queue: PendingUiPrompt[];
  current: PendingUiPrompt | null;
}

interface PluginPromptActions {
  enqueue: (item: PendingUiPrompt) => void;
  /** Resolve the visible prompt with the user's answer and advance the queue. */
  resolveCurrent: (value: PluginUiPromptResultValue) => void;
  /**
   * Drop every prompt for `pluginId` (or one specific `promptId`), resolving
   * each with its dismiss value. Invoked when the main process broadcasts a
   * cancel after the plugin unloads mid-prompt.
   */
  cancelByPluginId: (pluginId: string, promptId?: string) => void;
  reset: () => void;
}

function advance(set: (partial: Partial<PluginPromptState>) => void, queue: PendingUiPrompt[]) {
  if (queue.length === 0) {
    set({ current: null, queue: [] });
    return;
  }
  const [next, ...rest] = queue;
  set({ current: next, queue: rest });
}

export const usePluginPromptStore = create<PluginPromptState & PluginPromptActions>((set, get) => ({
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

  resolveCurrent: (value) => {
    const { current, queue } = get();
    if (current === null) return;
    current.resolve(value);
    advance(set, queue);
  },

  cancelByPluginId: (pluginId, promptId) => {
    const { current, queue } = get();
    const matches = (item: PendingUiPrompt) =>
      item.pluginId === pluginId && (promptId === undefined || item.promptId === promptId);

    // Resolve queued (non-visible) matches first so they don't get promoted.
    const keptQueue: PendingUiPrompt[] = [];
    for (const item of queue) {
      if (matches(item)) {
        item.resolve(dismissValueFor(item.params.kind));
      } else {
        keptQueue.push(item);
      }
    }

    if (current && matches(current)) {
      current.resolve(dismissValueFor(current.params.kind));
      advance(set, keptQueue);
      return;
    }

    if (keptQueue.length !== queue.length) {
      set({ queue: keptQueue });
    }
  },

  reset: () => set({ queue: [], current: null }),
}));

/**
 * Push a prompt request into the queue and return a Promise that resolves with
 * the user's answer (or the dismiss value if cancelled/unloaded). The Promise
 * never rejects — callers branch on the value.
 */
export function enqueueUiPrompt(
  request: PluginUiPromptRequest
): Promise<PluginUiPromptResultValue> {
  return new Promise((resolve) => {
    usePluginPromptStore.getState().enqueue({
      promptId: request.promptId,
      pluginId: request.pluginId,
      params: request.params,
      resolve,
    });
  });
}

/** Test-only escape hatch — resets the queue. */
export function __resetPluginPromptStoreForTesting(): void {
  usePluginPromptStore.getState().reset();
}
