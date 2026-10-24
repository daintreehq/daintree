import { logDebug } from "../utils/logger.js";
import type { BatchLoader } from "../workspace-host/batchLoader.js";
import type { DaintreeEventMap } from "./events.js";
import type { InternalLinkedPR } from "./pullRequestEntry.js";
import type { CIStatus, CIStatusState, RepoRef } from "../../shared/types/forge.js";

// Same floor as the service's detection catch-up, on its own clock: the two
// fetch different things, so a recent detection poll must not suppress this.
const FOCUS_CATCHUP_THROTTLE_MS = 5 * 1000;

// Terminal CI states go stale too (#11513). Re-running a failed job pushes no
// commit, so the PR's updated_at never moves and the open-PR probe reports it
// unchanged — and a terminal status isn't `pending`, so the compensating loop
// in revalidateResolvedPRs skipped it as well. Re-check resolved PRs on a slow
// cadence weighted toward failures, which is the state users actually re-run.
// Each attempt rides the revalidation tick's existing getCIStatuses batch
// (~2 GraphQL points), so a permanently failing PR adds ~40 points/hour and a
// green one ~12 — negligible against the 5000/hr primary limit documented
// above. These are minimum elapsed times, not timers: an eligible PR waits up
// to one revalidation interval before the next tick picks it up.
const TERMINAL_CI_RECHECK_FAILURE_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
const TERMINAL_CI_RECHECK_SUCCESS_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

// Null for every non-terminal status, so `undefined` (unknown / no CI checks —
// nothing to re-poll for, #6240) and `pending` (owned by the boost cadence
// above) are structurally ineligible for the slow pass rather than excluded by
// a condition someone could later widen.
function terminalCiRecheckIntervalMs(status: CIStatusState | undefined): number | null {
  if (status === "failure") return TERMINAL_CI_RECHECK_FAILURE_INTERVAL_MS;
  if (status === "success") return TERMINAL_CI_RECHECK_SUCCESS_INTERVAL_MS;
  return null;
}

// After a push, GitHub reports no rollup at all until the new head's first check
// registers — normally seconds, minutes during an Actions incident — and that
// reads exactly like a repo with no CI (#13399). A PR that has reported checks
// before keeps being read on the boost cadence for this long after its head
// moves; past it, "no checks" is accepted ([skip ci], path filters). ~6 reads
// at the 30s boost floor, ~12 GraphQL points per push, and a second push
// restarts the window rather than adding one.
const CI_HEAD_MOVE_GRACE_MS = 3 * 60 * 1000;

function reportsChecks(ci: CIStatus | null | undefined): boolean {
  return ci?.state === "success" || ci?.state === "failure" || ci?.state === "pending";
}

export function isGraceOpen(pr: InternalLinkedPR, now: number): boolean {
  return pr.ciGraceUntil !== undefined && now < pr.ciGraceUntil;
}

// Whether a CI read may be shown on this entry. A verdict for the head the PR
// just moved off never is. While the post-push wait is open nothing but the
// new head's own checks is: a read for some other commit, or one with no
// checks yet, is "not yet". Outside the wait a commit the probe hasn't caught
// up to is accepted — it can only be newer than what the probe last saw.
function ciReadApplies(pr: InternalLinkedPR, ci: CIStatus | null, now: number): boolean {
  const readHead = ci?.headSha;
  if (readHead !== undefined && readHead === pr.displacedHeadSha) return false;
  // A read that doesn't name its commit could still be the provider's cached
  // answer for the head a local push moved off; the probe confirming the push
  // is what retires that cache.
  if (readHead === undefined && isLocalHeadUnconfirmed(pr)) return false;
  if (!isGraceOpen(pr, now)) return true;
  const expectedHead = pr.localHeadSha ?? pr.headSha;
  if (readHead !== undefined && expectedHead !== undefined && readHead !== expectedHead) {
    return false;
  }
  return reportsChecks(ci);
}

