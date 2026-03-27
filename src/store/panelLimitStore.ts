import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSafeJSONStorage } from "./persistence/safeStorage";

export const DEFAULT_SOFT_WARNING_LIMIT = 12;
export const DEFAULT_CONFIRMATION_LIMIT = 20;
export const DEFAULT_HARD_LIMIT = 32;
export const DISMISS_STEP_SIZE = 4;

const STORAGE_KEY = "canopy-panel-limits";

export type PanelLimitTier = "ok" | "soft" | "confirm" | "hard";

export function evaluatePanelLimit(
  count: number,
  limits: { softWarningLimit: number; confirmationLimit: number; hardLimit: number }
): PanelLimitTier {
  if (count >= limits.hardLimit) return "hard";
  if (count >= limits.confirmationLimit) return "confirm";
  if (count >= limits.softWarningLimit) return "soft";
  return "ok";
}

const GB = 1024 * 1024 * 1024;

export function computeHardwareDefaults(totalMemoryBytes: number): {
  soft: number;
  confirm: number;
  hard: number;
} {
  const gb = totalMemoryBytes / GB;
  if (gb <= 8) return { soft: 8, confirm: 16, hard: 24 };
  if (gb <= 16) return { soft: 16, confirm: 30, hard: 48 };
  if (gb <= 32) return { soft: 24, confirm: 48, hard: 72 };
  return { soft: 32, confirm: 64, hard: 100 };
}

interface PendingConfirmation {
  resolve: (ok: boolean) => void;
  panelCount: number;
  memoryMB: number | null;
}

interface PanelLimitState {
  softWarningLimit: number;
  confirmationLimit: number;
  hardLimit: number;
  warningsDisabled: boolean;
  hardwareDefaultsApplied: boolean;
  lastSoftWarningDismissedAt: number | null;
  pendingConfirm: PendingConfirmation | null;
  setSoftWarningLimit: (limit: number) => void;
  setConfirmationLimit: (limit: number) => void;
  setHardLimit: (limit: number) => void;
  setWarningsDisabled: (disabled: boolean) => void;
  dismissSoftWarning: (currentCount: number) => void;
  requestConfirmation: (panelCount: number, memoryMB: number | null) => Promise<boolean>;
  resolveConfirmation: (ok: boolean) => void;
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

      requestConfirmation: (panelCount: number, memoryMB: number | null): Promise<boolean> => {
        const existing = get().pendingConfirm;
        if (existing) {
          existing.resolve(false);
        }

        return new Promise<boolean>((resolve) => {
          set({ pendingConfirm: { resolve, panelCount, memoryMB } });
        });
      },

      resolveConfirmation: (ok: boolean) => {
        const pending = get().pendingConfirm;
        if (pending) {
          pending.resolve(ok);
          set({ pendingConfirm: null });
        }
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
      storage: createSafeJSONStorage(),
      migrate: (persisted, version) => {
        const state = persisted as Record<string, unknown>;
        if (version === 0) {
          return {
            ...state,
            warningsDisabled: false,
            hardwareDefaultsApplied: true,
            lastSoftWarningDismissedAt: null,
          };
        }
        return state;
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

export function _resetInitPromise(): void {
  _initPromise = null;
}
