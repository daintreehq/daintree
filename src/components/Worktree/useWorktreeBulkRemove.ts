import { useCallback, useEffect, useRef, useState } from "react";
import PQueue from "p-queue";
import { worktreeClient } from "@/clients/worktreeClient";
import { notify } from "@/lib/notify";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { logError } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import {
  buildWorktreeDeletePreview,
  settleWorktreeDeleteOutcome,
  submoduleFileCount,
  worktreeDeleteBlockedBy,
  type WorktreeDeletePreviewOutcome,
  type WorktreeSubmoduleDeleteBlock,
} from "./worktreeDeletePreview";
import type { WorktreeState } from "@/types";

/**
 * What the fresh per-target preview established, plus the `pending` state the
 * dialog opens in.
 *
 * `WorktreeDeletePreviewOutcome` is reused rather than re-spelled so the bulk
 * surface and `WorktreeDeleteDialog` cannot drift on what "verified", "gone"
 * and "failed" mean — the fail-closed rules for all three live in
 * `worktreeDeletePreview.ts` and are shared by every delete confirm.
 */
export type BulkRemoveTargetStatus = { state: "pending" } | WorktreeDeletePreviewOutcome;

export interface BulkRemoveTarget {
  id: string;
  name: string;
  branch: string | null;
  path: string;
  /**
   * Unpushed commits, from the store snapshot — the ONLY count here that a
   * fresh preview cannot refresh, because `getFreshChanges` carries no
   * ahead/behind (see `WorktreeChanges` in `shared/types/git.ts`).
   *
   * Kept anyway. `deleteBranch: false` means a named branch outlives its
   * worktree and its commits with it, but a detached worktree has no branch to
   * leave them on, so the line is not merely informational. Dropping a warning
   * from a destructive confirm is the #7880 failure direction; a count that is
   * up to a poll interval old is not.
   */
  aheadCount: number;
  status: BulkRemoveTargetStatus;
}

/** Why a snapshotted target will not be sent to the host. */
export type BulkRemoveExclusion =
  | { kind: "gone" }
  | { kind: "verify-failed" }
  | { kind: "blocked"; block: WorktreeSubmoduleDeleteBlock };

/**
 * Why this target is excluded from the batch, or `null` when it is eligible or
 * still loading.
 *
 * All three exclusions are fail-closed in the same direction — the target is
 * never handed to `worktreeClient.delete` — but they are deliberately distinct
 * states, because the recovery differs: `gone` needs nothing, `verify-failed`
 * needs a retry, and `blocked` needs a push the user has to go and do.
 */
export function bulkRemoveExclusion(target: BulkRemoveTarget): BulkRemoveExclusion | null {
  const status = target.status;
  if (status.state === "pending") return null;
  if (status.state === "gone") return { kind: "gone" };
  // A parent status we could not read is a target we cannot describe, and a D2
  // confirm owes a preview of the content it destroys. Falling back to the
  // cached snapshot here is the exact bug this surface is fixing, so the target
  // leaves the batch instead — the rest of the selection still runs.
  if (status.state === "failed") return { kind: "verify-failed" };
  const block = worktreeDeleteBlockedBy(status);
  // `force` does not reach these: `guardSubmoduleDelete` throws on both before
  // it reads the flag, so sending them would spend the typed-count consent on a
  // call whose only outcome is a toast.
  return block ? { kind: "blocked", block } : null;
}

/** True when the fresh preview cleared this target for the host. */
export function isBulkRemoveEligible(target: BulkRemoveTarget): boolean {
  return target.status.state === "verified" && bulkRemoveExclusion(target) === null;
}

/**
 * The per-target risk line for the D3 confirmation.
 *
 * Every count this preview derives has to reach the user: a worktree holding
 * nothing but untracked files is not a safe deletion, and for a long time it
 * rendered as a row with no warning at all because only tracked changes and
 * unpushed commits were surfaced. Adding a count to {@link BulkRemoveTarget}
 * without adding it here is the #7880 failure mode — the confirmation
 * understating what the action destroys.
 *
 * Reads the FRESH preview (#12416). The counts used to come off the store's
 * cached `worktreeChanges`, which is up to a poll interval stale and whose
 * equality check ignores per-file paths entirely, so a worktree an agent had
 * just written into rendered with no warning at all.
 */