function isLocalHeadUnconfirmed(pr: InternalLinkedPR): boolean {
  return (
    pr.localHeadSha !== undefined && pr.headSha !== undefined && pr.headSha !== pr.localHeadSha
  );
}

// Whether a probe snapshot's head is one this PR already accounts for while a
// push seen locally is outstanding: the head it moved to (the catch-up), or one
// it moved off (a probe still lagging the push). Neither is a new head.
export function isKnownHeadDuringLocalMove(pr: InternalLinkedPR, head: string): boolean {
  return (
    head === pr.localHeadSha ||
    head === pr.headSha ||
    head === pr.displacedHeadSha ||
    head === pr.localMoveBaseSha
  );
}

export function clearLocalHeadMove(pr: InternalLinkedPR): void {
  pr.localHeadSha = undefined;
  pr.localHeadAt = undefined;
  pr.localMoveBaseSha = undefined;
  pr.displacedByLocalMove = undefined;
}

// The upstream ref is the only remote branch whose movement may be read as the
// PR's: a single remote segment, then exactly the PR's head branch name. A
// remote whose own name has a slash is left to the probe.
export function upstreamNamesPRHead(ref: string, headRef: string): boolean {
  const prefix = "refs/remotes/";
  if (!ref.startsWith(prefix)) return false;
  const rest = ref.slice(prefix.length);
  const suffix = `/${headRef}`;
  if (!rest.endsWith(suffix)) return false;
  const remote = rest.slice(0, -suffix.length);
  return remote.length > 0 && !remote.includes("/");
}

// The rollup held describes a commit the PR has moved past. Drop it: holding
// the old head's cross over the new one keeps the CI-failed alarm up for a push
// that has not run yet. Nothing replaces it until the new head reports checks —
// not even `pending`, which only the forge gets to say.
export function applyHeadMove(
  pr: InternalLinkedPR,
  displaced: string | undefined,
  now: number
): void {
  const hadCi = pr.ciSeen === true || reportsChecks(pr._ciStatus);
  if (displaced !== undefined) pr.displacedHeadSha = displaced;
  pr.ciStatus = undefined;
  pr._ciStatus = undefined;
  pr.stagnantPollCount = 0;
  if (hadCi) {
    pr.ciSeen = true;
    pr.ciGraceUntil = now + CI_HEAD_MOVE_GRACE_MS;
  }
}

export interface PullRequestCiTrackerDeps {
  // The service's live maps. The tracker writes CI fields on the entries but
  // never adds or removes one: detection and revalidation own membership.
  detectedPRs: ReadonlyMap<string, InternalLinkedPR>;
  candidates: ReadonlyMap<string, { issueNumber?: number; branchName?: string }>;
  getRepo(): RepoRef | null;
  // Provider-scoped, so it is read per call: a provider swap replaces it.
  getLoader(): BatchLoader<number, CIStatus | null> | null;
  publish(payload: DaintreeEventMap["sys:pr:detected"]): void;
  // Recomputes the revalidation boost; true when that armed one that wasn't.
  refreshBoost(): boolean;
  scheduleRevalidation(): void;
}

/**
 * Commit-correlated CI state for detected PRs: which read may be shown on
 * which entry, when a resolved PR's CI is re-read, and the batched enrichment
 * that writes results back and re-emits them. PR detection, revalidation and
 * their cadence stay with PullRequestService.
 */
export class PullRequestCiTracker {
  // Drop the GraphQL CI-status enrichment when the instance is unattended:
  // worker-role instances (which never have a focused window) start disabled,
  // and attended instances toggle it off on window blur. When disabled, the
  // cheap REST probe (probeOpenPRList) still tracks PR existence/state, but the
  // ~2-point-per-PR getCIStatuses fan-out is skipped — absent CI reads as
  // "unknown" (undefined), never success (#6240). Initialized at construction
  // so it's correct before the service's first checkForPRs.
  private enabled: boolean = process.env.DAINTREE_INSTANCE_ROLE !== "worker";
  private lastFocusCiCheckAt: number = Number.NEGATIVE_INFINITY;

