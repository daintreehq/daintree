import {
  BULK_RUN_LINGER_MS,
  bulkWorktreeRunNeedsAttention,
  isBulkWorktreeRunLive,
  type BulkWorktreeRunItem,
  type BulkWorktreeRunSnapshot,
} from "@shared/types/ipc/bulkWorktreeRuns";
import { pluralNoun, pluralize } from "@/lib/pluralize";

/**
 * How a bulk worktree run reads wherever it is shown (#17086): the toolbar
 * chip and its popover in every project view, and the inbox entry the view
 * that ran it files. Pure, so every view draws the same run the same way from
 * main's snapshot.
 *
 * "Created" means one thing throughout: the item's worktree exists on disk.
 * That count is also the progress, because it can only go up: a retry keeps
 * the worktrees it reuses, a cancel keeps what landed, and a terminal that
 * crashes after setup turns an item into a failure without un-creating it.
 * What happened after creation (setup, terminals, assignment) is reported
 * beside it, never folded into it.
 */

export type BulkRunTone = "live" | "success" | "warning" | "error" | "neutral";

export interface BulkRunFacts {
  total: number;
  /** Worktree exists on disk, whatever happened after. */
  created: number;
  /** Fully set up: worktree, terminals, assignment. */
  ready: number;
  failed: number;
  /** Failed with no worktree to show for it. */
  notCreated: number;
  /** Stopped (cancelled or interrupted) after its worktree landed. */
  partlySetUp: number;
  /** Stopped before its worktree landed. */
  notStarted: number;
  interrupted: number;
  inProgress: number;
  queued: number;
  /** In progress on a second or later automatic attempt at its step. */
  retryingStep: number;
  /** Unsettled items the user sent back through Retry failed. */
  retriedUnsettled: number;
  /** Unsettled items with no worktree yet: what can still move the created count. */
  toCreate: number;
  /** Unsettled items whose worktree exists, queued retries included: setup still to run. */
  settingUp: number;
}

/**
 * What a batch is doing right now. "setting-up" is the tail where nothing is
 * left to create, so the created count has stopped moving while work goes on;
 * a failed creation counts as settled, so it never holds a batch out of it.
 */
export type BulkRunActivity = "creating" | "setting-up" | "cancelling" | null;

export function bulkRunFacts(run: Pick<BulkWorktreeRunSnapshot, "items">): BulkRunFacts {
  const facts: BulkRunFacts = {
    total: run.items.length,
    created: 0,
    ready: 0,
    failed: 0,
    notCreated: 0,
    partlySetUp: 0,
    notStarted: 0,
    interrupted: 0,
    inProgress: 0,
    queued: 0,
    retryingStep: 0,
    retriedUnsettled: 0,
    toCreate: 0,
    settingUp: 0,
  };
  for (const item of run.items) {
    if (item.worktreeId) facts.created++;
    switch (item.stage) {
      case "succeeded":
        facts.ready++;
        break;
      case "failed":
        facts.failed++;
        if (!item.worktreeId) facts.notCreated++;
        break;
      case "cancelled":
      case "interrupted":
        if (item.stage === "interrupted") facts.interrupted++;
        if (item.worktreeId) facts.partlySetUp++;
        else facts.notStarted++;
        break;
      case "pending":
        facts.queued++;
        if ((item.retried ?? 0) > 0) facts.retriedUnsettled++;
        if (item.worktreeId) facts.settingUp++;
        else facts.toCreate++;
        break;
      default:
        facts.inProgress++;
        if (item.attempt > 1) facts.retryingStep++;
        if ((item.retried ?? 0) > 0) facts.retriedUnsettled++;
        if (item.worktreeId) facts.settingUp++;
        else facts.toCreate++;
    }
  }
  return facts;
}

export interface BulkRunSummary {
  tone: BulkRunTone;
  /** The batch's state in a few words: the popover title and the chip's label. */
  title: string;
  activity: BulkRunActivity;
  facts: BulkRunFacts;
  /** The counts in words, for the line under the bar. */
  detail: string;
  /** One reason every failure shares, said once instead of on every row. */
  sharedFailure: string | null;
  /** How the shared reason is introduced: "All 6 failed:" or "All 3 failures:". */
  sharedFailureLead: string | null;
}

