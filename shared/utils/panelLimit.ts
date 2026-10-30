/**
 * The panel-limit arithmetic, shared by the renderer's limit store and the
 * host's viewless launch (#13495), which has no store to read limits from.
 */

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

export interface PanelLimitOrderingIssues {
  /** The soft banner can't show before the hard stop, so it never warns in time. */
  softAtOrAboveHard: boolean;
  /** A batch is capped at the hard limit, so it never projects past the confirmation. */
  confirmationAtOrAboveHard: boolean;
}

/**
 * Where the soft warning or the confirmation threshold sits too high to do its job.
 * Advisory: the limits are independent settings and each is accepted as typed.
 */
export function getPanelLimitOrderingIssues(limits: {
  softWarningLimit: number;
  confirmationLimit: number;
  hardLimit: number;
}): PanelLimitOrderingIssues {
  return {
    softAtOrAboveHard: limits.softWarningLimit >= limits.hardLimit,
    confirmationAtOrAboveHard: limits.confirmationLimit >= limits.hardLimit,
  };
}

/** The panel count and the limits in force, as `addPanel` judged them. */
export interface PanelLimitSnapshot {
  count: number;
  softWarningLimit: number;
  confirmationLimit: number;
  hardLimit: number;
  tier: PanelLimitTier;
}

export function buildPanelLimitSnapshot(
  count: number,
  limits: { softWarningLimit: number; confirmationLimit: number; hardLimit: number }
): PanelLimitSnapshot {
  const { softWarningLimit, confirmationLimit, hardLimit } = limits;
  return {
    count,
    softWarningLimit,
    confirmationLimit,
    hardLimit,
    tier: evaluatePanelLimit(count, limits),
  };
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
