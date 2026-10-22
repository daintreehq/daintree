import { create } from "zustand";

/**
 * One layout waiting for the user to approve the terminals it starts (#13780).
 * The queue is FIFO like the plugin action confirmations: one dialog at a time,
 * the rest wait behind it.
 */
export interface PendingLayoutApplyConfirm {
  requestId: string;
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
