import type { GitHubPRCIStatus, GitHubPRCISummary } from "../../../shared/types/github.js";

// Failing CheckRun conclusions per GitHub schema. STALE is included because a stale required
// run has not resolved to a passing state and must not be silently treated as success.
const FAILING_CHECK_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "CANCELLED",
  "STARTUP_FAILURE",
  "STALE",
]);

// Failing StatusContext states per GitHub schema
const FAILING_STATUS_STATES = new Set(["ERROR", "FAILURE"]);

// Pending CheckRun statuses (the CheckRun.status field, not conclusion)
const PENDING_CHECK_STATUSES = new Set([
  "QUEUED",
  "IN_PROGRESS",
  "WAITING",
  "PENDING",
  "REQUESTED",
]);

// Pending StatusContext states
const PENDING_STATUS_STATES = new Set(["PENDING", "EXPECTED"]);

export interface RollupContextNode {
  __typename?: string;
  // CheckRun fields
  status?: string | null;
  conclusion?: string | null;
  // StatusContext fields
  state?: string | null;
  // Shared
  isRequired?: boolean | null;
}

export interface DerivedCIResult {
  ciStatus: GitHubPRCIStatus | undefined;
  ciSummary: GitHubPRCISummary | undefined;
}

function normalizeRawState(
  rawRollupState: string | null | undefined
): GitHubPRCIStatus | undefined {
  if (!rawRollupState) return undefined;
  const upper = rawRollupState.toUpperCase();
  if (
    upper === "SUCCESS" ||
    upper === "FAILURE" ||
    upper === "ERROR" ||
    upper === "PENDING" ||
    upper === "EXPECTED"
  ) {
    return upper;
  }
  return undefined;
}

/**
 * Derive an effective CI status and summary from a rollup's contexts list,
 * filtering to only required checks.
 *
 * Returns the raw rollup status and no summary when:
 * - contexts page is truncated (hasNextPage) — avoids false-greens from unseen required checks
 * - the contexts list is null/undefined — no data to enrich
 * - no required contexts are present in a full page — repos without branch protection have
 *   no "required" / "non-required" distinction, so the raw rollup is the right signal
 */
export function deriveRequiredCIStatus(
  contexts: RollupContextNode[] | null | undefined,
  hasNextPage: boolean,
  rawRollupState: string | null | undefined
): DerivedCIResult {
  const rawCiStatus = normalizeRawState(rawRollupState);

  if (!contexts) {
    return { ciStatus: rawCiStatus, ciSummary: undefined };
  }

  if (hasNextPage) {
    // Page truncated; cannot know all required checks — keep raw status, no summary.
    return { ciStatus: rawCiStatus, ciSummary: undefined };
  }

  let requiredTotal = 0;
  let requiredFailing = 0;
  let requiredPending = 0;

  for (const ctx of contexts) {
    if (!ctx?.isRequired) continue;
    requiredTotal++;

    const typename = ctx.__typename;
    if (typename === "CheckRun") {
      const conclusion = ctx.conclusion?.toUpperCase();
      const status = ctx.status?.toUpperCase();
      if (conclusion && FAILING_CHECK_CONCLUSIONS.has(conclusion)) {
        requiredFailing++;
      } else if (!conclusion && status && PENDING_CHECK_STATUSES.has(status)) {
        requiredPending++;
      }
    } else if (typename === "StatusContext") {
      const state = ctx.state?.toUpperCase();
      if (state && FAILING_STATUS_STATES.has(state)) {
        requiredFailing++;
      } else if (state && PENDING_STATUS_STATES.has(state)) {
        requiredPending++;
      }
    } else {
      // Unknown union member — treat a non-success conclusion/state as failure conservatively
      const conclusion = ctx.conclusion?.toUpperCase();
      const state = ctx.state?.toUpperCase();
      if (conclusion && FAILING_CHECK_CONCLUSIONS.has(conclusion)) {
        requiredFailing++;
      } else if (state && FAILING_STATUS_STATES.has(state)) {
        requiredFailing++;
      }
    }
  }

  if (requiredTotal === 0) {
    // No required checks configured — fall back to the raw rollup state so the indicator
    // reflects actual CI health. A zeroed summary would mask real failures by forcing the
    // tooltip down the "No required checks" path even when checks are red or in-flight.
    return { ciStatus: rawCiStatus, ciSummary: undefined };
  }

  const summary: GitHubPRCISummary = { requiredTotal, requiredFailing, requiredPending };

  let ciStatus: GitHubPRCIStatus;
  if (requiredFailing > 0) {
    ciStatus = "FAILURE";
  } else if (requiredPending > 0) {
    ciStatus = "PENDING";
  } else {
    ciStatus = "SUCCESS";
  }

  return { ciStatus, ciSummary: summary };
}