/** "issue" or "pull request", for copy that names what the batch was given. */
export function bulkRunItemNoun(run: Pick<BulkWorktreeRunSnapshot, "mode">): string {
  return run.mode === "pr" ? "pull request" : "issue";
}

export function bulkRunNeedingAttention(facts: BulkRunFacts): number {
  return facts.failed + facts.interrupted;
}

export function summarizeBulkRun(run: BulkWorktreeRunSnapshot): BulkRunSummary {
  const facts = bulkRunFacts(run);
  // What happened after creation is nested in the created count, so the
  // parts that stand on their own add up to the total.
  const setupFailed = facts.failed - facts.notCreated;
  const settled = run.phase === "done" || run.phase === "cancelled";
  const activity: BulkRunActivity =
    run.phase === "cancelling"
      ? "cancelling"
      : run.phase !== "running"
        ? null
        : facts.toCreate > 0
          ? "creating"
          : facts.settingUp > 0
            ? "setting-up"
            : null;
  const nested: string[] = [];
  if (settled && setupFailed > 0) {
    nested.push(`${setupFailed} with setup ${pluralNoun(setupFailed, "failure")}`);
  }
  if (settled && facts.partlySetUp > 0) nested.push(`${facts.partlySetUp} not fully set up`);
  const createdNote = nested.length > 0 ? ` (${nested.join(", ")})` : "";
  const parts = [`${facts.created} of ${facts.total} created${createdNote}`];
  if (run.phase === "running") {
    // Once nothing is left to create the created count has stopped moving, so
    // say what still is rather than letting "10 of 10 created" read as done.
    if (activity === "setting-up") parts.push(`${facts.settingUp} setting up`);
    if (facts.retryingStep > 0) parts.push(`${facts.retryingStep} retrying`);
    if (facts.failed > 0) parts.push(`${facts.failed} failed`);
  } else if (run.phase === "cancelling") {
    if (facts.inProgress > 0) parts.push(`${facts.inProgress} finishing`);
    if (facts.queued > 0) parts.push(`${facts.queued} won't start`);
  } else {
    const neverCreated = (facts.created > 0 ? facts.notCreated : 0) + facts.notStarted;
    if (neverCreated > 0) parts.push(`${neverCreated} not created`);
  }
  const detail = parts.join(" · ");

  const failures = run.items.filter((item) => item.stage === "failed");
  const firstError = failures[0]?.error;
  const sharedFailure =
    failures.length > 1 &&
    firstError !== undefined &&
    failures.every(
      (item) => item.error === firstError && item.failedStep === failures[0]!.failedStep
    )
      ? firstError
      : null;

  const sharedFailureLead =
    sharedFailure === null
      ? null
      : facts.failed === facts.total
        ? `All ${facts.failed} failed:`
        : `All ${facts.failed} failures:`;
  const summary = (tone: BulkRunTone, title: string): BulkRunSummary => ({
    tone,
    title,
    activity,
    facts,
    detail,
    sharedFailure,
    sharedFailureLead,
  });

  if (run.phase === "running") {
    const unsettled = facts.inProgress + facts.queued;
    if (unsettled > 0 && facts.retriedUnsettled === unsettled) {
      return summary("live", `Retrying ${unsettled} failed`);
    }
    if (activity === "setting-up") return summary("live", "Finishing setup");
    return summary("live", "Creating worktrees");
  }
  if (run.phase === "cancelling") return summary("live", "Cancelling…");

  const attention = bulkRunNeedingAttention(facts);
  if (attention > 0 && facts.created === 0) {
    return summary("error", `Couldn't create ${pluralize(attention, "worktree")}`);
  }
  if (attention > 0) {
    // A mix says each outcome; "3 of 20 failed" would call an interruption a failure.
    return facts.failed > 0 && facts.interrupted > 0
      ? summary("warning", outcomeCounts(facts.failed, facts.interrupted))
      : summary("warning", `${attention} of ${facts.total} ${attentionVerb(facts)}`);
  }
  if (run.phase === "cancelled") return summary("neutral", "Creation cancelled");
  return summary("success", `${pluralize(facts.created, "worktree")} created`);
}

/** "3 failed", "1 interrupted", or "2 failed, 1 interrupted". */
function outcomeCounts(failed: number, interrupted: number): string {
  const parts: string[] = [];
  if (failed > 0) parts.push(`${failed} failed`);
  if (interrupted > 0) parts.push(`${interrupted} interrupted`);
  return parts.join(", ");
}

