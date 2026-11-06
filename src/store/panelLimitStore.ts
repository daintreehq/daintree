import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { StorageValue } from "zustand/middleware";
import { createSafeJSONStorage } from "./persistence/safeStorage";
import {
  pickFieldByWriterDelta,
  type PersistWriteMergeContext,
} from "./persistence/persistWriteMerge";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";
import { notify } from "@/lib/notify";
import {
  buildPanelLimitSnapshot,
  computeHardwareDefaults,
  evaluatePanelLimit,
  type PanelLimitSnapshot,
  type PanelLimitTier,
} from "@shared/utils/panelLimit";
import {
  reservePanelSlots,
  type PanelSlotGrant,
} from "./slices/panelRegistry/panelSlotReservations";
import { MCP_CONFIRM_HOLD_GRACE_MS } from "@shared/config/mcpConfirmWindow";

export { buildPanelLimitSnapshot, computeHardwareDefaults, evaluatePanelLimit };
export type { PanelLimitSnapshot, PanelLimitTier };

export const DEFAULT_SOFT_WARNING_LIMIT = 12;
export const DEFAULT_CONFIRMATION_LIMIT = 20;
export const DEFAULT_HARD_LIMIT = 32;
export const DISMISS_STEP_SIZE = 4;

const STORAGE_KEY = "daintree-panel-limits";

/** The operations that open panels in a batch. */
export type PanelLimitBatchSource = { kind: "recipe"; name: string } | { kind: "clone-layout" };

/**
 * What a batch spawn is asking to do, captured when it asks. The thresholds are
 * snapshots so the dialog explains the decision that was actually made, even if
 * Settings changes while it is open.
 */
export interface PanelLimitConfirmRequest {
  /** Panels already open before the batch. */
  currentCount: number;
  /** Panels the batch asked for. */
  requestedCount: number;
  /** Panels that will open if confirmed — `requestedCount` trimmed to the hard limit. */
  allowedCount: number;
  confirmationLimit: number;
  hardLimit: number;
  /** What is opening the batch, so the dialog can name it. */
  source?: PanelLimitBatchSource;
}

interface PendingConfirmation {
  resolve: (ok: boolean) => void;
  request: PanelLimitConfirmRequest;
}

interface PanelLimitState {
  softWarningLimit: number;
  confirmationLimit: number;
  hardLimit: number;
  warningsDisabled: boolean;
  hardwareDefaultsApplied: boolean;
  lastSoftWarningDismissedAt: number | null;
  pendingConfirm: PendingConfirmation | null;
  /**
   * Monotonic counter bumped on every request. Used as the always-mounted host's
   * ErrorBoundary `resetKeys` signal so a crashed dialog auto-recovers when a new
   * request arrives — including the back-to-back supersede case where
   * `pendingConfirm` never returns to null between requests (#9918). Transient
   * runtime state — intentionally excluded from `partialize`.
   */
  requestSeq: number;
  setSoftWarningLimit: (limit: number) => void;
  setConfirmationLimit: (limit: number) => void;
  setHardLimit: (limit: number) => void;
  setWarningsDisabled: (disabled: boolean) => void;
  dismissSoftWarning: (currentCount: number) => void;
  requestConfirmation: (request: PanelLimitConfirmRequest) => Promise<boolean>;
  resolveConfirmation: (ok: boolean) => void;
  /**
   * Take down `request`'s dialog without an answer, resolving its waiter with
   * false. A no-op unless that exact request is still the one on screen, so a
   * newer request that superseded it is never touched.
   */
  withdrawConfirmation: (request: PanelLimitConfirmRequest) => void;
  initializeFromHardware: () => Promise<void>;
  resetToHardwareDefaults: () => Promise<void>;
}

export function shouldShowSoftWarning(
  count: number,
  softLimit: number,
  warningsDisabled: boolean,
  lastDismissedAt: number | null
): boolean {
  if (warningsDisabled) return false;
  if (count < softLimit) return false;
  if (lastDismissedAt == null) return true;
  return count >= lastDismissedAt + DISMISS_STEP_SIZE;
}

let _initPromise: Promise<void> | null = null;

type PanelLimitPersistedState = Pick<
  PanelLimitState,
  | "softWarningLimit"
  | "confirmationLimit"
  | "hardLimit"
  | "warningsDisabled"
  | "hardwareDefaultsApplied"
  | "lastSoftWarningDismissedAt"
>;

const PANEL_LIMIT_PERSISTED_DEFAULTS: PanelLimitPersistedState = {
  softWarningLimit: DEFAULT_SOFT_WARNING_LIMIT,
  confirmationLimit: DEFAULT_CONFIRMATION_LIMIT,
  hardLimit: DEFAULT_HARD_LIMIT,
  warningsDisabled: false,
  hardwareDefaultsApplied: false,
  lastSoftWarningDismissedAt: null,
};

