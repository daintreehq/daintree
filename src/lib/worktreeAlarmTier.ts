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

/**
 * The counts and identity the collapsed pill's tooltip needs to say what the
 * alarm is actually about. Separate from {@link AlarmTierInput} on purpose:
 * that one decides which alarm outranks which and is read by the expanded
 * row's badge ordering too, this one is copy for a single tooltip.
 */
export interface AlarmDetailInput {
  /** Commits ahead of the branch's own upstream, when it has one. */
  aheadCount?: number;
  behindCount?: number;
  baseAheadCount?: number | null;
  baseBehindCount?: number | null;
  /**
   * The base branch's name and the ref its counts were measured against. The
   * producer emits the pair together (`BaseDivergence` never resolves one
   * without the other), which is what keeps this tooltip and the expanded
   * `UpstreamSyncBadge` — whose own base gate reads `baseBranchName` — from
   * disagreeing about the same measurement.
   */
  baseBranchName?: string | null;
  baseCompareRef?: string | null;
  /** True when `@{u}` and the base compare ref are the same commit. */
  baseMatchesUpstream?: boolean;
  /** Failing and total check counts on the linked PR, when the forge reports them. */
  ciFailed?: number;
  ciTotal?: number;
}

/** `3 commits behind, 2 ahead` — behind first, because behind is what raised the alarm. */
function describeDrift(behind: number, ahead: number): string | undefined {
  const parts: string[] = [];
  if (behind > 0) parts.push(`${behind} commit${behind === 1 ? "" : "s"} behind`);
  if (ahead > 0) parts.push(`${ahead} ahead`);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/**
 * The second line of the collapsed pill's tooltip, or `undefined` when there is
 * nothing true to add.
 *
 * The pill lost its text so it would stop out-shouting the branch name, and on
 * a collapsed row nothing else states the drift — `NonMainSecondaryRow` and its
 * upstream badge only render expanded. So the counts have to be somewhere, and
 * this is where they went.
 *
 * Only positive counts are named. An absent count is "we have not measured
 * that", never zero, and a tooltip that turns the difference into `0 commits
 * behind` makes a claim the fetch never made.
 */
export function formatAlarmDetail(kind: AlarmKind, input: AlarmDetailInput): string | undefined {
  switch (kind) {
    case "ci-failed": {
      const failed = input.ciFailed ?? 0;
      const total = input.ciTotal ?? 0;
      if (failed <= 0 || total <= 0) return "Checks failed on the linked pull request";
      return `${failed} of ${total} check${total === 1 ? "" : "s"} failing`;
    }
    case "auth-failed":
      // Names where the affordance is rather than implying this mark is it:
      // the pill takes hover for the tooltip and nothing else, and the button
      // that actually reconnects lives on the expanded card.
      return "Expand the card to reconnect your code forge";
    case "behind": {
      const upstream = describeDrift(input.behindCount ?? 0, input.aheadCount ?? 0);
      const base = describeDrift(input.baseBehindCount ?? 0, input.baseAheadCount ?? 0);
      const ref = input.baseCompareRef || input.baseBranchName;
      const baseLine = base === undefined ? undefined : `Base${ref ? ` (${ref})` : ""}: ${base}`;
      const upstreamLine = upstream === undefined ? undefined : `Upstream: ${upstream}`;
      // The same dedupe the expanded badge does: when `@{u}` and the base
      // compare ref are the same commit the two pairs are one measurement, and
      // only one of them should be stated. Keep the half that says what it was
      // counted against — which is the base line ONLY while it has a ref to
      // name. `UpstreamSyncBadge` gates its own `dedupeToBase` on the base
      // name for the same reason: an unlabelled `Base:` is not the labelled
      // half, and deduping onto it would drop the clearer line for a vaguer
      // one. Where neither is named the upstream pair keeps the line, as it
      // does there.
      if (input.baseMatchesUpstream === true) {
        if (ref && baseLine !== undefined) return baseLine;
        return upstreamLine ?? baseLine;
      }
      // Outside the dedupe an unnamed base count still gets stated, which is
      // wider than the expanded badge goes — it drops a base relationship it
      // cannot name because the row around it has other lines to fall back on.
      // This tooltip is the only place a collapsed row says anything about the
      // drift, so a nameless count beats leaving the alarm unexplained.
      const lines = [upstreamLine, baseLine].filter((line): line is string => line !== undefined);
      return lines.length > 0 ? lines.join(" · ") : undefined;
    }
    case "none":
      return undefined;
  }
}