  constructor(private readonly deps: PullRequestCiTrackerDeps) {}

  get ciEnrichmentEnabled(): boolean {
    return this.enabled;
  }

  private get detectedPRs(): ReadonlyMap<string, InternalLinkedPR> {
    return this.deps.detectedPRs;
  }

  private get candidates(): PullRequestCiTrackerDeps["candidates"] {
    return this.deps.candidates;
  }

  reset(): void {
    this.lastFocusCiCheckAt = Number.NEGATIVE_INFINITY;
  }

  /**
   * Re-enrich CI for every resolved PR on focus regain — the moment the user is
   * actually looking at the sidebar. This is the only trigger that covers
   * entries `sweepStaleCiStatus` cleared to `undefined` on blur: those are
   * neither `pending` nor probe-flagged, so both revalidation triggers skip them
   * and CI that finished while the window was blurred would never surface
   * (#11513). Unlike the slow terminal pass this deliberately includes
   * `undefined` — the issue asks for exactly that backfill.
   *
   * Hooked off the focus signal rather than `setCIEnrichmentEnabled(true)`
   * because that setter early-returns when the flag is already `true` — which is
   * the state of a workspace-host restarted while the app was blurred, since
   * WorkspaceHostProcess replays monitor config but not the PR focus cadence, so
   * the fresh service keeps the attended `true` default and never sees a flip.
   */
  recheckResolvedCIOnFocus(resolvedWorktrees: Iterable<string>, repo: RepoRef): void {
    if (!this.enabled || !this.deps.getLoader()) return;

    // Throttle rapid alt-tabbing, mirroring the service's detection catch-up.
    // `now < lastFocusCiCheckAt` rebases a backwards clock jump instead of
    // suppressing catch-up until real time overtakes the stale stamp.
    const now = Date.now();
    if (
      now >= this.lastFocusCiCheckAt &&
      now - this.lastFocusCiCheckAt < FOCUS_CATCHUP_THROTTLE_MS
    ) {
      return;
    }

    // Resolved worktrees only: detectedPRs can still hold an entry for a
    // worktree mid-re-detection, and re-checking that burns quota on a PR
    // binding about to be replaced.
    // Dedup by object, not PR number: sibling worktrees on one branch share a
    // single InternalLinkedPR (so they collapse to one entry either way), but
    // two worktrees that resolve the same PR through separate detection cycles
    // hold DISTINCT objects. Number-dedup would enrich only the first and leave
    // the other holding a stale status that a later blur sweep acts on. This
    // costs no extra API call — BatchLoader single-flights by key, so both
    // objects settle off one request.
    const enrichedPRs = new Set<InternalLinkedPR>();
    for (const worktreeId of resolvedWorktrees) {
      const detectedPR = this.detectedPRs.get(worktreeId);
      if (!detectedPR || enrichedPRs.has(detectedPR)) continue;
      enrichedPRs.add(detectedPR);
      // Synchronous fire-and-forget, matching revalidateResolvedPRs — every
      // load enqueued in this loop coalesces into one getCIStatuses batch.
      this.enrichPRWithCIStatus(detectedPR, repo);
    }

    if (enrichedPRs.size === 0) {
      // Nothing went out, so don't arm the throttle — otherwise a focus regain
      // with no resolved PRs would swallow the next one.
      return;
    }
    this.lastFocusCiCheckAt = now;
  }