function toPanelLimitPersisted(
  state: Partial<PanelLimitState> | null | undefined
): PanelLimitPersistedState {
  const raw = (state ?? {}) as Record<string, unknown>;
  const d = PANEL_LIMIT_PERSISTED_DEFAULTS;
  return {
    softWarningLimit:
      typeof raw.softWarningLimit === "number" ? raw.softWarningLimit : d.softWarningLimit,
    confirmationLimit:
      typeof raw.confirmationLimit === "number" ? raw.confirmationLimit : d.confirmationLimit,
    hardLimit: typeof raw.hardLimit === "number" ? raw.hardLimit : d.hardLimit,
    warningsDisabled:
      typeof raw.warningsDisabled === "boolean" ? raw.warningsDisabled : d.warningsDisabled,
    hardwareDefaultsApplied:
      typeof raw.hardwareDefaultsApplied === "boolean"
        ? raw.hardwareDefaultsApplied
        : d.hardwareDefaultsApplied,
    lastSoftWarningDismissedAt:
      typeof raw.lastSoftWarningDismissedAt === "number" ? raw.lastSoftWarningDismissedAt : null,
  };
}

/**
 * Baseline-aware three-way merge for panel-limit writes across project views
 * (issue #11351). Every persisted field is an independently-set scalar, so a
 * field defers to a sibling's on-disk value unless this writer changed it. This
 * matters even though the fields aren't project-scoped: the store's transient
 * setters (`requestConfirmation` bumping `requestSeq`, `resolveConfirmation`
 * clearing `pendingConfirm`) trigger a persist write of the *unchanged*
 * partialized limits, so without the merge a stale view's first such write
 * reserializes and clobbers a sibling's just-edited limit.
 */
function mergePanelLimitPersistedWrite({
  baseline,
  onDisk,
  incoming,
}: PersistWriteMergeContext<PanelLimitPersistedState>): StorageValue<PanelLimitPersistedState> {
  if (!onDisk || onDisk.version !== incoming.version) return incoming;
  const disk = toPanelLimitPersisted(onDisk.state);
  const inc = toPanelLimitPersisted(incoming.state);
  if (baseline && typeof baseline.version === "number" && baseline.version !== incoming.version) {
    return { version: incoming.version, state: disk };
  }
  const base = toPanelLimitPersisted(baseline?.state);
  return {
    version: incoming.version,
    state: {
      softWarningLimit: pickFieldByWriterDelta(
        base.softWarningLimit,
        inc.softWarningLimit,
        disk.softWarningLimit
      ),
      confirmationLimit: pickFieldByWriterDelta(
        base.confirmationLimit,
        inc.confirmationLimit,
        disk.confirmationLimit
      ),
      hardLimit: pickFieldByWriterDelta(base.hardLimit, inc.hardLimit, disk.hardLimit),
      warningsDisabled: pickFieldByWriterDelta(
        base.warningsDisabled,
        inc.warningsDisabled,
        disk.warningsDisabled
      ),
      hardwareDefaultsApplied: pickFieldByWriterDelta(
        base.hardwareDefaultsApplied,
        inc.hardwareDefaultsApplied,
        disk.hardwareDefaultsApplied
      ),
      lastSoftWarningDismissedAt: pickFieldByWriterDelta(
        base.lastSoftWarningDismissedAt,
        inc.lastSoftWarningDismissedAt,
        disk.lastSoftWarningDismissedAt
      ),
    },
  };
}

