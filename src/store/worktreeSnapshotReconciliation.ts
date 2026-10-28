import type { WorktreeSnapshot, WorktreeEventVersion } from "@shared/types";
import type { IssueProvenance } from "@shared/types/ipc/worktree";
import { issueNumberBelongsToLinkedPr } from "@shared/utils/worktreeIssueProjection";
import { mergeIntentEqual } from "@shared/utils/prMergeIntent";

/**
 * How long a `worktree-removed` tombstone suppresses a late `worktree-update`
 * for the same id within the same epoch. A removal followed by a buffered
 * update from the same host run could otherwise resurrect a deleted row. The
 * host reconnect/restart budget is ~14s; 30s gives 2x headroom and tombstones
 * are cleared outright on epoch transition (a host rebuild starts clean).
 */
export const TOMBSTONE_TTL_MS = 30_000;

/**
 * A removed worktree's suppression record. `generation` is the torn-down
 * monitor's incarnation stamp; an update carrying a strictly higher one is a
 * genuine re-creation at the same path and must be let through, while a late
 * buffered update from the removed monitor carries the same stamp and stays
 * suppressed (#11994). `removedAt` remains the fallback for unstamped events.
 */
export interface WorktreeTombstone {
  removedAt: number;
  generation?: number;
}

/**
 * How long a *stamped* tombstone is kept. Unlike {@link TOMBSTONE_TTL_MS} this
 * is not a correctness window — the incarnation comparison decides those cases
 * algebraically — it only stops fences accumulating for the life of an epoch.
 * The bound worth clearing is the longest a torn-down monitor can still emit:
 * a queued git-status pass is capped at 60s by the host's own poll-queue
 * timeout, so ten minutes is two orders of magnitude of headroom over the
 * thing it has to outlive. Counting entries instead would be wrong — evicting
 * by volume can drop a fence whose monitor has not gone quiet yet.
 */
export const FENCE_TTL_MS = 10 * 60_000;

/**
 * Drop the tombstones a host snapshot has settled. An id the host still reports
 * is alive by definition, and an unstamped tombstone has no incarnation to
 * compare against so the snapshot is the last word on it. A stamped one for an
 * id the host does NOT report stays: the removal it records is still in force,
 * and dropping it would let a poll that outlived the removal resurrect the row
 * (the pre-existing #8403 hole the incarnation stamp finally closes).
 */
export function retainTombstoneFences(
  tombstones: ReadonlyMap<string, WorktreeTombstone>,
  liveIds: ReadonlySet<string>
): Map<string, WorktreeTombstone> {
  const next = new Map<string, WorktreeTombstone>();
  for (const [id, tombstone] of tombstones) {
    if (tombstone.generation !== undefined && !liveIds.has(id)) next.set(id, tombstone);
  }
  return next;
}

/**
 * Order two host-minted version stamps. A differing epoch means the events
 * came from different host runs — UUIDv4 epochs carry no ordering, so a new
 * epoch always wins (the renderer re-hydrates from the fresh host). Within an
 * epoch, the higher `seq` wins.
 *
 * Returns <0 only when `incoming` is strictly older than `current`. Callers
 * gate on `compareVersion(...) < 0` (reject), so an EQUAL same-epoch stamp is
 * accepted: `get-all-states` reports the host's current high-water `seq`
 * without advancing it, so a snapshot that races the event sitting at that
 * same `seq` is the host's authoritative state at that boundary — applying it
 * is idempotent, never a revert (#8403 review).
 */
export function compareVersion(
  incoming: WorktreeEventVersion,
  current: WorktreeEventVersion
): number {
  if (incoming.epoch !== current.epoch) return 1;
  return incoming.seq - current.seq;
}

/**
 * A user-attached worktree→issue association held in the renderer alongside
 * the snapshot map. The authoritative copy lives in the Electron store
 * (`worktreeIssueMap`); this slice mirrors it so that `worktree-update` events
 * — which carry only auto-detected (branch-name) issue state — don't clobber
 * manual associations between cold hydrations.
 */