export function describeBulkRemoveRisks(target: BulkRemoveTarget): string[] {
  const risks: string[] = [];
  const status = target.status;
  if (status.state === "verified") {
    const { trackedChangeCount, untrackedFileCount, submodules } = status.preview;
    if (trackedChangeCount > 0) {
      risks.push(`${trackedChangeCount} uncommitted file${trackedChangeCount === 1 ? "" : "s"}`);
    }
    if (untrackedFileCount > 0) {
      risks.push(`${untrackedFileCount} untracked file${untrackedFileCount === 1 ? "" : "s"}`);
    }
    // The parent's own status collapses every one of these into a single
    // ` M vendor/lib` row, and can be configured not to report it at all, so
    // the nested count cannot be derived from the two above it.
    const nested = submoduleFileCount(submodules);
    if (nested > 0) {
      risks.push(`${nested} file${nested === 1 ? "" : "s"} inside submodules`);
    }
  }
  if (target.aheadCount > 0) {
    risks.push(`${target.aheadCount} unpushed commit${target.aheadCount === 1 ? "" : "s"}`);
  }
  return risks;
}

interface UseWorktreeBulkRemoveArgs {
  selectedIds: Set<string>;
  worktreeMap: Map<string, WorktreeState>;
  clearSelection: () => void;
}

export interface UseWorktreeBulkRemoveReturn {
  isConfirmOpen: boolean;
  targets: BulkRemoveTarget[];
  excludedMainCount: number;
  /** Targets the fresh preview cleared — what the typed gate consents to. */
  eligibleCount: number;
  /** True until every snapshotted target's preview has settled. */
  isPreviewPending: boolean;
  /** True when at least one preview failed and a retry could still clear it. */
  hasFailedPreviews: boolean;
  /** Changes once when previews settle, so typed consent can't predate them. */
  consentKey: string;
  typedNameTarget: string;
  canConfirm: boolean;
  isExecuting: boolean;
  handleRemoveClick: () => void;
  handleRetryPreviews: () => void;
  handleConfirm: () => Promise<void>;
  handleCancel: () => void;
}

/**
 * Concurrency for the open-time preview fan-out. Each target costs two port
 * requests (`get-worktree-changes` + `get-submodule-delete-risk`, fired
 * together by `buildWorktreeDeletePreview`), so this is six in flight — enough
 * to keep a large selection moving, low enough that it doesn't bury the host's
 * refresh queue behind a dialog the user is waiting in front of.
 */
const PREVIEW_CONCURRENCY = 3;

/** Concurrency for the delete fan-out. Unchanged. */
const DELETE_CONCURRENCY = 4;

// Identity only — every risk count now comes from the fresh preview. The IPC
// layer still gets `force: true` for every bulk remove (the user typed the
// count, so the gate has consumed the irreversibility consent). That consent
// covers the working tree and nothing else — the run sends `deleteBranch:
// false`, so no branch is touched and the separate `forceDeleteBranch` consent
// never arises here.
function deriveTargets(
  selectedIds: Set<string>,
  worktreeMap: Map<string, WorktreeState>
): { targets: BulkRemoveTarget[]; excludedMainCount: number } {
  const targets: BulkRemoveTarget[] = [];
  let excludedMainCount = 0;
  for (const id of selectedIds) {
    const worktree = worktreeMap.get(id);
    if (!worktree) continue;
    if (worktree.isMainWorktree === true) {
      excludedMainCount++;
      continue;
    }
    targets.push({
      id,
      name: worktree.name,
      branch: worktree.branch ?? null,
      path: worktree.path,
      aheadCount: worktree.aheadCount ?? 0,
      status: { state: "pending" },
    });
  }
  return { targets, excludedMainCount };
}

/** One target's delete attempt, folded rather than mutated into counters. */
interface BulkRemoveResult {
  ok: boolean;
  name: string;
  reason: string | null;
  stoppedDevServer: boolean;
}

