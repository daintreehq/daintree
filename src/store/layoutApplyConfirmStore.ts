import { create } from "zustand";

/**
 * One layout waiting for the user to approve the terminals it starts (#13780).
 * The queue is FIFO like the plugin action confirmations: one dialog at a time,
 * the rest wait behind it.
 */
export interface PendingLayoutApplyConfirm {
  requestId: string;
  /** The runtime layout id, so a withdrawn layout's requests can be cancelled. */
  layoutId: string;
  layoutName: string;
  pluginName: string;
  /** Every terminal the layout's recipes start, listed as the recipe confirmation lists them. */
  previewLines: string[];
}

interface LayoutApplyConfirmState {
  current: PendingLayoutApplyConfirm | null;
  queue: PendingLayoutApplyConfirm[];
  resolveCurrent: (approved: boolean) => void;
}

// Resolvers are functions, so they live outside the store, keyed by request.
const resolvers = new Map<string, (approved: boolean) => void>();

export const useLayoutApplyConfirmStore = create<LayoutApplyConfirmState>((set, get) => ({
  current: null,
  queue: [],
  resolveCurrent: (approved) => {
    const { current, queue } = get();
    if (current === null) return;
    const resolve = resolvers.get(current.requestId);
    resolvers.delete(current.requestId);
    const [next = null, ...rest] = queue;
    set({ current: next, queue: rest });
    resolve?.(approved);
  },
}));

interface CancellationWatch {
  readonly layoutId: string;
  cancelled: boolean;
}

const watches = new Set<CancellationWatch>();

/**
 * Watch for a cancellation of a layout across an await that sits between
 * resolving it and raising its request. A cancellation landing in that wait had
 * no request to decline, so the caller reads `cancelled` afterwards and declines
 * itself. Release the watch when the wait ends; only live waits are tracked.
 */
export function watchLayoutApplyCancellation(layoutId: string): {
  readonly cancelled: boolean;
  release: () => void;
} {
  const watch: CancellationWatch = { layoutId, cancelled: false };
  watches.add(watch);
  return {
    get cancelled() {
      return watch.cancelled;
    },
    release: () => {
      watches.delete(watch);
    },
  };
}

/**
 * Decline every request for a layout that is no longer offered — its plugin
 * unloaded, reloaded or was hidden — so its dialog never asks about it. With no
 * ids, every request is declined.
 */
export function cancelLayoutApplyConfirmations(layoutIds?: ReadonlySet<string>): void {
  for (const watch of watches) {
    if (layoutIds === undefined || layoutIds.has(watch.layoutId)) watch.cancelled = true;
  }
  const { current, queue } = useLayoutApplyConfirmStore.getState();
  const cancelled = (item: PendingLayoutApplyConfirm) =>
    layoutIds === undefined || layoutIds.has(item.layoutId);
  const kept = queue.filter((item) => !cancelled(item));
  for (const item of [...(current ? [current] : []), ...queue]) {
    if (!cancelled(item)) continue;
    const resolve = resolvers.get(item.requestId);
    resolvers.delete(item.requestId);
    resolve?.(false);
  }
  if (current !== null && cancelled(current)) {
    const [next = null, ...rest] = kept;
    useLayoutApplyConfirmStore.setState({ current: next, queue: rest });
  } else if (kept.length !== queue.length) {
    useLayoutApplyConfirmStore.setState({ queue: kept });
  }
}

/**
 * Decline a request whose dialog failed to render (#17204), so the layout
 * waiting on it stops and the next one can ask. A no-op unless `requestId` is
 * still the request in front.
 */
export function declineFailedLayoutApplyConfirmation(requestId: string): void {
  const { current, resolveCurrent } = useLayoutApplyConfirmStore.getState();
  if (current === null || current.requestId !== requestId) return;
  resolveCurrent(false);
}

/** Ask the user to approve applying a layout; resolves `false` when they decline. */
export function requestLayoutApplyConfirmation(
  request: Omit<PendingLayoutApplyConfirm, "requestId">
): Promise<boolean> {
  const item: PendingLayoutApplyConfirm = { ...request, requestId: crypto.randomUUID() };
  return new Promise((resolve) => {
    resolvers.set(item.requestId, resolve);
    const { current, queue } = useLayoutApplyConfirmStore.getState();
    if (current === null) {
      useLayoutApplyConfirmStore.setState({ current: item });
    } else {
      useLayoutApplyConfirmStore.setState({ queue: [...queue, item] });
    }
  });
}