export interface ManualIssueAssociation extends IssueProvenance {
  issueNumber: number;
  issueTitle?: string;
}

/**
 * The directories behind one `workingTreeChangedAt` stamp, with enough
 * continuity information for a consumer to tell whether it has seen every
 * burst since the one it last acted on (#12244).
 */
export interface WorktreeChangedDirs {
  /** The `workingTreeChangedAt` stamp these directories describe. */
  readonly at: number;
  /**
   * The stamp this record superseded, or `null` when that is unknown — an
   * authoritative snapshot catching up, or the first record for this worktree.
   *
   * This is the whole skipped-burst defence. The store sees every host event in
   * order, but React can batch two of them into one render, and the consumer
   * would then see only the newer record. Comparing this against the stamp it
   * last consumed tells it a burst went by unseen, so it falls back to a full
   * re-read instead of scoping to a set that is missing the older burst's
   * directories.
   */
  readonly previousAt: number | null;
  /**
   * Worktree-relative directories (`""` = the worktree root), or `null` when
   * the burst could not be described and everything must be re-read.
   */
  readonly dirs: readonly string[] | null;
  /**
   * The host run this record belongs to. Continuity is only ever claimed within
   * one run: across a host restart (new epoch) or a re-created worktree at the
   * same path (new generation), whatever changed on disk in between reached
   * nobody, so the chain has to break.
   *
   * Carried on the record rather than tested against the incoming event,
   * because only the FIRST event of a new epoch sees the transition — a later
   * one in the same run would find `epochChanged` false and chain straight back
   * onto the dead run's stamp.
   */
  readonly run: string;
}

/** The host run a snapshot belongs to: its epoch plus the worktree's incarnation. */
export function runKeyFor(snapshot: WorktreeSnapshot, epoch: string): string {
  return `${epoch}\u0000${snapshot.generation ?? ""}`;
}

/**
 * Fold one snapshot's working-tree-change fields into the side map, chaining
 * `previousAt` off whatever the map already held for this worktree. Returns the
 * previous map identity unchanged when the stamp has not moved, so a quiet
 * snapshot notifies no subscriber.
 *
 * `continuous` is false for the authoritative full-snapshot path, which can
 * jump across host events the store never saw individually. A run change breaks
 * continuity regardless of what the caller claims.
 */
export function mergeChangedDirs(
  current: Map<string, WorktreeChangedDirs>,
  snapshot: WorktreeSnapshot,
  epoch: string,
  continuous: boolean
): Map<string, WorktreeChangedDirs> {
  const { workingTreeChangedAt: at } = snapshot;
  if (at === undefined) return current;
  const run = runKeyFor(snapshot, epoch);
  const existing = current.get(snapshot.id);
  // Only a record from the SAME host run can be compared against or chained
  // off. One from a dead run is not "older" — it describes a different
  // timeline, so it neither dedups nor rejects nor supplies a predecessor.
  const previous = existing !== undefined && existing.run === run ? existing : undefined;
  if (previous !== undefined) {
    if (previous.at === at) return current;
    // A strictly older stamp is never a new burst — it is a stale one being
    // replayed. Renderer-built PR/issue overlays spread the CACHED snapshot,
    // whose fs stamp goes stale the moment a timestamp-only update takes the
    // `snapshotsEqual` fast path and leaves that object in place. Letting one
    // walk the record backwards would reconnect the continuity chain across a
    // burst that was never seen, and the consumer would scope past it.
    if (at < previous.at) return current;
  }
  // A record with no same-run predecessor is written once per run transition
  // and reports `previousAt: null`, which is what actually stops the consumer
  // scoping off it. The directories stay faithful to what the host said.
  const next = new Map(current);
  next.set(snapshot.id, {
    at,
    previousAt: continuous ? (previous?.at ?? null) : null,
    // Absent on the wire means the host described no burst for this stamp,
    // which is not the same as a burst that touched nothing — both must reach
    // the consumer as "re-read everything".
    dirs: snapshot.workingTreeChangedDirs ?? null,
    run,
  });
  return next;
}