  /**
   * Toggle the GraphQL CI-status enrichment. Driven by window focus (blur →
   * disable, focus → enable) for attended instances; worker-role instances stay
   * disabled. The probe loop is untouched — only the per-PR getCIStatuses
   * fan-out is gated.
   *
   * On disable we must sweep any in-flight CI state so the adaptive boost
   * collapses: a pending entry left in `detectedPRs` keeps
   * `updateBoostFromDetectedPRs` re-arming the 30s boost every revalidation
   * tick with no fetch behind it (#6149). Clearing those entries to `undefined`
   * — not success — also keeps "no CI fetched" from reading as passing (#6240),
   * and re-emits so the renderer drops any preserved dot rather than holding it
   * stale forever (no phase-2 emit is coming while disabled).
   */
  setCIEnrichmentEnabled(enabled: boolean): void {
    // Worker instances must stay disabled regardless of any focus signal that
    // reaches them — the env role is the authoritative invariant, not the
    // transient IPC cadence flag.
    if (enabled && process.env.DAINTREE_INSTANCE_ROLE === "worker") {
      return;
    }
    if (this.enabled === enabled) {
      return;
    }

    if (!enabled) {
      this.sweepStaleCiStatus();
    }

    this.enabled = enabled;

    if (!enabled) {
      // The boost just collapsed (boostExpiresAt = null), but an already-armed
      // boosted revalidationTimer would still fire early. Reschedule now so the
      // next tick lands at the 90s baseline instead of the stale 30s.
      this.deps.scheduleRevalidation();
    }
  }

  // Clear in-flight CI state and re-emit the affected PRs without a CI status so
  // the boost decays and the renderer stops showing a stale spinner/dot. Only
  // pending entries are touched — terminal states (success/failure) and
  // already-unknown PRs are correct as-is, so re-emitting them would be noise.
  private sweepStaleCiStatus(): void {
    const repo = this.deps.getRepo();
    // Track the exact worktrees we sweep, not the PR numbers: sibling worktrees
    // on the same branch share one InternalLinkedPR object (so clearing it once
    // covers them all), while two worktrees that coincidentally resolve the same
    // PR number through different objects must not cross-clear — re-emitting a
    // success worktree without its CI field would wrongly blank its dot.
    const sweptWorktrees: string[] = [];
    const sweptObjects = new Set<InternalLinkedPR>();

    for (const [worktreeId, pr] of this.detectedPRs) {
      if (pr.ciStatus === "pending") {
        sweptWorktrees.push(worktreeId);
        sweptObjects.add(pr);
      }
    }
    for (const pr of sweptObjects) {
      pr.ciStatus = undefined;
      pr._ciStatus = undefined;
      pr.stagnantPollCount = 0;
      // Mark for backfill: this entry is now indistinguishable from "no CI
      // configured", which nothing re-polls. The flag is what makes it
      // recoverable once enrichment comes back (#11513).
      pr.needsCiBackfill = true;
    }

    // updateBoostFromDetectedPRs runs unconditionally — with no pending entries
    // left it collapses boostExpiresAt to null so the next scheduleRevalidation
    // picks the 90s baseline instead of the boosted 30s.
    this.deps.refreshBoost();

    if (!repo || sweptWorktrees.length === 0) {
      return;
    }

    for (const worktreeId of sweptWorktrees) {
      const detected = this.detectedPRs.get(worktreeId);
      if (!detected) continue;
      this.deps.publish({
        worktreeId,
        prNumber: detected.number,
        prUrl: detected.url,
        prState: detected.state,
        // No prCiStatus / ciStatus / isCiStatusLoading: an absent CI field means
        // "unknown", which the renderer must not treat as passing or loading.
        prTitle: detected.title,
        issueNumber: this.candidates.get(worktreeId)?.issueNumber,
        branchName: this.candidates.get(worktreeId)?.branchName,
        providerId: detected.providerId,
        owner: repo.owner,
        repo: repo.repo,
        baseRef: detected.baseRef,
        mergeIntent: detected.mergeIntent,
        headMovedWhileArmed: detected.headMovedWhileArmed,
        timestamp: Date.now(),
      });
    }
  }