/**
 * Bulk-remove orchestrator for the Worktrees overview multi-select bar.
 *
 * Snapshots the selection at Remove-click time (lesson #4729 — reactive
 * derivations of the worktree list silently shrink as removals land), fetches a
 * FRESH delete preview for every snapshotted target (#12416), and runs the
 * deletes the user consented to through a p-queue capped at concurrency 4.
 * Emits a single summary toast — past-tense for all-success, warning for
 * partial, error for total failure. All selection is cleared regardless of
 * outcome; the modal itself is the retry surface.
 */
export function useWorktreeBulkRemove({
  selectedIds,
  worktreeMap,
  clearSelection,
}: UseWorktreeBulkRemoveArgs): UseWorktreeBulkRemoveReturn {
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [isPreviewPending, setIsPreviewPending] = useState(false);

  // Snapshot the live derivation when the user clicks Remove. Reading
  // back through `useMemo(() => derive(...), [worktreeMap, selectedIds])`
  // would silently drop entries from the dialog as deletes land mid-run.
  const targetsRef = useRef<BulkRemoveTarget[]>([]);
  const excludedMainRef = useRef<number>(0);

  // Display state mirrors the snapshot. We render from state so the
  // dialog updates immediately when it opens, but the source of truth
  // for the run is the ref.
  const [displayTargets, setDisplayTargets] = useState<BulkRemoveTarget[]>([]);
  const [displayExcludedMain, setDisplayExcludedMain] = useState(0);

  // Rapid double-click guard. Sync via ref so the second click within
  // the same render tick can't bypass the gate (a state-based guard
  // wouldn't update until React re-renders).
  const isExecutingRef = useRef(false);

  // Monotonic preview generation. Bumped on open, retry, cancel and unmount so
  // an in-flight fetch from a session the user has left can never write back —
  // the same guard `WorktreeDeleteDialog` uses for its own re-check.
  const previewSessionRef = useRef(0);
  const [previewSession, setPreviewSession] = useState(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Abandon any in-flight preview session: the results have nowhere to go.
      previewSessionRef.current += 1;
      isExecutingRef.current = false;
    };
  }, []);

  // Fan the fresh previews out over their own queue and fold each result back
  // onto its target as it lands, so a slow submodule walk on one worktree
  // doesn't hold the other rows at a skeleton.
  const runPreviews = useCallback((session: number, targets: BulkRemoveTarget[]) => {
    const queue = new PQueue({ concurrency: PREVIEW_CONCURRENCY });
    const settled = targets.map((target) =>
      queue.add(async () => {
        // Cheap re-check before spending the two port requests: a large
        // selection can still be queued long after the user cancelled.
        if (previewSessionRef.current !== session) return;
        const outcome = await settleWorktreeDeleteOutcome(buildWorktreeDeletePreview(target.id));
        if (!mountedRef.current || previewSessionRef.current !== session) return;
        const next = targetsRef.current.map((t) =>
          t.id === target.id ? { ...t, status: outcome } : t
        );
        targetsRef.current = next;
        setDisplayTargets(next);
      })
    );
    void Promise.allSettled(settled).then(() => {
      if (!mountedRef.current || previewSessionRef.current !== session) return;
      setIsPreviewPending(false);
    });
  }, []);

  const openWithPreviews = useCallback(
    (targets: BulkRemoveTarget[], excludedMainCount: number) => {
      previewSessionRef.current += 1;
      const session = previewSessionRef.current;
      setPreviewSession(session);
      targetsRef.current = targets;
      excludedMainRef.current = excludedMainCount;
      setDisplayTargets(targets);
      setDisplayExcludedMain(excludedMainCount);
      setIsPreviewPending(true);
      setIsConfirmOpen(true);
      runPreviews(session, targets);
    },
    [runPreviews]
  );

  const handleRemoveClick = useCallback(() => {
    if (isExecutingRef.current) return;
    const { targets, excludedMainCount } = deriveTargets(selectedIds, worktreeMap);
    if (targets.length === 0) {
      // All selections were main worktrees — nothing to do. Surface a
      // single info toast so the user understands why the action is
      // a no-op, then clear selection.
      if (excludedMainCount > 0) {
        notify({
          type: "info",
          title: "Nothing to remove",
          message: "The main worktree can't be removed from the overview.",
          priority: "high",
          context: { eventKind: "uiFeedback" },
        });
        clearSelection();
      }
      return;
    }
    openWithPreviews(targets, excludedMainCount);
  }, [selectedIds, worktreeMap, clearSelection, openWithPreviews]);

  // Re-runs the whole frozen set, not just the failures, so every row's
  // evidence belongs to one generation — a dialog mixing a fresh row with a
  // minute-old one is the staleness this surface exists to remove.
  const handleRetryPreviews = useCallback(() => {
    if (isExecutingRef.current) return;
    const targets = targetsRef.current;
    if (targets.length === 0) return;
    openWithPreviews(
      targets.map((t) => ({ ...t, status: { state: "pending" } as const })),
      excludedMainRef.current
    );
  }, [openWithPreviews]);

  const resetSnapshot = useCallback(() => {
    // Abandon the in-flight preview generation along with the snapshot —
    // otherwise `typedNameTarget` and the target list rendered for any
    // out-of-dialog consumer would still reflect the previous open.
    previewSessionRef.current += 1;
    targetsRef.current = [];
    excludedMainRef.current = 0;
    setDisplayTargets([]);
    setDisplayExcludedMain(0);
    setIsPreviewPending(false);
  }, []);

  const handleCancel = useCallback(() => {
    if (isExecutingRef.current) return;
    setIsConfirmOpen(false);
    resetSnapshot();
  }, [resetSnapshot]);

  const handleConfirm = useCallback(async () => {
    if (isExecutingRef.current) return;
    // Re-read eligibility from the ref rather than trusting the render that
    // enabled the button: previews settle asynchronously and the last one can
    // land between paint and click.
    const targets = targetsRef.current.filter(isBulkRemoveEligible);
    if (targets.length === 0) {
      setIsConfirmOpen(false);
      resetSnapshot();
      return;
    }
    isExecutingRef.current = true;
    setIsExecuting(true);

    // No queue-level `timeout`. p-queue's timeout rejects the WRAPPER and
    // cancels nothing (9.3.3 hands `pTimeout` no signal), so the old 30s
    // ceiling rejected `addAll` — orphaning up to three still-running deletes
    // and reporting an "aborted" run whose siblings then landed unobserved.
    // The transport already bounds each call: `delete-worktree` carries a
    // 10-minute port deadline sized to the host's own 7-minute teardown worst
    // case, so a renderer deadline here can only ever fire early.
    const queue = new PQueue({ concurrency: DELETE_CONCURRENCY });
    const total = targets.length;

    try {
      // `allSettled` over individual `add()` calls, never `addAll`: that is
      // `Promise.all` underneath, so one rejected submission discards every
      // sibling's result.
      const settled = await Promise.allSettled(
        targets.map((target) =>
          queue.add<BulkRemoveResult>(async () => {
            try {
              // Stop dev preview BEFORE `git worktree remove` (#9084). On
              // Windows the dev server's directory lock would otherwise block
              // the removal outright. A stop failure is folded into the
              // partial-failure path so the bulk run can continue with other
              // targets. Call `stopByWorktree` unconditionally — it filters
              // every session itself and no-ops cleanly when none match, so
              // it survives the case where `getByWorktree` only reports one
              // panel's session of several sharing the worktreeId.
              const existing = await window.electron.devPreview.getByWorktree({
                worktreeId: target.id,
              });
              const hadDevPreview = existing !== null;
              await window.electron.devPreview.stopByWorktree({ worktreeId: target.id });
              await worktreeClient.delete(target.id, { force: true, deleteBranch: false });
              return {
                ok: true,
                name: target.branch ?? target.name,
                reason: null,
                stoppedDevServer: hadDevPreview,
              };
            } catch (err) {
              const reason = formatErrorMessage(err, "Removal failed");
              logError(`Bulk remove failed for ${target.id}`, err);
              return {
                ok: false,
                name: target.branch ?? target.name,
                reason,
                stoppedDevServer: false,
              };
            }
          })
        )
      );

      let successCount = 0;
      let stoppedDevServerCount = 0;
      let stoppedDevServerName: string | null = null;
      const failures: Array<{ name: string; reason: string }> = [];
      settled.forEach((entry, index) => {
        const target = targets[index];
        const fallbackName = target ? (target.branch ?? target.name) : "worktree";
        if (entry.status === "rejected") {
          // The task body catches its own errors, so this is the submission
          // itself failing (a cleared queue). Counted rather than dropped —
          // every target the run attempted has to reach the summary.
          failures.push({
            name: fallbackName,
            reason: formatErrorMessage(entry.reason, "Removal failed"),
          });
          logError(`Bulk remove never ran for ${target?.id ?? "unknown"}`, entry.reason);
          return;
        }
        const result = entry.value;
        if (result.stoppedDevServer) {
          stoppedDevServerCount++;
          // The dev-server line names the worktree, not its branch — the
          // server was started against the directory.
          stoppedDevServerName = target ? target.name : result.name;
        }
        if (result.ok) {
          successCount++;
        } else {
          failures.push({ name: result.name, reason: result.reason ?? "Removal failed" });
        }
      });

      const announce = useAnnouncerStore.getState().announce;
      if (failures.length === 0) {
        // Transient: the overview grid already reflects the removed
        // worktrees disappearing — the toast is a one-shot confirmation,
        // not something the user needs to revisit from the notification
        // inbox (#8249).
        const successTitle = total === 1 ? "Removed 1 worktree" : `Removed ${total} worktrees`;
        let successMessage =
          total === 1
            ? "The worktree directory was deleted from disk."
            : `${total} worktree directories were deleted from disk.`;
        if (stoppedDevServerCount === 1 && stoppedDevServerName) {
          successMessage = `${successMessage} Stopped dev server for ${stoppedDevServerName}.`;
        } else if (stoppedDevServerCount > 1) {
          successMessage = `${successMessage} Stopped ${stoppedDevServerCount} dev servers.`;
        }
        notify({
          type: "success",
          title: successTitle,
          message: successMessage,
          transient: true,
          priority: "high",
          context: { eventKind: "uiFeedback" },
        });
        announce(successTitle);
      } else if (successCount === 0) {
        // Total failure — no recovery action attached because the modal
        // itself is the retry surface (the user can re-select and retry).
        const firstFailure = failures[0];
        const failureTitle = total === 1 ? "Couldn't remove worktree" : "Couldn't remove worktrees";
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          title: failureTitle,
          message: firstFailure ? firstFailure.reason : "All removals failed.",
        });
        announce(failureTitle, "assertive");
      } else {
        // Partial — warning type so the success half isn't lost in red.
        // Warning toasts aren't gated by the success-toast rule, so no
        // eslint-disable is needed here (the rule fires only on `type:
        // "success"` and `type: "error"` without protection).
        const firstFailure = failures[0];
        const partialMessage =
          failures.length === 1 && firstFailure
            ? `${firstFailure.name} failed: ${firstFailure.reason}`
            : `${failures.length} failed.`;
        const partialTitle = `Removed ${successCount} of ${total} worktrees`;
        notify({
          type: "warning",
          title: partialTitle,
          message: partialMessage,
        });
        announce(partialTitle);
      }
    } finally {
      isExecutingRef.current = false;
      setIsExecuting(false);
      setIsConfirmOpen(false);
      resetSnapshot();
      clearSelection();
    }
  }, [clearSelection, resetSnapshot]);

  const eligibleCount = displayTargets.filter(isBulkRemoveEligible).length;
  const hasFailedPreviews = displayTargets.some((t) => t.status.state === "failed");

  return {
    isConfirmOpen,
    targets: displayTargets,
    excludedMainCount: displayExcludedMain,
    eligibleCount,
    isPreviewPending,
    hasFailedPreviews,
    // Flips exactly once per generation, when the previews settle, so a count
    // typed against the skeleton does not carry into the evidence that
    // replaced it.
    consentKey: `${previewSession}:${isPreviewPending ? "pending" : "settled"}`,
    typedNameTarget: eligibleCount === 1 ? "1 worktree" : `${eligibleCount} worktrees`,
    canConfirm: !isPreviewPending && eligibleCount > 0,
    isExecuting,
    handleRemoveClick,
    handleRetryPreviews,
    handleConfirm,
    handleCancel,
  };
}
