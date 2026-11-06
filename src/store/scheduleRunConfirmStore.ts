import { create } from "zustand";

/**
 * A Run now held until the user decides, because the schedule's earlier runs
 * are still open (#15980). Under `skip` the answer is whether to run anyway,
 * alongside them; under `replace`, whether to close them and run. One dialog
 * at a time, the rest wait behind it.
 */
export interface PendingScheduleRunConfirm {
  requestId: string;
  scheduleName: string;
  policy: "skip" | "replace";
  openRunCount: number;
}

interface ScheduleRunConfirmState {
  current: PendingScheduleRunConfirm | null;
  queue: PendingScheduleRunConfirm[];
}

// Resolvers are functions, so they live outside the store, keyed by request.
const resolvers = new Map<string, (approved: boolean) => void>();

export const useScheduleRunConfirmStore = create<ScheduleRunConfirmState>(() => ({
  current: null,
  queue: [],
}));

/**
 * Settle one request. Keyed by id rather than "whatever is current", so a
 * dialog callback that fires after its request was promoted away can't answer
 * the next one.
 */
export function resolveScheduleRunConfirmation(requestId: string, approved: boolean): void {
  const resolve = resolvers.get(requestId);
  if (!resolve) return;
  resolvers.delete(requestId);
  const { current, queue } = useScheduleRunConfirmStore.getState();
  if (current?.requestId === requestId) {
    const [next = null, ...rest] = queue;
    useScheduleRunConfirmStore.setState({ current: next, queue: rest });
  } else {
    useScheduleRunConfirmStore.setState({
      queue: queue.filter((item) => item.requestId !== requestId),
    });
  }
  resolve(approved);
}

/** Decline every request, for when the dialog that would ask about them can't render. */
export function cancelScheduleRunConfirmations(): void {
  const { current, queue } = useScheduleRunConfirmStore.getState();
  for (const item of [...(current ? [current] : []), ...queue]) {
    resolveScheduleRunConfirmation(item.requestId, false);
  }
}

/** Ask whether to run with earlier runs still open. Resolves `false` when the user backs out. */
export function requestScheduleRunConfirmation(
  request: Omit<PendingScheduleRunConfirm, "requestId">
): Promise<boolean> {
  const item: PendingScheduleRunConfirm = { ...request, requestId: crypto.randomUUID() };
  return new Promise((resolve) => {
    resolvers.set(item.requestId, resolve);
    const { current, queue } = useScheduleRunConfirmStore.getState();
    if (current === null) {
      useScheduleRunConfirmStore.setState({ current: item });
    } else {
      useScheduleRunConfirmStore.setState({ queue: [...queue, item] });
    }
  });
}