  // A push seen on the PR's upstream ref, already vetted by the service as
  // the PR's own head moving `from` → `to`: retract the old head's rollup on
  // every entry for this PR and re-emit them.
  applyLocalHeadMove(entry: InternalLinkedPR, from: string, to: string, repo: RepoRef): void {
    // Two worktrees can hold distinct entries for one PR (separate detection
    // cycles); each must drop the old head's result, or the other re-publishes it.
    const now = Date.now();
    const moved = new Set<InternalLinkedPR>();
    for (const detected of this.detectedPRs.values()) {
      if (moved.has(detected)) continue;
      if (detected.number !== entry.number || detected.providerId !== entry.providerId) continue;
      if (detected !== entry && detected.state !== "open") continue;
      moved.add(detected);
      if (detected.localHeadSha === undefined) {
        detected.localMoveBaseSha = detected.headSha ?? from;
      }
      // Each push restarts the wait for confirmation, as it restarts the grace.
      detected.localHeadAt = now;
      applyHeadMove(detected, from, now);
      detected.localHeadSha = to;
      detected.displacedByLocalMove = true;
    }

    for (const [siblingId, detected] of this.detectedPRs) {
      if (!moved.has(detected)) continue;
      this.deps.publish({
        worktreeId: siblingId,
        prNumber: detected.number,
        prUrl: detected.url,
        prState: detected.state,
        // Both cleared, and no `isCiStatusLoading`: it would preserve the very
        // rollup this emit retracts.
        prCiStatus: detected.ciStatus,
        ciStatus: detected._ciStatus,
        prTitle: detected.title,
        issueNumber: this.candidates.get(siblingId)?.issueNumber,
        branchName: this.candidates.get(siblingId)?.branchName,
        providerId: detected.providerId,
        owner: repo.owner,
        repo: repo.repo,
        baseRef: detected.baseRef,
        mergeIntent: detected.mergeIntent,
        headMovedWhileArmed: detected.headMovedWhileArmed,
        timestamp: Date.now(),
      });
    }
  }

  // CI status can change without the PR's metadata changing — a re-run does
  // not bump updated_at, so the probe reports those PRs unchanged. Keep
  // polling CI for any PR revalidation hasn't just enriched, so green/red
  // transitions still surface promptly even on an otherwise-quiet tick.
  //
  // Pending keeps its every-tick cadence (the service's boost bands tune it,
  // and re-tuning it is an explicit non-goal of #11513). Terminal states get
  // a slow, failure-weighted pass on top: without it a re-run of a failed
  // build is invisible to both triggers — not probe-flagged, not pending —
  // and the cross sticks until the next push.
  //
  // Skipped entirely when enrichment is disabled (unattended instance): the
  // sweep on disable already cleared pending entries, so the pending half
  // would be a no-op anyway, but the guard keeps both from re-fetching after
  // a re-detection re-seeds state mid-blur.
  enrichDueCiStatuses(enrichedPRNumbers: Set<number>, repo: RepoRef): void {
    if (!this.enabled) return;
    const now = Date.now();
    for (const detectedPR of this.detectedPRs.values()) {
      this.expireUnconfirmedLocalHeadMove(detectedPR, now);
      // Before any skip: the deadline has to close even on a tick that
      // already read this PR or reads it for another reason.
      const graceRead = this.consumeCiGraceRead(detectedPR, now);
      if (enrichedPRNumbers.has(detectedPR.number)) continue;
      if (
        detectedPR.ciStatus === "pending" ||
        detectedPR.needsCiBackfill === true ||
        graceRead ||
        this.isTerminalCiRecheckDue(detectedPR, now)
      ) {
        enrichedPRNumbers.add(detectedPR.number);
        this.enrichPRWithCIStatus(detectedPR, repo);
      }
    }
  }

  // Is this PR's terminal CI status old enough to re-check? Gated purely on
  // elapsed time, never on the cached status itself: a guard keyed off the
  // status is exactly what froze the stale-green badge in #6149, because a
  // status that never re-fetches can never stop matching its own skip
  // condition. Elapsed time always advances, so this cannot wedge.
  private isTerminalCiRecheckDue(pr: InternalLinkedPR, now: number): boolean {
    const interval = terminalCiRecheckIntervalMs(pr.ciStatus);
    if (interval === null) return false;
    const last = pr.lastCiCheckAt;
    // Never attempted, or the system clock moved backwards (correction / DST
    // via a bad Date source) — rebase by treating it as due rather than letting
    // a stamp from the future suppress re-checks until real time catches up.
    if (last === undefined || now < last) return true;
    return now - last >= interval;
  }

