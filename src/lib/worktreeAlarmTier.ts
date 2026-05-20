import type { CIStatusState } from "@shared/types/forge";

export type AlarmTier = 0 | 1 | 2 | 3 | 4;

export type AlarmKind = "none" | "detached" | "behind" | "auth-failed" | "ci-failed";

export type AlarmTone = "none" | "warning" | "error";

export interface AlarmDescriptor {
  tier: AlarmTier;
  kind: AlarmKind;
  label: string;
  tone: AlarmTone;
}

export interface AlarmTierInput {
  ciState?: CIStatusState;
  fetchAuthFailed?: boolean;
  behindCount?: number;
  isDetached?: boolean;
}

const NONE: AlarmDescriptor = { tier: 0, kind: "none", label: "", tone: "none" };

/**
 * Reduce a worktree's alarm-relevant fields to a single salience tier so the
 * collapsed alarm pill and the expanded badge ordering share one source of
 * truth. Only `"failure"` CI maps to the top tier — transient pending/neutral
 * states stay at tier 0 to avoid spatial churn on every push. Inputs are
 * primitives so callers can pin a narrow `useMemo` dep array.
 */
export function computeAlarmTier(input: AlarmTierInput): AlarmDescriptor {
  if (input.ciState === "failure") {
    return { tier: 4, kind: "ci-failed", label: "CI failed", tone: "error" };
  }
  if (input.fetchAuthFailed === true) {
    return { tier: 3, kind: "auth-failed", label: "Auth failed", tone: "warning" };
  }
  if ((input.behindCount ?? 0) > 0) {
    return { tier: 2, kind: "behind", label: "Behind", tone: "warning" };
  }
  if (input.isDetached === true) {
    return { tier: 1, kind: "detached", label: "Detached", tone: "warning" };
  }
  return NONE;
}