/** "failed", or "interrupted" when the view running it went away and nothing failed outright. */
export function attentionVerb(facts: BulkRunFacts): string {
  return facts.failed === 0 ? "interrupted" : "failed";
}

export function isItemInProgress(item: BulkWorktreeRunItem): boolean {
  switch (item.stage) {
    case "pending":
    case "succeeded":
    case "failed":
    case "cancelled":
    case "interrupted":
      return false;
    default:
      return true;
  }
}

/** Settled, with a worktree to go to. In-progress items get one once they finish. */
export function canOpenBulkRunItem(item: BulkWorktreeRunItem): boolean {
  return !!item.worktreeId && !isItemInProgress(item) && item.stage !== "pending";
}

/** What an item is doing, or what happened to it, in a few words. */
export function bulkRunItemStep(
  item: BulkWorktreeRunItem,
  mode: BulkWorktreeRunSnapshot["mode"],
  phase?: BulkWorktreeRunSnapshot["phase"]
): string {
  switch (item.stage) {
    case "pending":
      return phase === "cancelling" ? "Won't start" : "Queued";
    case "worktree-creating":
      return "Creating worktree…";
    case "worktree-created":
      return "Setting up…";
    case "terminals-spawning":
      return "Starting terminals…";
    case "terminals-error":
      return "Restarting terminals…";
    case "assigning":
      return mode === "pr" ? "Assigning…" : "Assigning issue…";
    case "verifying":
      return "Checking terminals…";
    case "worktree-error":
      return "Couldn't create worktree";
    case "succeeded":
      return "Created";
    case "failed":
      switch (item.failedStep) {
        case "terminals":
          return "Terminals didn't start";
        case "verification":
          return "Terminals exited";
        case "assignment":
          return "Couldn't assign issue";
        default:
          return "Couldn't create worktree";
      }
    case "cancelled":
      return item.worktreeId ? "Cancelled before setup finished" : "Cancelled";
    case "interrupted":
      return item.worktreeId ? "Interrupted before setup finished" : "Interrupted";
  }
}

/**
 * What wants the user first, then what is moving, then everything else in the
 * order it was picked. A row moves when it starts and when it settles, never
 * otherwise, so finished rows never shuffle among themselves.
 */
export function orderBulkRunItems(items: readonly BulkWorktreeRunItem[]): BulkWorktreeRunItem[] {
  const failed: BulkWorktreeRunItem[] = [];
  const moving: BulkWorktreeRunItem[] = [];
  const retrying: BulkWorktreeRunItem[] = [];
  const rest: BulkWorktreeRunItem[] = [];
  for (const item of items) {
    if (item.stage === "failed" || item.stage === "interrupted") failed.push(item);
    else if (isItemInProgress(item)) moving.push(item);
    // A retry's queue is part of what the user just asked for.
    else if (item.stage === "pending" && (item.retried ?? 0) > 0) retrying.push(item);
    else rest.push(item);
  }
  return [...failed, ...moving, ...retrying, ...rest];
}

function isLive(run: BulkWorktreeRunSnapshot): boolean {
  return run.controllable && isBulkWorktreeRunLive(run.phase);
}

/**
 * The batches in the live episode: the live ones, and every batch with a pass
 * that overlapped them, directly or through another (an ended
 * batch overlapping one that overlapped a live one still counts). Every pass
 * over a batch is its own interval, so a retry during the episode keeps the
 * batch linked to what it overlapped before, and a retry after the episode
 * ended starts a fresh one instead of reaching back to revive old batches.
 */
function liveEpisode(runs: readonly BulkWorktreeRunSnapshot[]): ReadonlySet<string> {
  if (!runs.some(isLive)) return new Set();
  const intervals = runs
    .flatMap((run) => {
      const passes = run.executions?.length ? run.executions : [{ startedAt: run.startedAt }];
      return passes.map((pass, index) => ({
        id: run.runId,
        start: pass.startedAt,
        end:
          pass.endedAt ??
          (index === passes.length - 1 && isLive(run) ? Number.POSITIVE_INFINITY : run.updatedAt),
      }));
    })
    .sort((a, b) => a.start - b.start);
  // Every live interval runs to the open end, so they all merge into the last
  // group, along with whatever chains into it.
  let group: string[] = [];
  let groupEnd = Number.NEGATIVE_INFINITY;
  for (const interval of intervals) {
    if (interval.start > groupEnd) group = [];
    group.push(interval.id);
    groupEnd = Math.max(groupEnd, interval.end);
  }
  return new Set(group);
}

