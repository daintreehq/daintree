import type { CIStatusState } from "@shared/types/forge";

export type AlarmTier = 0 | 1 | 2 | 3;

export type AlarmKind = "none" | "behind" | "auth-failed" | "ci-failed";

export type AlarmTone = "none" | "warning" | "error";

export interface AlarmDescriptor {
  tier: AlarmTier;
  kind: AlarmKind;
  label: string;
  tone: AlarmTone;
}

export interface AlarmTierInput {
  /**
   * CI roll-up state for the worktree's linked PR. Callers should pass
   * `undefined` when the PR is closed/declined so a stale `"failure"` value
   * doesn't surface a phantom alarm on a closed PR.
   */
  ciState?: CIStatusState;
  /**
   * True when the auth-failed treatment is eligible to render — caller must
   * have applied any provider gate (e.g. GitHub-only) before passing this in.
   */
  authFailed?: boolean;
  /** Commits behind the branch's own upstream, when it has one. */
  behindCount?: number;
  /**
   * Commits behind the base branch. Read alongside {@link behindCount} because
   * the two are alternatives, not a pair: a worktree branch created without
   * tracking has no upstream count at all, and its drift from the base is the
   * only "behind" signal it will ever produce. Gating the pill on
   * `behindCount` alone left every such branch silently un-alarmed.
   */
  baseBehindCount?: number | null;
}

const NONE: AlarmDescriptor = { tier: 0, kind: "none", label: "", tone: "none" };

/**
 * Reduce a worktree's alarm-relevant fields to a single salience tier so the
 * collapsed alarm pill and the expanded badge ordering share one source of
 * truth. Only `"failure"` CI maps above tier 0 — transient pending/neutral
 * states stay quiet to avoid spatial churn on every push. Detached HEAD is
 * deliberately not in the alarm set; `gitStateIndicator` already surfaces it
 * in the title row, so adding it here would double-label collapsed rows.
 */
export function computeAlarmTier(input: AlarmTierInput): AlarmDescriptor {
  if (input.ciState === "failure") {
    return { tier: 3, kind: "ci-failed", label: "CI failed", tone: "error" };
  }
  if (input.authFailed === true) {
    return { tier: 2, kind: "auth-failed", label: "Auth failed", tone: "warning" };
  }
  if ((input.behindCount ?? 0) > 0 || (input.baseBehindCount ?? 0) > 0) {
    return { tier: 1, kind: "behind", label: "Behind", tone: "warning" };
  }
  return NONE;
}