  // While a head-move grace window is open every tick reads; the first tick
  // past its deadline closes it and takes one last read, which (outside the
  // window) is shown as-is — the "no checks" answer the window was waiting out.
  private consumeCiGraceRead(pr: InternalLinkedPR, now: number): boolean {
    if (pr.ciGraceUntil === undefined) return false;
    if (now >= pr.ciGraceUntil) pr.ciGraceUntil = undefined;
    return true;
  }

  // A local head move the probe hasn't confirmed by the end of the post-push
  // wait is dropped, along with everything it held back, and CI is read again
  // for whatever the forge now says the head is. Either the moved ref wasn't
  // this PR's head after all (a fork's same-named branch on the same commit),
  // or the forge is far enough behind that the old answer is the honest one —
  // the probe still catches the push when it does land. Providers without a
  // probe never confirm, so for them this simply ends the move.
  private expireUnconfirmedLocalHeadMove(pr: InternalLinkedPR, now: number): void {
    if (pr.localHeadSha === undefined || pr.headSha === pr.localHeadSha) return;
    const at = pr.localHeadAt;
    if (at !== undefined && now >= at && now - at < CI_HEAD_MOVE_GRACE_MS) return;
    logDebug("Local head move never reached the PR - re-reading its result", {
      prNumber: pr.number,
    });
    if (pr.displacedByLocalMove) pr.displacedHeadSha = undefined;
    clearLocalHeadMove(pr);
    pr.ciGraceUntil = undefined;
    pr.needsCiBackfill = true;
  }