/**
 * Reconcile the issue fields of an incoming snapshot with what the renderer
 * already knows. Two concerns, both from #8079:
 *
 *  1. **Title flicker** — when the issue number is unchanged but the incoming
 *     snapshot dropped the title (the main process resets it to `undefined`
 *     while it re-fetches the GitHub title after a poll), keep the previous
 *     title so `IssueBadge` doesn't flash the raw `#NNN` for ~100–500ms.
 *     A genuine issue-number change clears the title immediately — the old
 *     title belongs to the old issue.
 *
 *  2. **MANUAL_OVER_AUTO** — an explicit user-attached issue association
 *     always overrides the auto-detected (branch-name) issue. Explicit user
 *     intent beats the heuristic, matching mainstream issue-tracker UX. This
 *     is a deliberate inversion of the old `if (assoc && !issueNumber)`
 *     fallback behaviour (manual was previously only a last resort).
 */
export function mergeIssueState(
  incoming: WorktreeSnapshot,
  existing: WorktreeSnapshot | undefined,
  manual: ManualIssueAssociation | undefined
): WorktreeSnapshot {
  let issueNumber = incoming.issueNumber;
  let issueTitle = incoming.issueTitle;
  // Provenance travels with the number it describes (#13744): replaced
  // together, cleared together, never left on a number it didn't come with.
  let provenance = pickIssueProvenance(incoming);

  if (
    existing &&
    issueNumber !== undefined &&
    issueNumber === existing.issueNumber &&
    incoming.issueProviderId === existing.issueProviderId &&
    incoming.issueKey === existing.issueKey &&
    issueTitle === undefined &&
    existing.issueTitle !== undefined
  ) {
    issueTitle = existing.issueTitle;
  }

  // `linked: undefined` from the host means "PR service hasn't run yet" —
  // preserve whatever the renderer already has (e.g. `linked.pr` from a
  // prior session's `pr-detected` event). `linked: null` is an explicit
  // clear (branch switch) and must propagate. (#8870 regression from #8452.)
  const linked =
    incoming.linked === undefined && existing?.linked !== undefined
      ? existing.linked
      : incoming.linked;

  // The host already drops an issue number its linked GitHub PR carries, but
  // the `pr-detected` overlay re-adds the raw candidate number the event was
  // sent with. Applied before the manual override so an explicit association
  // still wins (#12381).
  if (issueNumberBelongsToLinkedPr(issueNumber, linked, provenance.issueProviderId)) {
    issueNumber = undefined;
    issueTitle = undefined;
    provenance = {};
  }

  // MANUAL_OVER_AUTO: explicit user association wins over auto-detection.
  if (manual) {
    issueNumber = manual.issueNumber;
    issueTitle = manual.issueTitle;
    provenance = pickIssueProvenance(manual);
  }

  if (
    issueNumber === incoming.issueNumber &&
    issueTitle === incoming.issueTitle &&
    provenance.issueProviderId === incoming.issueProviderId &&
    provenance.issueId === incoming.issueId &&
    provenance.issueKey === incoming.issueKey &&
    linked === incoming.linked
  ) {
    return incoming;
  }
  return {
    ...incoming,
    issueNumber,
    issueTitle,
    issueProviderId: provenance.issueProviderId,
    issueId: provenance.issueId,
    issueKey: provenance.issueKey,
    linked,
  };
}

