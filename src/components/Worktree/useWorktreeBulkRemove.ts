import { useCallback, useEffect, useRef, useState } from "react";
import PQueue from "p-queue";
import { worktreeClient } from "@/clients/worktreeClient";
import { notify } from "@/lib/notify";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { logError } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { WorktreeState } from "@/types";

export interface BulkRemoveTarget {
  id: string;
  name: string;
  branch: string | null;
  path: string;
  trackedChangeCount: number;
  untrackedFileCount: number;
  aheadCount: number;
}

/**
 * The per-target risk line for the D3 confirmation.
 *
 * Every count this preview derives has to reach the user: a worktree holding
 * nothing but untracked files is not a safe deletion, and for a long time it
 * rendered as a row with no warning at all because only tracked changes and
 * unpushed commits were surfaced. Adding a count to {@link BulkRemoveTarget}
 * without adding it here is the #7880 failure mode — the confirmation
 * understating what the action destroys — so the invariant is asserted over the
 * target's numeric fields rather than over this function's wording.
 */
export function describeBulkRemoveRisks(target: BulkRemoveTarget): string[] {
  const risks: string[] = [];
  if (target.trackedChangeCount > 0) {
    risks.push(
      `${target.trackedChangeCount} uncommitted file${target.trackedChangeCount === 1 ? "" : "s"}`
    );
  }
  if (target.untrackedFileCount > 0) {
    risks.push(
      `${target.untrackedFileCount} untracked file${target.untrackedFileCount === 1 ? "" : "s"}`
    );
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
  typedNameTarget: string;
  isExecuting: boolean;
  handleRemoveClick: () => void;
  handleConfirm: () => Promise<void>;
  handleCancel: () => void;
}

// Per-target dirty detection — tracked changes only (lesson #4927). The
// confirm dialog flags this as the "force-required" risk; the IPC layer
// still gets `force: true` for every bulk remove (the user typed the
// count, so the gate has consumed the irreversibility consent).
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
    const changes = worktree.worktreeChanges?.changes ?? [];
    const trackedChangeCount = changes.filter(
      (c) => c.status !== "untracked" && c.status !== "ignored"
    ).length;
    const untrackedFileCount = changes.filter((c) => c.status === "untracked").length;
    targets.push({
      id,
      name: worktree.name,
      branch: worktree.branch ?? null,
      path: worktree.path,
      trackedChangeCount,
      untrackedFileCount,
      aheadCount: worktree.aheadCount ?? 0,
    });
  }
  return { targets, excludedMainCount };
}

/**
 * Bulk-remove orchestrator for the Worktrees overview multi-select bar.
 *
 * Snapshots the selection at confirm-click time (lesson #4729 — reactive
 * derivations of the worktree list silently shrink as removals land),
 * runs deletes through a p-queue capped at concurrency 4 (the same
 * pattern terminal bulk restart uses, sidestepping the worktree:delete
 * 10/10s rate limit on bursts > 10), and emits a single summary toast
 * — past-tense for all-success, warning for partial, error for total
 * failure. All selection is cleared regardless of outcome; the modal
 * itself is the retry surface.
 */
export function useWorktreeBulkRemove({
  selectedIds,
  worktreeMap,
  clearSelection,
}: UseWorktreeBulkRemoveArgs): UseWorktreeBulkRemoveReturn {
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);

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

  // Clean up on unmount so an aborted modal session doesn't leak a
  // half-open dialog state.
  useEffect(() => {
    return () => {
      isExecutingRef.current = false;
    };
  }, []);

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
    targetsRef.current = targets;
    excludedMainRef.current = excludedMainCount;
    setDisplayTargets(targets);
    setDisplayExcludedMain(excludedMainCount);
    setIsConfirmOpen(true);
  }, [selectedIds, worktreeMap, clearSelection]);

  const handleCancel = useCallback(() => {
    if (isExecutingRef.current) return;
    setIsConfirmOpen(false);
    // Clear the snapshot so the next open derives from the live state —
    // otherwise `typedNameTarget` and the target list rendered for any
    // out-of-dialog consumer would still reflect the previous open.
    targetsRef.current = [];
    excludedMainRef.current = 0;
    setDisplayTargets([]);
    setDisplayExcludedMain(0);
  }, []);

  const handleConfirm = useCallback(async () => {
    if (isExecutingRef.current) return;
    const targets = targetsRef.current;
    if (targets.length === 0) {
      setIsConfirmOpen(false);
      return;
    }
    isExecutingRef.current = true;
    setIsExecuting(true);

    const queue = new PQueue({ concurrency: 4, timeout: 30_000 });
    let successCount = 0;
    let stoppedDevServerCount = 0;
    let stoppedDevServerName: string | null = null;
    const failures: Array<{ name: string; reason: string }> = [];
    const total = targets.length;

    // The p-queue `timeout` rejects the outer `addAll(...)` promise with
    // a `TimeoutError` even when each individual task swallows its own
    // failures, so a single hung delete would permanently freeze the
    // confirm button without this `try/finally`. The `catch` emits a
    // fallback toast so the user knows the run aborted; the `finally`
    // unconditionally restores selection state and the executing flag.
    try {
      await queue.addAll(
        targets.map((target) => async () => {
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
            if (hadDevPreview) {
              stoppedDevServerCount++;
              stoppedDevServerName = target.name;
            }
            await worktreeClient.delete(target.id, { force: true, deleteBranch: false });
            successCount++;
          } catch (err) {
            const reason = formatErrorMessage(err, "Removal failed");
            failures.push({ name: target.branch ?? target.name, reason });
            logError(`Bulk remove failed for ${target.id}`, err);
          }
        })
      );

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
    } catch (err) {
      // p-queue timeout escape hatch. Underlying IPC calls may still
      // complete after this, but the worktree store reconciles via the
      // `worktree-removed` event so ghost completions land in the same
      // state as the cancelled run.
      logError("Bulk remove aborted", err);
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({
        type: "error",
        title: "Bulk remove aborted",
        message:
          err instanceof Error && err.name === "TimeoutError"
            ? "A removal exceeded the timeout — re-open the overview to check which worktrees remain."
            : "The removal run failed before completing.",
      });
      useAnnouncerStore.getState().announce("Bulk remove aborted", "assertive");
    } finally {
      isExecutingRef.current = false;
      setIsExecuting(false);
      setIsConfirmOpen(false);
      targetsRef.current = [];
      excludedMainRef.current = 0;
      setDisplayTargets([]);
      setDisplayExcludedMain(0);
      clearSelection();
    }
  }, [clearSelection]);

  return {
    isConfirmOpen,
    targets: displayTargets,
    excludedMainCount: displayExcludedMain,
    typedNameTarget:
      displayTargets.length === 1 ? "1 worktree" : `${displayTargets.length} worktrees`,
    isExecuting,
    handleRemoveClick,
    handleConfirm,
    handleCancel,
  };
}
