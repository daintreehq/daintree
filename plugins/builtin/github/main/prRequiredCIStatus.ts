import type {
  GitHubPRCIStatus,
  GitHubPRCISummary,
  GitHubPRGlobalCISummary,
} from "../shared/types.js";
import type {
  CheckRun,
  CheckRunConclusion,
  CheckRunStatus,
} from "../../../../shared/types/forge.js";

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

// Known non-failing, non-pending bucket states for check runs and status contexts.
// Any state not in these sets or the failing/pending sets above is treated as
// unclassifiable (conservative against future GitHub enum additions).
const NON_FAILING_CHECK_STATES = new Set(["SUCCESS", "NEUTRAL", "SKIPPED", "COMPLETED"]);
const NON_FAILING_STATUS_STATES = new Set(["SUCCESS"]);

export interface RollupContextNode {
  __typename?: string;
  // CheckRun fields
  name?: string | null;
  status?: string | null;
  conclusion?: string | null;
  detailsUrl?: string | null;
  // StatusContext fields
  context?: string | null;
  state?: string | null;
  targetUrl?: string | null;
  // Shared
  isRequired?: boolean | null;
}

export interface DerivedCIResult {
  ciStatus: GitHubPRCIStatus | undefined;
  ciSummary: GitHubPRCISummary | undefined;
}