/** The {@link IssueProvenance} fields of a link or snapshot, absent ones omitted. */
export function pickIssueProvenance(source: IssueProvenance): IssueProvenance {
  return {
    ...(source.issueProviderId ? { issueProviderId: source.issueProviderId } : {}),
    ...(source.issueId ? { issueId: source.issueId } : {}),
    ...(source.issueKey ? { issueKey: source.issueKey } : {}),
  };
}

export function snapshotsEqual(a: WorktreeSnapshot, b: WorktreeSnapshot): boolean {
  return (
    // Compared so a new incarnation of the same path is never collapsed as
    // value-equal — the row must adopt the newer stamp or the fence in
    // `applyUpdate` would keep judging against the dead monitor's (#11994).
    a.generation === b.generation &&
    a.branch === b.branch &&
    a.path === b.path &&
    a.name === b.name &&
    a.isCurrent === b.isCurrent &&
    a.isMainWorktree === b.isMainWorktree &&
    a.modifiedCount === b.modifiedCount &&
    a.summary === b.summary &&
    a.mood === b.mood &&
    a.aiNote === b.aiNote &&
    a.aiNoteTimestamp === b.aiNoteTimestamp &&
    a.lastActivityTimestamp === b.lastActivityTimestamp &&
    a.prNumber === b.prNumber &&
    a.prUrl === b.prUrl &&
    a.prState === b.prState &&
    a.prCiStatus === b.prCiStatus &&
    a.prTitle === b.prTitle &&
    a.issueNumber === b.issueNumber &&
    a.issueTitle === b.issueTitle &&
    a.issueProviderId === b.issueProviderId &&
    a.issueId === b.issueId &&
    a.issueKey === b.issueKey &&
    a.branchDerivedTitle === b.branchDerivedTitle &&
    a.sourcePrNumber === b.sourcePrNumber &&
    a.prLastUpdatedAt === b.prLastUpdatedAt &&
    a.issueLastUpdatedAt === b.issueLastUpdatedAt &&
    a.hasPlanFile === b.hasPlanFile &&
    a.planFilePath === b.planFilePath &&
    a.aheadCount === b.aheadCount &&
    a.behindCount === b.behindCount &&
    a.upstreamRef === b.upstreamRef &&
    a.upstreamHeadSha === b.upstreamHeadSha &&
    a.baseBranchName === b.baseBranchName &&
    a.baseAheadCount === b.baseAheadCount &&
    a.baseBehindCount === b.baseBehindCount &&
    a.baseMatchesUpstream === b.baseMatchesUpstream &&
    a.baseCompareRef === b.baseCompareRef &&
    // lastGitStatusCheckedAt, workingTreeChangedAt and workingTreeChangedDirs
    // are deliberately NOT compared (like `timestamp`): all advance on events
    // that change nothing else in the snapshot, so comparing any of them here
    // would force a new worktrees Map identity per quiet tick. They live in the
    // store's `statusCheckedAt` / `workingTreeChangedAtById` /
    // `workingTreeChangedDirsById` side maps instead.
    a.lastFetchedAt === b.lastFetchedAt &&
    a.fetchAuthFailed === b.fetchAuthFailed &&
    a.fetchNetworkFailed === b.fetchNetworkFailed &&
    a.hasRemote === b.hasRemote &&
    a.isFetchInFlight === b.isFetchInFlight &&
    a.matchedForgeProviderId === b.matchedForgeProviderId &&
    a.worktreeMode === b.worktreeMode &&
    a.worktreeEnvironmentLabel === b.worktreeEnvironmentLabel &&
    a.hasResourceConfig === b.hasResourceConfig &&
    a.hasStatusCommand === b.hasStatusCommand &&
    a.hasProvisionCommand === b.hasProvisionCommand &&
    a.hasPauseCommand === b.hasPauseCommand &&
    a.hasResumeCommand === b.hasResumeCommand &&
    a.hasTeardownCommand === b.hasTeardownCommand &&
    a.resourceConnectCommand === b.resourceConnectCommand &&
    a.lifecycleCommandsNeedApproval === b.lifecycleCommandsNeedApproval &&
    a.isExternal === b.isExternal &&
    a.isWslPath === b.isWslPath &&
    a.wslDistro === b.wslDistro &&
    a.wslPosixPath === b.wslPosixPath &&
    a.wslGitEligible === b.wslGitEligible &&
    a.wslGitOptIn === b.wslGitOptIn &&
    a.wslGitDismissed === b.wslGitDismissed &&
    a.repoState === b.repoState &&
    a.isDetached === b.isDetached &&
    a.head === b.head &&
    resourceStatusEqual(a.resourceStatus, b.resourceStatus) &&
    attachmentsEqual(a.attachments, b.attachments) &&
    worktreeChangesEqual(a.worktreeChanges, b.worktreeChanges) &&
    lifecycleStatusEqual(a.lifecycleStatus, b.lifecycleStatus) &&
    setupStatusEqual(a.setupStatus, b.setupStatus) &&
    lifecyclePhaseResultsEqual(a.lifecyclePhaseResults, b.lifecyclePhaseResults) &&
    linkedEqual(a.linked ?? null, b.linked ?? null)
  );
}