  /**
   * Fire CI status lookup as a non-blocking tail after PR detection.
   * On success, updates the detectedPRs entry and re-emits sys:pr:detected
   * with the enriched CI status so the renderer can update the badge.
   *
   * `force` marks an explicitly user-initiated pass (manual refresh). It rides
   * the call instead of the shared `ciEnrichmentEnabled` flag so a blurred
   * instance can still serve one deliberate refresh without the disable sweep
   * tearing down the result. It overrides window focus only — worker-role
   * instances stay clamped off, gated by the caller in `PullRequestService.checkForPRs`. Returned
   * promise is best-effort and never rejects; forced callers await it, ambient
   * ones drop it on the floor to keep the batch coalescing described below.
   */
  enrichPRWithCIStatus(pr: InternalLinkedPR, repo: RepoRef, force = false): Promise<void> {
    if (!force && !this.enabled) return Promise.resolve();
    const loader = this.deps.getLoader();
    if (!loader) return Promise.resolve();
    // Synchronous `load()` here: enrichPRWithCIStatus is called fire-and-forget
    // in a `for` loop per detected PR, so all loads enqueue in the same tick and
    // coalesce into one `getCIStatuses` batch. Do NOT add an `await` before this
    // call — it would drain the microtask queue and defeat the coalescing.
    //
    // Stamp the attempt, not the outcome: isTerminalCiRecheckDue reads this to
    // pace the slow terminal re-check, and pacing on resolve would retry every
    // tick for as long as the provider keeps rejecting.
    pr.lastCiCheckAt = Date.now();
    return loader
      .load(pr.number)
      .then((ciStatus) => {
        // Enrichment may have been disabled (window blur) while this batch was
        // in flight — discard the result rather than write a CI status back and
        // re-arm the boost the sweep just collapsed. A forced pass keeps its
        // result: the user asked for it, and the boost stays collapsed because
        // updateBoostFromDetectedPRs only arms while ambient enrichment is on.
        if (!force && !this.enabled) return;
        // Not applicable here means "not yet", never "no checks": the badge
        // stays blank and the boost cadence asks again.
        if (!ciReadApplies(pr, ciStatus, Date.now())) return;
        pr.ciGraceUntil = undefined;
        if (reportsChecks(ciStatus)) pr.ciSeen = true;
        const prevCiStatus = pr.ciStatus;
        // A resolved value is authoritative: the batch contract surfaces a
        // transient miss as a rejection (→ .catch below), so a `null` here is a
        // confirmed "no CI checks." Map it to undefined and still re-emit so a
        // dot the phase-1 emit preserved is actually cleared once checks
        // genuinely disappear, rather than lingering stale (#9551).
        pr.ciStatus =
          ciStatus &&
          (ciStatus.state === "success" ||
            ciStatus.state === "failure" ||
            ciStatus.state === "pending")
            ? ciStatus.state
            : undefined;
        pr._ciStatus = ciStatus ?? undefined;
        // Only a positive result settles the blur-sweep backfill debt. A swept
        // entry was `pending`, so it demonstrably had checks — a `null` says
        // they have since vanished, which happens, but rarely enough that
        // holding the debt and asking again is the cheaper mistake than
        // stranding the badge. Worst case we retry it once per tick until the
        // provider answers or a re-detection replaces the entry.
        if (ciStatus) {
          pr.needsCiBackfill = undefined;
        }
        if (pr.ciStatus !== undefined) {
          pr.stagnantPollCount = prevCiStatus === pr.ciStatus ? pr.stagnantPollCount + 1 : 0;
        }
        // Re-emit (phase-2) for each worktree that has this PR — including the
        // confirmed "no checks" case so a preserved phase-1 dot is cleared.
        for (const [worktreeId, detected] of this.detectedPRs) {
          if (detected.number === pr.number) {
            // Re-checked per destination: `pr` may be an entry a re-detection
            // has since replaced, or a sibling that hasn't seen the push this
            // one has.
            if (detected !== pr && !ciReadApplies(detected, ciStatus ?? null, Date.now())) {
              continue;
            }
            // Sibling worktrees on the same branch share one entry, but two
            // worktrees can also hold distinct entries for the same PR. Only
            // one of them is enriched per tick, so carry the result onto the
            // others too — otherwise a later metadata emit from an unenriched
            // entry re-publishes the rollup this one just replaced.
            detected.ciStatus = pr.ciStatus;
            detected._ciStatus = pr._ciStatus;
            if (pr.ciSeen) detected.ciSeen = true;
            detected.ciGraceUntil = undefined;
            this.deps.publish({
              worktreeId,
              prNumber: pr.number,
              prUrl: pr.url,
              // Read state from the live map entry, not the captured `pr` — a
              // re-detection may have replaced the entry while this enrichment
              // was in flight, and the stale capture would revert its state.
              prState: detected.state,
              prCiStatus: pr.ciStatus,
              prTitle: pr.title,
              issueNumber: this.candidates.get(worktreeId)?.issueNumber,
              branchName: this.candidates.get(worktreeId)?.branchName,
              providerId: pr.providerId,
              owner: repo.owner,
              repo: repo.repo,
              ciStatus: pr._ciStatus,
              baseRef: detected.baseRef,
              mergeIntent: detected.mergeIntent,
              headMovedWhileArmed: detected.headMovedWhileArmed,
              timestamp: Date.now(),
            });
          }
        }
        // Enrichment is fire-and-forget, so a terminal→pending flip (a CI
        // re-run) only becomes visible here — after revalidateResolvedPRs
        // already re-armed its timer at the 90s baseline. Without this the
        // freshly-armed boost wouldn't take effect until that stale tick fired,
        // making the first re-run poll up to 90s away instead of 30s (#11513).
        if (this.deps.refreshBoost()) {
          this.deps.scheduleRevalidation();
        }
      })
      .catch(() => {
        // CI status fetch is best-effort; failure does not invalidate the PR detection
      });
  }
}
