import { create } from "zustand";

/**
 * A recipe run held until the user decides, because some of its built-in
 * variables have no value where it would launch (#15022). FIFO like the layout
 * confirmations: one dialog at a time, the rest wait behind it.
 */
export interface PendingRecipeRunConfirm {
  requestId: string;
  recipeName: string;
  /** Variable names as the recipe writes them inside `{{…}}`, in first-use order. */
  missing: string[];
}

interface RecipeRunConfirmState {
  current: PendingRecipeRunConfirm | null;
  queue: PendingRecipeRunConfirm[];
}

// Resolvers are functions, so they live outside the store, keyed by request.
const resolvers = new Map<string, (approved: boolean) => void>();

export const useRecipeRunConfirmStore = create<RecipeRunConfirmState>(() => ({
  current: null,
  queue: [],
}));

/**
 * Settle one request. Keyed by id rather than "whatever is current", so a
 * dialog callback that fires after its request was promoted away — a close
 * after a confirm, a second click — can't answer the next one.
 */
export function resolveRecipeRunConfirmation(requestId: string, approved: boolean): void {
  const resolve = resolvers.get(requestId);
  if (!resolve) return;
  resolvers.delete(requestId);
  const { current, queue } = useRecipeRunConfirmStore.getState();
  if (current?.requestId === requestId) {
    const [next = null, ...rest] = queue;
    useRecipeRunConfirmStore.setState({ current: next, queue: rest });
  } else {
    useRecipeRunConfirmStore.setState({
      queue: queue.filter((item) => item.requestId !== requestId),
    });
  }
  resolve(approved);
}

/** Decline every request, for when the dialog that would ask about them can't render. */
export function cancelRecipeRunConfirmations(): void {
  const { current, queue } = useRecipeRunConfirmStore.getState();
  for (const item of [...(current ? [current] : []), ...queue]) {
    resolveRecipeRunConfirmation(item.requestId, false);
  }
}

/**
 * Ask whether to run a recipe with the listed variables left empty. Resolves
 * `false` when the user backs out or `signal` aborts first.
 */
export function requestRecipeRunConfirmation(
  request: Omit<PendingRecipeRunConfirm, "requestId">,
  signal?: AbortSignal
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  const item: PendingRecipeRunConfirm = { ...request, requestId: crypto.randomUUID() };
  return new Promise((resolve) => {
    const onAbort = () => resolveRecipeRunConfirmation(item.requestId, false);
    resolvers.set(item.requestId, (approved) => {
      signal?.removeEventListener("abort", onAbort);
      resolve(approved);
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    const { current, queue } = useRecipeRunConfirmStore.getState();
    if (current === null) {
      useRecipeRunConfirmStore.setState({ current: item });
    } else {
      useRecipeRunConfirmStore.setState({ queue: [...queue, item] });
    }
  });
}
