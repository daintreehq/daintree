import { create } from "zustand";
import { persist } from "zustand/middleware";

export const DEFAULT_SOFT_WARNING_LIMIT = 12;
export const DEFAULT_CONFIRMATION_LIMIT = 20;
export const DEFAULT_HARD_LIMIT = 32;
export const DISMISS_STEP_SIZE = 4;

const STORAGE_KEY = "canopy-panel-limits";
const SESSION_DISMISS_KEY = "panel-limit-last-dismissed-at";

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

export function shouldShowSoftWarning(count: number, softLimit: number): boolean {
  if (count < softLimit) return false;
  try {
    const raw = sessionStorage.getItem(SESSION_DISMISS_KEY);
    if (!raw) return true;
    const lastDismissedAt = parseInt(raw, 10);
    if (Number.isNaN(lastDismissedAt)) return true;
    return count >= lastDismissedAt + DISMISS_STEP_SIZE;
  } catch {
    return true;
  }
}

export function dismissSoftWarning(currentCount: number): void {
  try {
    sessionStorage.setItem(SESSION_DISMISS_KEY, String(currentCount));
  } catch {
    // Ignore storage errors
  }
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
  pendingConfirm: PendingConfirmation | null;
  setSoftWarningLimit: (limit: number) => void;
  setConfirmationLimit: (limit: number) => void;
  setHardLimit: (limit: number) => void;
  requestConfirmation: (panelCount: number, memoryMB: number | null) => Promise<boolean>;
  resolveConfirmation: (ok: boolean) => void;
}

export const usePanelLimitStore = create<PanelLimitState>()(
  persist(
    (set, get) => ({
      softWarningLimit: DEFAULT_SOFT_WARNING_LIMIT,
      confirmationLimit: DEFAULT_CONFIRMATION_LIMIT,
      hardLimit: DEFAULT_HARD_LIMIT,
      pendingConfirm: null,

      setSoftWarningLimit: (limit: number) => {
        const clamped = Math.max(4, Math.min(100, limit));
        set({ softWarningLimit: clamped });
      },

      setConfirmationLimit: (limit: number) => {
        const clamped = Math.max(4, Math.min(100, limit));
        set({ confirmationLimit: clamped });
      },

      setHardLimit: (limit: number) => {
        const clamped = Math.max(4, Math.min(100, limit));
        set({ hardLimit: clamped });
      },

      requestConfirmation: (panelCount: number, memoryMB: number | null): Promise<boolean> => {
        // If there's already a pending confirmation, reject it
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
    }),
    {
      name: STORAGE_KEY,
      partialize: (state) => ({
        softWarningLimit: state.softWarningLimit,
        confirmationLimit: state.confirmationLimit,
        hardLimit: state.hardLimit,
      }),
    }
  )
);