/**
 * The batches to show at `now`, oldest first. A live batch shows, and so does
 * one that ended wanting attention, until it is retried or dismissed. One that
 * ended cleanly lingers, then retires to the inbox, except that while the
 * live episode it belongs to goes on it stays, so the chip's running total
 * never loses a batch mid-count.
 */
export function shownBulkRuns(
  runs: readonly BulkWorktreeRunSnapshot[],
  now: number
): BulkWorktreeRunSnapshot[] {
  const episode = liveEpisode(runs);
  return runs
    .filter((run) => {
      if (isLive(run) || bulkWorktreeRunNeedsAttention(run)) return true;
      if (now - run.updatedAt < BULK_RUN_LINGER_MS) return true;
      return episode.has(run.runId);
    })
    .sort((a, b) => a.startedAt - b.startedAt);
}

/** When the next lingering batch retires, for a timer to re-check at. */
export function nextBulkRunRetireAt(
  runs: readonly BulkWorktreeRunSnapshot[],
  now: number
): number | null {
  let next: number | null = null;
  for (const run of runs) {
    if (isLive(run) || bulkWorktreeRunNeedsAttention(run)) continue;
    const at = run.updatedAt + BULK_RUN_LINGER_MS;
    if (at > now && (next === null || at < next)) next = at;
  }
  return next;
}

export interface BulkRunChip {
  tone: BulkRunTone;
  label: string;
  /**
   * "9/20": worktrees created out of the batches counting, while something is
   * live. Once nothing is left to create it says what is left to set up
   * instead ("4 left"), since a count that has stopped would read as done.
   */
  count: string | null;
  created: number;
  total: number;
  /**
   * Whether `created / total` can be drawn as a gauge: one batch, still
   * creating. A second batch joining changes the denominator, which would pull
   * the fill backwards; in the setup tail or a cancel the fill can no longer
   * move, so it would sit there looking stuck. The count carries those alone.
   */
  gauge: boolean;
  /** Items that failed or were cut short, in any shown batch, while another is live. */
  attention: number;
  /** The whole state as one sentence, for the trigger's accessible name. */
  ariaLabel: string;
}

/**
 * The toolbar chip across every shown batch: live work leads, then what wants
 * attention. `projectName` is set when every shown batch belongs to another
 * project, so the accessible name can say whose they are; the visible chip
 * stays project-neutral.
 */