export function normalizeRawState(
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

// GitHub CheckRun conclusions that map onto a normalized conclusion. The two
// failing spellings the normalized vocabulary has no word for — STARTUP_FAILURE
// and STALE — fold into "failure", matching how FAILING_CHECK_CONCLUSIONS above
// already buckets them for the roll-up. Both derivations therefore agree on
// which checks are failing; only the wording differs.
const CHECK_CONCLUSION_MAP: Readonly<Record<string, CheckRunConclusion>> = {
  SUCCESS: "success",
  FAILURE: "failure",
  NEUTRAL: "neutral",
  CANCELLED: "cancelled",
  TIMED_OUT: "timed_out",
  ACTION_REQUIRED: "action_required",
  SKIPPED: "skipped",
  STARTUP_FAILURE: "failure",
  STALE: "failure",
};

// GitHub StatusContext states. Legacy commit statuses carry no separate
// lifecycle field, so the state alone decides both halves: EXPECTED is a status
// GitHub knows is coming but has not received, PENDING is one being reported.
const STATUS_STATE_MAP: Readonly<
  Record<string, { status: CheckRunStatus; conclusion?: CheckRunConclusion }>
> = {
  SUCCESS: { status: "completed", conclusion: "success" },
  FAILURE: { status: "completed", conclusion: "failure" },
  ERROR: { status: "completed", conclusion: "failure" },
  PENDING: { status: "in_progress" },
  EXPECTED: { status: "queued" },
};

const QUEUED_CHECK_STATUSES = new Set(["QUEUED", "WAITING", "PENDING", "REQUESTED"]);

/**
 * Normalize one rollup context node onto the cross-provider {@link CheckRun}
 * shape, or `null` when the node carries no usable name (nothing to report).
 *
 * Unrecognized values degrade rather than throw, matching how
 * {@link deriveGlobalCIStatus} treats unknown buckets: a conclusion this
 * vocabulary can't spell is omitted — never guessed as success or failure — and
 * an unknown lifecycle value reads as finished only when a conclusion proves it
 * is. A future GitHub enum addition therefore costs one field on one check
 * rather than the whole read, and the omission can't manufacture a false green
 * because {@link deriveRequiredCIStatus} still owns the merge verdict.
 */
export function mapRollupContextToCheckRun(node: RollupContextNode): CheckRun | null {
  const name = node.name?.trim() || node.context?.trim();
  if (!name) return null;

  const required = typeof node.isRequired === "boolean" ? node.isRequired : undefined;
  const detailsUrl = node.detailsUrl?.trim() || node.targetUrl?.trim() || undefined;

  // A node exposing `state` is a legacy StatusContext regardless of whether the
  // union member was named — an unknown __typename still maps by field shape.
  const rawState = node.state?.toUpperCase();
  if (rawState) {
    const mapped = STATUS_STATE_MAP[rawState];
    return {
      name,
      status: mapped?.status ?? "completed",
      ...(mapped?.conclusion ? { conclusion: mapped.conclusion } : {}),
      ...(required !== undefined ? { required } : {}),
      ...(detailsUrl ? { detailsUrl } : {}),
      rawData: node,
    };
  }

  const rawConclusion = node.conclusion?.toUpperCase();
  const conclusion = rawConclusion ? CHECK_CONCLUSION_MAP[rawConclusion] : undefined;
  const rawStatus = node.status?.toUpperCase();

  let status: CheckRunStatus;
  if (rawStatus === "COMPLETED") {
    status = "completed";
  } else if (rawStatus === "IN_PROGRESS") {
    status = "in_progress";
  } else if (rawStatus && QUEUED_CHECK_STATUSES.has(rawStatus)) {
    status = "queued";
  } else {
    // Missing or unrecognized lifecycle value: a reported conclusion is proof
    // the run finished; without one, "queued" understates progress but never
    // claims a run is done when it may still be going.
    status = rawConclusion ? "completed" : "queued";
  }

  return {
    name,
    status,
    ...(conclusion ? { conclusion } : {}),
    ...(required !== undefined ? { required } : {}),
    ...(detailsUrl ? { detailsUrl } : {}),
    rawData: node,
  };
}

export interface GlobalCIDeriveInput {
  checkRunCountsByState?: Array<{ state?: string | null; count?: number | null }> | null;
  statusContextCountsByState?: Array<{ state?: string | null; count?: number | null }> | null;
  checkRunCount?: number | null;
  statusContextCount?: number | null;
  mergeStateStatus?: string | null;
}

/**
 * Derive a global (non-required-filtered) CI status from the in-band aggregate
 * scalars on {@code statusCheckRollup.contexts}. Returns {@code ciStatus: undefined}
 * when the merge state is UNKNOWN (transient state on freshly-opened PRs).
 */
export function deriveGlobalCIStatus(input: GlobalCIDeriveInput): {
  ciStatus: GitHubPRCIStatus | undefined;
  ciSummary: GitHubPRGlobalCISummary | undefined;
} {
  if (input.mergeStateStatus === "UNKNOWN") {
    return { ciStatus: undefined, ciSummary: undefined };
  }

  const checkRunCount = input.checkRunCount ?? 0;
  const statusContextCount = input.statusContextCount ?? 0;

  let failingCount = 0;
  let pendingCount = 0;
  let unknownCount = 0;

  for (const bucket of input.checkRunCountsByState ?? []) {
    const state = bucket?.state?.toUpperCase();
    const count = bucket?.count ?? 0;
    if (state && FAILING_CHECK_CONCLUSIONS.has(state)) {
      failingCount += count;
    } else if (state && PENDING_CHECK_STATUSES.has(state)) {
      pendingCount += count;
    } else if (state && !NON_FAILING_CHECK_STATES.has(state)) {
      unknownCount += count;
    }
  }

  for (const bucket of input.statusContextCountsByState ?? []) {
    const state = bucket?.state?.toUpperCase();
    const count = bucket?.count ?? 0;
    if (state && FAILING_STATUS_STATES.has(state)) {
      failingCount += count;
    } else if (state && PENDING_STATUS_STATES.has(state)) {
      pendingCount += count;
    } else if (state && !NON_FAILING_STATUS_STATES.has(state)) {
      unknownCount += count;
    }
  }

  // BLOCKED is broader than CI — it can be triggered by required reviews,
  // stale branches, or other branch-protection rules with zero CI failures.
  // Treating it as FAILURE is a conservative signal that "something is wrong";
  // consumers should inspect failingCount to distinguish CI blocks from
  // non-CI blocks (failingCount === 0 means the block is not from CI).
  if (input.mergeStateStatus === "BLOCKED") {
    return {
      ciStatus: "FAILURE",
      ciSummary: { checkRunCount, statusContextCount, failingCount, pendingCount },
    };
  }

  const hasCounts = checkRunCount + statusContextCount > 0;
  const hasBuckets =
    (input.checkRunCountsByState?.length ?? 0) > 0 ||
    (input.statusContextCountsByState?.length ?? 0) > 0;

  let ciStatus: GitHubPRCIStatus | undefined;
  if (failingCount > 0) {
    ciStatus = "FAILURE";
  } else if (pendingCount > 0) {
    ciStatus = "PENDING";
  } else if (hasCounts && hasBuckets && unknownCount === 0) {
    // Only declare SUCCESS when all buckets are classified — unknown
    // bucket states from future GitHub enum additions must not produce
    // a false-green. Counts without bucket breakdowns are also unclassifiable.
    ciStatus = "SUCCESS";
  }

  const ciSummary: GitHubPRGlobalCISummary | undefined =
    ciStatus !== undefined
      ? { checkRunCount, statusContextCount, failingCount, pendingCount }
      : undefined;

  return { ciStatus, ciSummary };
}
