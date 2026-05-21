import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RebaseAction, RebaseEntry, RepoState, StagingStatus } from "@shared/types";
import type { ConflictMarkerScanEntry } from "@shared/types/ipc/git";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleDashed,
  CircleSlash,
  ExternalLink,
  FileIcon,
  GitMerge,
  Play,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";

type ConflictOperationState = Exclude<RepoState, "CLEAN" | "DIRTY">;

const OPERATION_LABEL: Record<ConflictOperationState, string> = {
  MERGING: "Merge",
  REBASING: "Rebase",
  CHERRY_PICKING: "Cherry-pick",
  REVERTING: "Revert",
};

const ABORT_RESTORE_SUFFIX: Record<ConflictOperationState, string> = {
  MERGING: "restores the working tree to its pre-merge state.",
  REBASING: "returns HEAD to the original branch tip.",
  CHERRY_PICKING: "restores the working tree to the state before the operation started.",
  REVERTING: "restores the working tree to the state before the operation started.",
};

const REBASE_ACTION_LABEL: Record<RebaseAction, string> = {
  pick: "pick",
  reword: "reword",
  edit: "edit",
  squash: "squash",
  fixup: "fixup",
  drop: "drop",
  exec: "exec",
  other: "step",
};

interface RebaseDisplayEntry extends RebaseEntry {
  /** Indented under a preceding pick/reword/edit to show grouping. */
  indented: boolean;
}

interface ConflictPanelProps {
  status: StagingStatus;
  worktreePath: string;
  onMarkResolved: (filePath: string) => Promise<void> | void;
  onOpenInEditor: (args: { path: string; line?: number }) => Promise<void> | void;
  onCheckoutOursTheirs: (filePath: string, side: "ours" | "theirs") => Promise<void> | void;
  onAbort: () => Promise<void>;
  onContinue: () => Promise<void>;
}

type ScanCache = Map<string, ConflictMarkerScanEntry>;

/**
 * Vertical commit-sequence rail for an in-progress rebase. The current step
 * carries the sole accent treatment in the conflict view per the accent-as-
 * scarce-resource rule — every other state uses neutral surfaces.
 */
function RebaseSequenceRail({ entries }: { entries: RebaseEntry[] }) {
  const display = useMemo<RebaseDisplayEntry[]>(() => {
    const out: RebaseDisplayEntry[] = [];
    let lastParentWasCommit = false;
    for (const entry of entries) {
      // fixup/squash visually nest under the preceding pick/reword/edit so the
      // operator can see which commit they amend without collapsing the rows.
      const indented =
        lastParentWasCommit && (entry.action === "fixup" || entry.action === "squash");
      out.push({ ...entry, indented });
      if (entry.action === "pick" || entry.action === "reword" || entry.action === "edit") {
        lastParentWasCommit = true;
      } else if (entry.action !== "fixup" && entry.action !== "squash") {
        lastParentWasCommit = false;
      }
    }
    return out;
  }, [entries]);

  if (display.length === 0) return null;

  return (
    <div className="border-b border-divider" data-testid="conflict-rebase-sequence">
      <div className="px-4 py-2 bg-overlay-subtle flex items-center">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-daintree-text/60">
          Rebase sequence
          <span className="ml-1.5 tabular-nums bg-tint/10 rounded px-1 py-0.5 text-[10px] font-medium normal-case tracking-normal">
            {display.length}
          </span>
        </span>
      </div>
      <ul
        className="px-2 py-1 flex flex-col gap-0.5 max-h-48 overflow-y-auto"
        role="list"
        aria-label="Rebase commit sequence"
      >
        {display.map((entry, idx) => (
          <RebaseSequenceRow key={`rebase-entry-${idx}`} entry={entry} />
        ))}
      </ul>
    </div>
  );
}