function resourceStatusEqual(
  a: WorktreeSnapshot["resourceStatus"],
  b: WorktreeSnapshot["resourceStatus"]
): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return (
    a.lastStatus === b.lastStatus &&
    a.provider === b.provider &&
    a.endpoint === b.endpoint &&
    a.ssh === b.ssh &&
    a.lastCheckedAt === b.lastCheckedAt &&
    a.lastOutput === b.lastOutput &&
    a.error === b.error &&
    a.resumedAt === b.resumedAt &&
    a.pausedAt === b.pausedAt
  );
}

function attachmentsEqual(
  a: WorktreeSnapshot["attachments"],
  b: WorktreeSnapshot["attachments"]
): boolean {
  if (a === b) return true;
  if (a == null || b == null || a.length !== b.length) return false;
  // Small, flat and host-built in a fixed key order, so its JSON is its value.
  return JSON.stringify(a) === JSON.stringify(b);
}

function worktreeChangesEqual(
  a: WorktreeSnapshot["worktreeChanges"],
  b: WorktreeSnapshot["worktreeChanges"]
): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  // The timestamp shortcut has to yield to `headOid`: two polls landing in the
  // same millisecond with different HEADs would otherwise keep the stale
  // identity, and the divergence backstop reads HEAD off this snapshot.
  if (a.lastUpdated !== undefined && a.lastUpdated === b.lastUpdated && a.headOid === b.headOid) {
    return true;
  }
  return (
    a.changedFileCount === b.changedFileCount &&
    a.changes.length === b.changes.length &&
    a.totalInsertions === b.totalInsertions &&
    a.totalDeletions === b.totalDeletions &&
    a.latestFileMtime === b.latestFileMtime &&
    // The divergence backstop reads `headOid` off this snapshot, so a HEAD that
    // moves without changing any other field here still has to churn identity.
    a.headOid === b.headOid &&
    a.lastCommitMessage === b.lastCommitMessage &&
    a.lastCommitBody === b.lastCommitBody &&
    a.lastCommitTimestampMs === b.lastCommitTimestampMs &&
    a.lastCommitAuthor?.name === b.lastCommitAuthor?.name &&
    a.lastCommitAuthor?.email === b.lastCommitAuthor?.email
  );
}

function lifecycleStatusEqual(
  a: WorktreeSnapshot["lifecycleStatus"],
  b: WorktreeSnapshot["lifecycleStatus"]
): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return (
    a.phase === b.phase &&
    a.state === b.state &&
    a.currentCommand === b.currentCommand &&
    a.commandIndex === b.commandIndex &&
    a.totalCommands === b.totalCommands &&
    a.startedAt === b.startedAt &&
    a.completedAt === b.completedAt &&
    a.error === b.error
  );
}