export function summarizeBulkRunChip(
  runs: readonly BulkWorktreeRunSnapshot[],
  projectName?: string
): BulkRunChip | null {
  if (runs.length === 0) return null;
  const summaries = runs.map(summarizeBulkRun);
  const where = projectName ? ` in ${projectName}` : "";
  const batches = runs.length > 1 ? `, ${pluralize(runs.length, "batch", "batches")}` : "";
  const attention = summaries.reduce((sum, s) => sum + bulkRunNeedingAttention(s.facts), 0);
  const live = summaries.filter((s) => s.tone === "live");

  if (live.length > 0) {
    // Every batch that ran alongside the live ones counts, however it ended,
    // so one finishing (or failing) never shrinks the count mid-episode.
    const episode = liveEpisode(runs);
    let created = 0;
    let total = 0;
    let episodeBatches = 0;
    runs.forEach((run, index) => {
      if (!episode.has(run.runId)) return;
      episodeBatches++;
      created += summaries[index]!.facts.created;
      total += summaries[index]!.facts.total;
    });
    // Once nothing can be created the created count has stopped, so the tail
    // counts what is still running instead: setup, and a cancel's in-flight items.
    const cancelling = live.filter((s) => s.activity === "cancelling").length;
    const tail = !live.some((s) => s.activity === "creating") && cancelling < live.length;
    const left = live.reduce(
      (sum, s) => sum + (s.activity === "cancelling" ? s.facts.inProgress : s.facts.settingUp),
      0
    );
    // Batches in different states share a label for what the episode as a
    // whole is doing: creating while anything still can, else the tail.
    const label = live.every((s) => s.title === live[0]!.title)
      ? live[0]!.title
      : live.some((s) => s.activity === "creating")
        ? "Creating worktrees"
        : live.every((s) => s.activity === "cancelling")
          ? "Cancelling…"
          : "Finishing setup";
    const tailNote = tail ? `, ${left} still ${cancelling > 0 ? "finishing" : "setting up"}` : "";
    const cancelNote =
      cancelling > 0 && cancelling < live.length
        ? `, ${pluralize(cancelling, "batch", "batches")} cancelling`
        : "";
    return {
      tone: "live",
      label,
      count: tail ? `${left} left` : `${created}/${total}`,
      created,
      total,
      gauge: episodeBatches === 1 && live[0]!.activity === "creating",
      attention,
      ariaLabel: `${label}${where}, ${created} of ${total} created${tailNote}${cancelNote}${batches}${attentionNote(summaries)}`,
    };
  }

  const waiting = summaries.filter((s) => s.tone === "warning" || s.tone === "error");
  if (waiting.length > 0) {
    const allFailed = waiting.every((s) => s.tone === "error");
    let failed = 0;
    let interrupted = 0;
    for (const s of waiting) {
      failed += s.facts.failed;
      interrupted += s.facts.interrupted;
    }
    const label = allFailed
      ? `Couldn't create ${pluralize(attention, "worktree")}`
      : `Worktrees · ${outcomeCounts(failed, interrupted)}`;
    // Spoken as shown, so the visible words work as a voice command.
    const spoken = label.replace(" · ", ", ");
    return {
      tone: allFailed ? "error" : "warning",
      label,
      count: null,
      created: 0,
      total: 0,
      gauge: false,
      attention: 0,
      ariaLabel: `${spoken}${where}${batches}`,
    };
  }

  const latest = summaries[summaries.length - 1]!;
  return {
    tone: latest.tone,
    label: latest.title,
    count: null,
    created: 0,
    total: 0,
    gauge: false,
    attention: 0,
    ariaLabel: `${latest.title}${where}${batches}`,
  };
}

/** ", 2 failed, 1 interrupted": what wants attention, each outcome named. */
function attentionNote(summaries: readonly BulkRunSummary[]): string {
  let failed = 0;
  let interrupted = 0;
  for (const s of summaries) {
    failed += s.facts.failed;
    interrupted += s.facts.interrupted;
  }
  const counts = outcomeCounts(failed, interrupted);
  return counts ? `, ${counts}` : "";
}

/** The batch the popover opens on: what wants attention, else the newest live one, else the newest. */
export function defaultBulkRunId(runs: readonly BulkWorktreeRunSnapshot[]): string | null {
  const attention = runs.find(bulkWorktreeRunNeedsAttention);
  if (attention) return attention.runId;
  const live = runs.filter(isLive);
  if (live.length > 0) return live[live.length - 1]!.runId;
  return runs[runs.length - 1]?.runId ?? null;
}

/** The sentence a screen reader hears when a batch starts or ends. Milestones only. */
export function bulkRunMilestone(
  previous: BulkWorktreeRunSnapshot | undefined,
  next: BulkWorktreeRunSnapshot
): string | null {
  const wasLive = previous ? isBulkWorktreeRunLive(previous.phase) : false;
  const isNowLive = isBulkWorktreeRunLive(next.phase);
  const noun = bulkRunItemNoun(next);
  if (isNowLive && !wasLive) {
    const summary = summarizeBulkRun(next);
    if (previous) return `${summary.title}. Progress is in the toolbar.`;
    return `Creating ${pluralize(next.items.length, "worktree")} for ${pluralize(next.items.length, noun)}. Progress is in the toolbar.`;
  }
  if (!isNowLive && wasLive) {
    const summary = summarizeBulkRun(next);
    return `${summary.title}. ${summary.detail}`;
  }
  return null;
}

/** "#12, #14 and #15", or "#12, #14, #15 and 17 more" past a handful. */
export function describeBulkRunNumbers(numbers: readonly number[]): string {
  const shown = numbers.slice(0, numbers.length > 4 ? 3 : 4).map((n) => `#${n}`);
  const more = numbers.length - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  if (shown.length === 1) return shown[0]!;
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}