function RebaseSequenceRow({ entry }: { entry: RebaseDisplayEntry }) {
  const isDropped = entry.action === "drop";
  const isCurrent = entry.state === "current";
  const isDone = entry.state === "done";

  // State drives the row tone; the action keyword sits in its own column.
  const rowTone = isCurrent
    ? "text-accent-primary font-medium"
    : isDone
      ? "text-daintree-text/45"
      : "text-daintree-text/75";

  const StateIcon = isCurrent
    ? ChevronRight
    : isDone
      ? Check
      : isDropped
        ? CircleSlash
        : CircleDashed;

  return (
    <li
      className={cn(
        "flex items-center gap-2 px-2 py-1 text-xs transition-colors",
        entry.indented && "ml-4",
        rowTone
      )}
      data-testid={`rebase-entry-${entry.state}`}
      data-action={entry.action}
    >
      <StateIcon className="w-3 h-3 shrink-0" aria-hidden />
      <span
        className={cn(
          "text-[10px] uppercase tracking-wider font-mono w-12 shrink-0 text-daintree-text/55",
          isCurrent && "text-accent-primary/80"
        )}
      >
        {REBASE_ACTION_LABEL[entry.action]}
      </span>
      {entry.sha != null && entry.sha.length > 0 ? (
        <span className="font-mono text-[11px] tabular-nums text-daintree-text/55 shrink-0">
          {entry.sha.slice(0, 7)}
        </span>
      ) : (
        <span className="font-mono text-[11px] text-daintree-text/30 shrink-0">—</span>
      )}
      <TruncatedTooltip content={entry.subject || REBASE_ACTION_LABEL[entry.action]}>
        <span
          className={cn(
            "flex-1 min-w-0 truncate font-mono text-[11px]",
            isDropped && "line-through"
          )}
        >
          {entry.subject}
        </span>
      </TruncatedTooltip>
    </li>
  );
}

function splitPath(filePath: string): { dir: string; base: string } {
  const normalized = filePath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash === -1) return { dir: "", base: normalized };
  return { dir: normalized.slice(0, lastSlash), base: normalized.slice(lastSlash + 1) };
}

function buildAbortDescription(
  operationState: ConflictOperationState,
  status: StagingStatus
): string {
  const stagedCount = status.staged.length;
  const parts: string[] = [];

  if (stagedCount > 0) {
    parts.push(`Discards ${stagedCount} staged resolution${stagedCount === 1 ? "" : "s"}`);
  }

  if (
    operationState === "REBASING" &&
    status.rebaseStep != null &&
    status.rebaseTotalSteps != null &&
    status.rebaseTotalSteps > 0
  ) {
    // `rebaseStep` from `git status` is the *next* commit to replay, so the
    // already-replayed count is one less. Clamp to 0 to be safe.
    const replayed = Math.max(0, status.rebaseStep - 1);
    if (replayed > 0) {
      const replayFragment = `reverts ${replayed} of ${status.rebaseTotalSteps} replayed commit${
        replayed === 1 ? "" : "s"
      }`;
      if (parts.length > 0) {
        parts.push(`and ${replayFragment}`);
      } else {
        parts.push(replayFragment.charAt(0).toUpperCase() + replayFragment.slice(1));
      }
    }
  }

  const restore = ABORT_RESTORE_SUFFIX[operationState];

  if (parts.length === 0) {
    return `Discards the in-progress ${OPERATION_LABEL[operationState].toLowerCase()} and ${restore}`;
  }
  return `${parts.join(" ")} and ${restore}`;
}

