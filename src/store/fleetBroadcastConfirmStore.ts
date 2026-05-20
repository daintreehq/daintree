import { create } from "zustand";

/**
 * Frozen per-target snapshot rendered in the divergence confirm dialog.
 * The popover's live preview store rebuilds on every keystroke, so we
 * snapshot the values at confirm-request time to keep the dialog body
 * stable while the user reads it.
 */
export interface PendingFleetBroadcastTarget {
  terminalId: string;
  title: string;
  /** The text that will actually be submitted to this terminal. */
  payload: string;
  /** True when the user explicitly overrode this target's payload. */
  overridden: boolean;
  /** True when the user veto-skipped this target in the popover. */
  skipped: boolean;
  /** Variables in the draft that couldn't be resolved for this target. */
  unresolvedVars: string[];
}

/**
 * Single in-flight broadcast that's waiting for the user to confirm.
 * Two paths feed it:
 *   - Pattern-based warnings (destructive command, multi-line, over-byte) —
 *     renders as an inline ribbon strip via `warningReasons`.
 *   - Per-target divergence (overrides set, skips set, unresolved vars) —
 *     renders as a ConfirmDialog modal via `divergence.targets`.
 * Both can be present at once; the divergence dialog takes precedence and
 * folds the warnings into its description.
 *
 * Lives outside ribbon-local state so any caller (paste handler, input bar,
 * future scriptable broadcasts) can request a confirm without a callback
 * prop chain.
 */
export interface PendingFleetBroadcast {
  requestId: string;
  text: string;
  /** Human-readable warnings to surface in the confirm prompt. */
  warningReasons: string[];
  /**
   * When set, the broadcast diverges from the user's typed text and the
   * confirm should show a per-target preview. Absent on warnings-only
   * confirms (existing destructive/multi-line/byte-limit path).
   */
  divergence?: {
    targets: PendingFleetBroadcastTarget[];
  };
}

interface FleetBroadcastConfirmState {
  pending: PendingFleetBroadcast | null;
  clear: () => void;
}

/**
 * Module-level resolver map. Promises returned from
 * `requestFleetBroadcastConfirmation` are keyed by `requestId` UUID so
 * concurrent calls don't collide.
 *
 * The map lives outside React state because resolvers are functions and
 * Zustand state changes are async-batched; storing them in state would
 * defeat the deterministic resolve order.
 */
const resolvers = new Map<string, () => void>();

export const useFleetBroadcastConfirmStore = create<FleetBroadcastConfirmState>((set, get) => ({
  pending: null,
  clear: () => {
    const { pending } = get();
    if (pending !== null) {
      resolvers.delete(pending.requestId);
    }
    set({ pending: null });
  },
}));

/**
 * Request a fleet broadcast confirmation. Returns a Promise that resolves
 * when the user confirms (via `resolveFleetBroadcastConfirmation`) or
 * never resolves if the user cancels / clears the confirmation.
 */
export function requestFleetBroadcastConfirmation(
  entry: Omit<PendingFleetBroadcast, "requestId">
): Promise<void> {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    const store = useFleetBroadcastConfirmStore.getState();

    // Supersede any prior pending confirmation — delete its resolver so
    // the old Promise never resolves.
    if (store.pending !== null) {
      resolvers.delete(store.pending.requestId);
    }

    resolvers.set(requestId, resolve);
    useFleetBroadcastConfirmStore.setState({ pending: { ...entry, requestId } });
  });
}

/**
 * Resolve the current pending broadcast confirmation. The caller-provided
 * send action fires via the stored Promise resolver; the store clears
 * `pending` before calling the resolver so the ribbon immediately reflects
 * the non-pending state.
 */
export function resolveFleetBroadcastConfirmation(): void {
  const { pending } = useFleetBroadcastConfirmStore.getState();
  if (pending === null) return;
  const resolve = resolvers.get(pending.requestId);
  resolvers.delete(pending.requestId);
  useFleetBroadcastConfirmStore.setState({ pending: null });
  resolve?.();
}

/** Test-only escape hatch — resets store and clears the resolver map. */
export function __resetFleetBroadcastConfirmStoreForTesting(): void {
  resolvers.clear();
  useFleetBroadcastConfirmStore.setState({ pending: null });
}