/**
 * Compared in `snapshotsEqual` because a setup transition is the only change
 * some snapshots carry — a worktree whose config copy finished is otherwise
 * byte-identical to the pending one, and folding it out would leave
 * `worktree.waitUntilReady` waiting on a row that never updates.
 */
function setupStatusEqual(
  a: WorktreeSnapshot["setupStatus"],
  b: WorktreeSnapshot["setupStatus"]
): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return (
    a.state === b.state &&
    a.stage === b.stage &&
    a.startedAt === b.startedAt &&
    a.completedAt === b.completedAt &&
    a.error === b.error &&
    setupPluginStepsEqual(a.pluginSteps, b.pluginSteps)
  );
}

/** A plugin step moving from running to failed is, on its own, a whole update. */
function setupPluginStepsEqual(
  a: NonNullable<WorktreeSnapshot["setupStatus"]>["pluginSteps"],
  b: NonNullable<WorktreeSnapshot["setupStatus"]>["pluginSteps"]
): boolean {
  if (a === b) return true;
  if (a == null || b == null || a.length !== b.length) return false;
  return a.every((step, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      step.pluginId === other.pluginId &&
      step.stepId === other.stepId &&
      step.label === other.label &&
      step.pluginName === other.pluginName &&
      step.state === other.state &&
      step.error === other.error
    );
  });
}

function lifecyclePhaseResultsEqual(
  a: WorktreeSnapshot["lifecyclePhaseResults"],
  b: WorktreeSnapshot["lifecyclePhaseResults"]
): boolean {
  if (a === b) return true;
  // getSnapshot omits the field when empty, so treat undefined and [] alike.
  const al = a?.length ?? 0;
  const bl = b?.length ?? 0;
  if (al !== bl) return false;
  if (al === 0) return true;
  for (let i = 0; i < al; i++) {
    const x = a![i]!;
    const y = b![i]!;
    if (
      x.phase !== y.phase ||
      x.state !== y.state ||
      x.category !== y.category ||
      x.exitCode !== y.exitCode ||
      x.signalName !== y.signalName ||
      x.error !== y.error ||
      x.startedAt !== y.startedAt ||
      x.completedAt !== y.completedAt ||
      x.timedOut !== y.timedOut ||
      x.aborted !== y.aborted
    ) {
      return false;
    }
  }
  return true;
}

// Counts are rendered on the card, so a re-run that moves them under the same
// state is a real change. The host no longer re-stamps unchanged PRs, so a
// bumped timestamp can't be relied on to carry it through.
function ciStatusEqual(
  a: import("../../shared/types/forge.js").CIStatus | undefined,
  b: import("../../shared/types/forge.js").CIStatus | undefined
): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return (
    a.state === b.state &&
    a.total === b.total &&
    a.passed === b.passed &&
    a.failed === b.failed &&
    a.pending === b.pending &&
    a.requiredChecksPassing === b.requiredChecksPassing &&
    a.headSha === b.headSha
  );
}

function linkedEqual(
  a: import("../../shared/types/plugin.js").PluginWorktreeLinked | null,
  b: import("../../shared/types/plugin.js").PluginWorktreeLinked | null
): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return (
    a.providerId === b.providerId &&
    a.pr?.ref.number === b.pr?.ref.number &&
    a.pr?.state === b.pr?.state &&
    a.pr?.url === b.pr?.url &&
    a.pr?.title === b.pr?.title &&
    a.pr?.baseRef === b.pr?.baseRef &&
    ciStatusEqual(a.pr?.ciStatus, b.pr?.ciStatus) &&
    mergeIntentEqual(a.pr?.mergeIntent, b.pr?.mergeIntent) &&
    a.pr?.headMovedWhileArmed === b.pr?.headMovedWhileArmed &&
    a.issue?.ref.number === b.issue?.ref.number &&
    a.issue?.title === b.issue?.title
  );
}