export function ConflictPanel({
  status,
  worktreePath,
  onMarkResolved,
  onOpenInEditor,
  onCheckoutOursTheirs,
  onAbort,
  onContinue,
}: ConflictPanelProps) {
  const [isAbortOpen, setIsAbortOpen] = useState(false);
  const [pendingCheckout, setPendingCheckout] = useState<{
    filePath: string;
    side: "ours" | "theirs";
  } | null>(null);
  const [isAborting, setIsAborting] = useState(false);
  const [isContinuing, setIsContinuing] = useState(false);
  const [busyFile, setBusyFile] = useState<string | null>(null);
  const [optimisticResolved, setOptimisticResolved] = useState<Set<string>>(() => new Set());
  const [showResolved, setShowResolved] = useState(false);
  const [scanResults, setScanResults] = useState<ScanCache>(() => new Map());
  const scanKeyRef = useRef<string>("");

  const operationState = status.repoState;
  const operationKey: ConflictOperationState | null = useMemo(() => {
    if (
      operationState === "MERGING" ||
      operationState === "REBASING" ||
      operationState === "CHERRY_PICKING" ||
      operationState === "REVERTING"
    ) {
      return operationState;
    }
    return null;
  }, [operationState]);
  const operationLabel = operationKey ? OPERATION_LABEL[operationKey] : "Operation";

  // Filter optimistic resolves out of the live worklist so the row leaves the
  // list as soon as `onMarkResolved` is called. The parent status refresh
  // reconciles the set back to ground truth.
  const liveConflicts = useMemo(
    () => status.conflictedFiles.filter((c) => !optimisticResolved.has(c.path)),
    [status.conflictedFiles, optimisticResolved]
  );

  // Drop optimistic entries once they fall off the real list (resolved server-side)
  // or once the file reappears as conflicted (operation re-armed the row).
  useEffect(() => {
    if (optimisticResolved.size === 0) return;
    const realPaths = new Set(status.conflictedFiles.map((f) => f.path));
    let changed = false;
    const next = new Set<string>();
    for (const p of optimisticResolved) {
      if (realPaths.has(p)) {
        next.add(p);
      } else {
        changed = true;
      }
    }
    if (changed) setOptimisticResolved(next);
  }, [status.conflictedFiles, optimisticResolved]);

  const conflictCount = liveConflicts.length;
  const canContinue = conflictCount === 0;
  const hasStagedResolutions = status.staged.length > 0;

  // Scan for hunk counts + first-marker line. The scan key is the sorted path
  // set joined by a sentinel — it changes whenever the conflicted-files set
  // changes, which is exactly when we want a fresh read. Path-set identity
  // keeps `useEffect` from re-running on unrelated status changes.
  const scanKey = useMemo(
    () =>
      status.conflictedFiles
        .map((f) => f.path)
        .slice()
        .sort()
        .join(" "),
    [status.conflictedFiles]
  );

  useEffect(() => {
    // Encode worktreePath so two worktrees with identically-named conflicted
    // files (e.g. both have `src/app.ts`) don't share stale scan results when
    // the panel is re-rendered with a different worktree.
    const scopedKey = `${worktreePath}\0${scanKey}`;
    if (!worktreePath || scanKey === "") {
      if (scanResults.size > 0) setScanResults(new Map());
      scanKeyRef.current = scopedKey;
      return;
    }
    if (scanKeyRef.current === scopedKey) return;
    scanKeyRef.current = scopedKey;

    let cancelled = false;
    const paths = status.conflictedFiles.map((f) => f.path);
    void (async () => {
      try {
        const results = await window.electron.git.scanConflictMarkers(worktreePath, paths);
        if (cancelled) return;
        const next: ScanCache = new Map();
        for (const entry of results) {
          next.set(entry.path, entry);
        }
        setScanResults(next);
      } catch {
        if (!cancelled) setScanResults(new Map());
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [scanKey, worktreePath, status.conflictedFiles, scanResults.size]);

  const handleAbort = useCallback(async () => {
    setIsAborting(true);
    try {
      await onAbort();
      setIsAbortOpen(false);
    } finally {
      setIsAborting(false);
    }
  }, [onAbort]);

  const handleContinue = useCallback(async () => {
    setIsContinuing(true);
    try {
      await onContinue();
    } finally {
      setIsContinuing(false);
    }
  }, [onContinue]);

  const handleMarkResolvedClick = useCallback(
    async (filePath: string) => {
      setBusyFile(filePath);
      setOptimisticResolved((prev) => {
        if (prev.has(filePath)) return prev;
        const next = new Set(prev);
        next.add(filePath);
        return next;
      });
      try {
        await onMarkResolved(filePath);
      } catch (err) {
        // Roll back optimistic resolution if the stage failed — the row should
        // reappear so the user can retry.
        setOptimisticResolved((prev) => {
          if (!prev.has(filePath)) return prev;
          const next = new Set(prev);
          next.delete(filePath);
          return next;
        });
        throw err;
      } finally {
        setBusyFile((current) => (current === filePath ? null : current));
      }
    },
    [onMarkResolved]
  );

  const handleCheckoutSide = useCallback(
    async (filePath: string, side: "ours" | "theirs") => {
      setBusyFile(filePath);
      setOptimisticResolved((prev) => {
        if (prev.has(filePath)) return prev;
        const next = new Set(prev);
        next.add(filePath);
        return next;
      });
      try {
        await onCheckoutOursTheirs(filePath, side);
      } catch (err) {
        setOptimisticResolved((prev) => {
          if (!prev.has(filePath)) return prev;
          const next = new Set(prev);
          next.delete(filePath);
          return next;
        });
        throw err;
      } finally {
        setBusyFile((current) => (current === filePath ? null : current));
      }
    },
    [onCheckoutOursTheirs]
  );

  const handleOpenRow = useCallback(
    (filePath: string) => {
      const entry = scanResults.get(filePath);
      const line = entry?.firstMarkerLine ?? undefined;
      void onOpenInEditor(line != null ? { path: filePath, line } : { path: filePath });
    },
    [scanResults, onOpenInEditor]
  );

  const abortDescription = operationKey
    ? buildAbortDescription(operationKey, status)
    : "Discards the in-progress operation.";

  // Rebase swaps which side is "ours" vs "theirs": "ours" is the destination
  // branch, "theirs" is the commit being replayed. Surface the clarification
  // as a tooltip so the labels stay terse but the semantics are discoverable.
  const isRebase = operationKey === "REBASING";
  const oursHint = isRebase ? "Take ours (destination branch)" : "Take ours";
  const theirsHint = isRebase ? "Take theirs (incoming commit)" : "Take theirs";

  return (
    <div data-testid="conflict-panel">
      {/* Region 1: Operation chrome */}
      <div className="px-4 py-3 bg-status-warning/10 border-b border-divider">
        <div className="flex items-start gap-2">
          <GitMerge className="w-4 h-4 text-status-warning mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-sm font-semibold text-daintree-text">
                Resolve {operationLabel} Conflicts
              </span>
              {operationState === "REBASING" &&
                status.rebaseStep != null &&
                status.rebaseTotalSteps != null && (
                  <span
                    className="text-[11px] tabular-nums text-daintree-text/70 bg-tint/[0.08] border border-tint/[0.08] rounded px-1.5 py-0.5"
                    data-testid="conflict-rebase-progress"
                  >
                    Step {status.rebaseStep} of {status.rebaseTotalSteps}
                  </span>
                )}
            </div>
            <p className="text-xs text-daintree-text/60 mt-0.5">
              {conflictCount > 0
                ? `${conflictCount} conflicted file${conflictCount !== 1 ? "s" : ""} — resolve each, then continue.`
                : hasStagedResolutions
                  ? "All conflicts resolved. Continue to finish the operation."
                  : "No conflicts remaining. Continue to finish the operation."}
            </p>
          </div>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setIsAbortOpen(true)}
            disabled={isAborting || isContinuing}
            className="shrink-0 text-daintree-text/60 hover:text-status-error"
            data-testid="conflict-abort"
          >
            <XCircle className="w-3 h-3" />
            Abort {operationLabel.toLowerCase()}
          </Button>
        </div>
      </div>

      {/* Rebase commit sequence (merge backend only) — surfaced between the
          operation chrome and the worklist so operators see which commit
          they're inside before they touch files. */}
      {operationState === "REBASING" && status.rebaseSequence != null && (
        <RebaseSequenceRail entries={status.rebaseSequence.entries} />
      )}

      {/* Region 2: Conflict worklist */}
      <div className="border-b border-divider">
        <div className="flex items-center justify-between px-4 py-2 bg-overlay-subtle">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-daintree-text/60">
            Conflicted
            <span className="ml-1.5 tabular-nums bg-tint/10 rounded px-1 py-0.5 text-[10px] font-medium normal-case tracking-normal">
              {conflictCount}
            </span>
          </span>
        </div>
        {conflictCount > 0 ? (
          <ul className="px-2 py-1 flex flex-col gap-0.5" role="list">
            {liveConflicts.map((file) => {
              const { dir, base } = splitPath(file.path);
              const isBusy = busyFile === file.path;
              const scan = scanResults.get(file.path);
              const hunkCount = scan?.hunkCount ?? null;
              return (
                <li
                  key={`conflict-${file.path}`}
                  className={cn(
                    "flex items-center gap-2 px-2 py-1.5 rounded text-xs",
                    "hover:bg-tint/5 transition-colors"
                  )}
                >
                  <AlertTriangle className="w-3 h-3 shrink-0 text-status-error" />
                  <FileIcon className="w-3 h-3 shrink-0 text-daintree-text/40" />
                  <TruncatedTooltip content={`${file.path} (${file.label})`}>
                    <div className="flex-1 min-w-0 flex items-baseline">
                      {dir && (
                        <span className="shrink truncate text-daintree-text/50 font-mono text-[11px]">
                          {dir}/
                        </span>
                      )}
                      <span className="shrink truncate text-daintree-text font-medium font-mono text-[11px]">
                        {base}
                      </span>
                      <span className="ml-2 text-[10px] uppercase tracking-wider text-daintree-text/50 font-mono">
                        {file.label}
                      </span>
                    </div>
                  </TruncatedTooltip>
                  {hunkCount != null && hunkCount > 0 && (
                    <span
                      className="shrink-0 tabular-nums bg-tint/10 rounded px-1 py-0.5 text-[10px] font-medium text-daintree-text/70"
                      title={`${hunkCount} conflict ${hunkCount === 1 ? "region" : "regions"}`}
                      data-testid={`conflict-hunk-count-${file.path}`}
                    >
                      {hunkCount}
                    </span>
                  )}
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setPendingCheckout({ filePath: file.path, side: "ours" });
                      }}
                      disabled={isBusy}
                      className="h-5 px-1.5 text-[10px]"
                      aria-label={`Take ours for ${file.path}`}
                      title={oursHint}
                    >
                      Take ours
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setPendingCheckout({ filePath: file.path, side: "theirs" });
                      }}
                      disabled={isBusy}
                      className="h-5 px-1.5 text-[10px]"
                      aria-label={`Take theirs for ${file.path}`}
                      title={theirsHint}
                    >
                      Take theirs
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleOpenRow(file.path)}
                      disabled={isBusy}
                      className="h-5 px-1.5 text-[10px]"
                      aria-label={`Open ${file.path} in external editor`}
                    >
                      <ExternalLink className="w-3 h-3 mr-1" />
                      Open
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        handleMarkResolvedClick(file.path).catch(() => {});
                      }}
                      disabled={isBusy}
                      className="h-5 px-1.5 text-[10px]"
                      aria-label={`Mark ${file.path} as resolved`}
                    >
                      {isBusy ? (
                        <Spinner size="sm" className="mr-1" />
                      ) : (
                        <Check className="w-3 h-3 mr-1" />
                      )}
                      Mark resolved
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState variant="user-cleared" scale="sidebar" title="All conflicts resolved" />
        )}

        {/* Resolved disclosure — recedes when conflicts remain, collapsed by default. */}
        {hasStagedResolutions && (
          <div className="border-t border-divider/50">
            <button
              type="button"
              onClick={() => setShowResolved((v) => !v)}
              className="w-full flex items-center gap-1.5 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-daintree-text/50 hover:text-daintree-text/70 hover:bg-overlay-subtle transition-colors"
              aria-expanded={showResolved}
              data-testid="conflict-resolved-toggle"
            >
              <ChevronRight
                className={cn(
                  "w-3 h-3 transition-transform duration-150 ease-out",
                  showResolved && "rotate-90"
                )}
              />
              Resolved
              <span className="tabular-nums bg-tint/[0.06] rounded px-1 py-0.5 text-[10px] font-medium normal-case tracking-normal text-daintree-text/50">
                {status.staged.length}
              </span>
            </button>
            {showResolved && (
              <ul
                className="px-2 pb-1 flex flex-col gap-0.5"
                role="list"
                data-testid="conflict-resolved-list"
              >
                {status.staged.map((file) => {
                  const { dir, base } = splitPath(file.path);
                  return (
                    <li
                      key={`resolved-${file.path}`}
                      className="flex items-center gap-2 px-2 py-1 text-xs"
                    >
                      <Check className="w-3 h-3 shrink-0 text-status-success/60" />
                      <TruncatedTooltip content={file.path}>
                        <div className="flex-1 min-w-0 flex items-baseline">
                          {dir && (
                            <span className="shrink truncate text-daintree-text/40 font-mono text-[11px]">
                              {dir}/
                            </span>
                          )}
                          <span className="shrink truncate text-daintree-text/60 font-mono text-[11px]">
                            {base}
                          </span>
                        </div>
                      </TruncatedTooltip>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Region 3: Continue action */}
      <div className="p-3 border-t border-divider">
        <Button
          variant="default"
          size="sm"
          onClick={() => void handleContinue()}
          disabled={!canContinue || isAborting || isContinuing || busyFile !== null}
          className="w-full"
          data-testid="conflict-continue"
        >
          {isContinuing ? (
            <Spinner size="sm" className="mr-1.5" />
          ) : (
            <Play className="w-3.5 h-3.5 mr-1.5" />
          )}
          Continue {operationLabel.toLowerCase()}
        </Button>
      </div>

      <ConfirmDialog
        isOpen={isAbortOpen}
        onClose={() => {
          if (!isAborting) setIsAbortOpen(false);
        }}
        title={`Abort ${operationLabel.toLowerCase()}?`}
        description={abortDescription}
        confirmLabel={`Abort ${operationLabel.toLowerCase()}`}
        cancelLabel="Keep working"
        onConfirm={() => void handleAbort()}
        isConfirmLoading={isAborting}
        variant="destructive"
      />

      <ConfirmDialog
        isOpen={pendingCheckout !== null}
        onClose={() => setPendingCheckout(null)}
        title={
          pendingCheckout ? `Take ${pendingCheckout.side} for '${pendingCheckout.filePath}'?` : ""
        }
        description={
          pendingCheckout ? (
            <span>
              Overwrites the conflicted file with the{" "}
              {pendingCheckout.side === "ours"
                ? isRebase
                  ? "destination branch"
                  : "current branch"
                : isRebase
                  ? "incoming commit"
                  : "incoming changes"}{" "}
              version. Any manual conflict edits in this file are discarded and cannot be undone.
            </span>
          ) : (
            ""
          )
        }
        confirmLabel={pendingCheckout ? `Take ${pendingCheckout.side}` : "Confirm"}
        cancelLabel="Cancel"
        variant="destructive"
        onConfirm={() => {
          if (!pendingCheckout) return;
          const { filePath, side } = pendingCheckout;
          setPendingCheckout(null);
          handleCheckoutSide(filePath, side).catch(() => {});
        }}
      />
    </div>
  );
}