export const usePanelLimitStore = create<PanelLimitState>()(
  persist(
    (set, get) => ({
      softWarningLimit: DEFAULT_SOFT_WARNING_LIMIT,
      confirmationLimit: DEFAULT_CONFIRMATION_LIMIT,
      hardLimit: DEFAULT_HARD_LIMIT,
      warningsDisabled: false,
      hardwareDefaultsApplied: false,
      lastSoftWarningDismissedAt: null,
      pendingConfirm: null,
      requestSeq: 0,

      setSoftWarningLimit: (limit: number) => {
        if (!Number.isFinite(limit)) return;
        set({ softWarningLimit: Math.max(4, Math.min(100, limit)) });
      },

      setConfirmationLimit: (limit: number) => {
        if (!Number.isFinite(limit)) return;
        set({ confirmationLimit: Math.max(4, Math.min(100, limit)) });
      },

      setHardLimit: (limit: number) => {
        if (!Number.isFinite(limit)) return;
        set({ hardLimit: Math.max(4, Math.min(100, limit)) });
      },

      setWarningsDisabled: (disabled: boolean) => {
        set({ warningsDisabled: disabled });
      },

      dismissSoftWarning: (currentCount: number) => {
        set({ lastSoftWarningDismissedAt: currentCount });
      },

      requestConfirmation: (request: PanelLimitConfirmRequest): Promise<boolean> => {
        const existing = get().pendingConfirm;
        if (existing) {
          existing.resolve(false);
        }

        return new Promise<boolean>((resolve) => {
          set((state) => ({
            pendingConfirm: { resolve, request },
            requestSeq: state.requestSeq + 1,
          }));
        });
      },

      resolveConfirmation: (ok: boolean) => {
        const pending = get().pendingConfirm;
        if (pending) {
          pending.resolve(ok);
          set({ pendingConfirm: null });
        }
      },

      withdrawConfirmation: (request: PanelLimitConfirmRequest) => {
        const pending = get().pendingConfirm;
        if (pending?.request !== request) return;
        pending.resolve(false);
        set({ pendingConfirm: null });
      },

      initializeFromHardware: async () => {
        if (_initPromise) return _initPromise;
        _initPromise = (async () => {
          const state = get();
          if (state.hardwareDefaultsApplied) return;
          try {
            const { totalMemoryBytes } = await window.electron.system.getHardwareInfo();
            if (totalMemoryBytes <= 0) return;
            const defaults = computeHardwareDefaults(totalMemoryBytes);
            const current = get();
            if (current.hardwareDefaultsApplied) return;
            set({
              softWarningLimit: defaults.soft,
              confirmationLimit: defaults.confirm,
              hardLimit: defaults.hard,
              hardwareDefaultsApplied: true,
            });
          } catch {
            _initPromise = null;
          }
        })();
        return _initPromise;
      },

      resetToHardwareDefaults: async () => {
        try {
          const { totalMemoryBytes } = await window.electron.system.getHardwareInfo();
          if (totalMemoryBytes <= 0) return;
          const defaults = computeHardwareDefaults(totalMemoryBytes);
          set({
            softWarningLimit: defaults.soft,
            confirmationLimit: defaults.confirm,
            hardLimit: defaults.hard,
            hardwareDefaultsApplied: true,
          });
        } catch {
          // IPC unavailable
        }
      },
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      storage: createSafeJSONStorage<PanelLimitPersistedState>({
        mergeOnWrite: mergePanelLimitPersistedWrite,
      }),
      migrate: (persisted, version): PanelLimitPersistedState => {
        const migrated = toPanelLimitPersisted(persisted as Partial<PanelLimitState>);
        if (version === 0) {
          // Pre-hardware-defaults blobs keep their existing limits and are marked
          // as already-applied so hardware defaults don't overwrite them.
          return {
            ...migrated,
            warningsDisabled: false,
            hardwareDefaultsApplied: true,
            lastSoftWarningDismissedAt: null,
          };
        }
        return migrated;
      },
      partialize: (state) => ({
        softWarningLimit: state.softWarningLimit,
        confirmationLimit: state.confirmationLimit,
        hardLimit: state.hardLimit,
        warningsDisabled: state.warningsDisabled,
        hardwareDefaultsApplied: state.hardwareDefaultsApplied,
        lastSoftWarningDismissedAt: state.lastSoftWarningDismissedAt,
      }),
    }
  )
);

registerPersistedStore({
  storeId: "panelLimitStore",
  store: usePanelLimitStore,
  persistedStateType:
    "Pick<PanelLimitState, 'softWarningLimit' | 'confirmationLimit' | 'hardLimit' | 'warningsDisabled' | 'hardwareDefaultsApplied' | 'lastSoftWarningDismissedAt'>",
});

export function _resetInitPromise(): void {
  _initPromise = null;
}

function notifyPanelLimitReached(hardLimit: number, worktreeId: string | undefined): void {
  notify({
    type: "warning",
    priority: "high",
    title: "Panel limit reached",
    message: `Maximum of ${hardLimit} panels reached. Close some panels before adding new ones.`,
    duration: 5000,
    context: {
      eventKind: "uiFeedback",
      ...(worktreeId ? { worktreeId } : {}),
    },
  });
}

/**
 * Aggregate panel-limit gate for batch spawns (recipes, worktree spin-up).
 *
 * Batched `addPanel` defers the `panelIds` append, so the per-call limit check
 * in `addPanel` would read the same stale count for every panel in the burst
 * and under-enforce the ceiling. Callers run this once up front, spawn only the
 * returned `allowed` count with `bypassLimits: true`, and report the rest as
 * "Panel limit reached" — or, when `declined`, as `PANEL_LIMIT_DECLINED_REASON`.
 * The confirmation dialog (if the burst crosses the confirm threshold) is
 * awaited here, before the batch opens, so it never renders mid-commit. See #9165.
 *
 * The granted slots are reserved in the same tick the count is read, so an
 * overlapping gate or single add can't be granted them too (#15607). The
 * caller claims a slot with each panel's id right before its `addPanel`, and
 * releases the grant once its batch has flushed. No capacity is held while the
 * confirm is open: the count is read again once it's answered, and the grant
 * shrinks to whatever is still free.
 *
 * A batch an agent's dispatch is waiting on passes that dispatch's
 * `deadlineAt` (#15648). Its confirm then closes on its own a grace period
 * before main gives up on the call, so the caller hears a timeout instead of
 * main's generic one, and a yes given after that launches nothing.
 *
 * @param readUsage - Reads the live count, `countPanelLimitUsage` over the
 *   current panel store state; called again after the confirm.
 * @returns `allowed` — how many of the requested panels may be spawned now
 *   (0 when the hard limit is already reached or the user declines the confirm);
 *   `declined` — true only when the user answered the confirm with no;
 *   `expired` — set only when the confirm ran out of time first;
 *   `grant` — the reserved slots, `null` when `allowed` is 0.
 */
export async function preflightSpawnBatchLimit(
  readUsage: () => number,
  requestedCount: number,
  options: { source?: PanelLimitBatchSource; worktreeId?: string; deadlineAt?: number } = {}
): Promise<{
  allowed: number;
  declined: boolean;
  expired?: true;
  grant: PanelSlotGrant | null;
}> {
  if (requestedCount <= 0) return { allowed: 0, declined: false, grant: null };

  const { confirmationLimit, hardLimit, warningsDisabled } = usePanelLimitStore.getState();

  const currentCount = readUsage();
  const available = Math.max(0, hardLimit - currentCount);
  if (available === 0) {
    notifyPanelLimitReached(hardLimit, options.worktreeId);
    return { allowed: 0, declined: false, grant: null };
  }

  const allowed = Math.min(available, requestedCount);
  const projected = currentCount + allowed;

  // Batch spawns (recipes, worktree spin-up) add many panels at once and are not
  // trivially reversible the way a single-panel add is (one-click close), so they
  // keep the blocking confirm even though `addPanel` dropped it for single adds
  // (#10547). The batch crosses the confirm threshold when `projected > confirmationLimit`.
  if (!warningsDisabled && projected > confirmationLimit) {
    const answer = await confirmBefore(
      {
        currentCount,
        requestedCount,
        allowedCount: allowed,
        confirmationLimit,
        hardLimit,
        ...(options.source ? { source: options.source } : {}),
      },
      options.deadlineAt
    );
    if (answer === "expired") return { allowed: 0, declined: false, expired: true, grant: null };
    if (!answer) return { allowed: 0, declined: true, grant: null };

    // Other adds kept going while the dialog was open. Never more than the
    // user agreed to, and never more than is free now.
    const liveHardLimit = usePanelLimitStore.getState().hardLimit;
    const confirmedAllowed = Math.min(allowed, Math.max(0, liveHardLimit - readUsage()));
    if (confirmedAllowed === 0) {
      notifyPanelLimitReached(liveHardLimit, options.worktreeId);
      return { allowed: 0, declined: false, grant: null };
    }
    return {
      allowed: confirmedAllowed,
      declined: false,
      grant: reservePanelSlots(confirmedAllowed),
    };
  }

  return { allowed, declined: false, grant: reservePanelSlots(allowed) };
}

/**
 * Ask the person, within whatever the dispatch behind the batch has left.
 *
 * With no deadline the dialog waits as long as the person takes. With one, it
 * closes {@link MCP_CONFIRM_HOLD_GRACE_MS} before it, the slack main keeps for
 * an answer still on its way. The timer only takes the dialog down: a
 * background view can fire it late, after a click has already landed, so the
 * clock decides whether a yes still counts.
 */
async function confirmBefore(
  request: PanelLimitConfirmRequest,
  deadlineAt: number | undefined
): Promise<boolean | "expired"> {
  const { requestConfirmation, withdrawConfirmation } = usePanelLimitStore.getState();
  if (deadlineAt === undefined) return requestConfirmation(request);

  const closeAt = deadlineAt - MCP_CONFIRM_HOLD_GRACE_MS;
  const remainingMs = closeAt - Date.now();
  if (remainingMs <= 0) return "expired";

  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), remainingMs);
  });
  try {
    const answer = await Promise.race([requestConfirmation(request), closed]);
    if (answer === "expired" || (answer && Date.now() >= closeAt)) {
      withdrawConfirmation(request);
      return "expired";
    }
    return answer;
  } finally {
    clearTimeout(timer);
  }
}
