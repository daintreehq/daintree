import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { RebaseAction, RebaseEntry, StagingStatus } from "@shared/types";
import type { ConflictMarkerScanEntry } from "@shared/types/ipc/git";
import { cn } from "@/lib/utils";
import { PathTail } from "@/components/ui/PathTail";
import { UI_EXIT_DURATION } from "@/lib/animationUtils";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleDashed,
  CircleSlash,
  ExternalLink,
  GitMerge,
  MoreHorizontal,
  Play,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuMeta,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  REVIEW_HUB_COUNT_CHIP,
  REVIEW_HUB_DISABLED_CTA,
  REVIEW_HUB_STICKY_BAND,
} from "./reviewHubUtils";
import {
  OPERATION_LABEL,
  buildAbortDescription,
  toRepoOperationState,
  type RepoOperationState,
} from "@/components/Git/repoOperationCopy";

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
 * Vertical commit-sequence rail for an in-progress rebase. Entirely neutral:
 * the conflict view's one accent belongs to Continue.
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
      <div className={REVIEW_HUB_STICKY_BAND}>
        <div className="px-4 py-2 bg-overlay-subtle flex items-center">
          <span className="text-2xs font-semibold uppercase tracking-wider text-text-secondary">
            Rebase sequence
            <span className={REVIEW_HUB_COUNT_CHIP}>{display.length}</span>
          </span>
        </div>
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

  // Neutral weight carries the whole rail: the current step is the brightest,
  // heaviest row on a lifted surface, done steps recede furthest. Accent stays
  // with Continue — the one action this view exists to reach.
  const rowTone = isCurrent
    ? "text-text-primary font-medium bg-overlay-subtle"
    : "text-text-secondary";

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
        "flex items-center gap-2 px-2 py-1 rounded-sm text-xs transition-colors",
        entry.indented && "ml-4",
        rowTone
      )}
      data-testid={`rebase-entry-${entry.state}`}
      data-action={entry.action}
      aria-current={isCurrent ? "step" : undefined}
    >
      <StateIcon className="w-3 h-3 shrink-0" aria-hidden />
      <span className="text-3xs uppercase tracking-wider font-mono w-12 shrink-0">
        {REBASE_ACTION_LABEL[entry.action]}
      </span>
      {entry.sha != null && entry.sha.length > 0 ? (
        <span className="font-mono text-2xs tabular-nums shrink-0">{entry.sha.slice(0, 7)}</span>
      ) : (
        <span className="font-mono text-2xs shrink-0" aria-hidden>
          —
        </span>
      )}
      <TruncatedTooltip content={entry.subject || REBASE_ACTION_LABEL[entry.action]}>
        <span
          className={cn("flex-1 min-w-0 truncate font-mono text-2xs", isDropped && "line-through")}
        >
          {entry.subject}
        </span>
      </TruncatedTooltip>
      {isCurrent && <span className="sr-only">(current step)</span>}
      {isDone && <span className="sr-only">(done)</span>}
      {isDropped && <span className="sr-only">(dropped)</span>}
    </li>
  );
}

function splitPath(filePath: string): { dir: string; base: string } {
  const normalized = filePath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash === -1) return { dir: "", base: normalized };
  return { dir: normalized.slice(0, lastSlash), base: normalized.slice(lastSlash + 1) };
}

type Side = "ours" | "theirs";

// A dialog's exit plus a margin for its focus restore to run first.
const DIALOG_EXIT_SETTLE_MS = UI_EXIT_DURATION * 2 + 60;

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
    side: Side;
  } | null>(null);
  const [pendingMarkerConfirm, setPendingMarkerConfirm] = useState<{
    filePath: string;
    // `null` when the re-read failed, so nothing is known either way.
    hunkCount: number | null;
  } | null>(null);
  const [isAborting, setIsAborting] = useState(false);
  const [isContinuing, setIsContinuing] = useState(false);
  const [busyFile, setBusyFile] = useState<string | null>(null);
  const [optimisticResolved, setOptimisticResolved] = useState<Set<string>>(() => new Set());
  const [showResolved, setShowResolved] = useState(false);
  const [scanResults, setScanResults] = useState<ScanCache>(() => new Map());
  const [scanNonce, setScanNonce] = useState(0);
  const scanKeyRef = useRef<string>("");
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const continueRef = useRef<HTMLDivElement>(null);
  // Where focus goes once a row the user was working in leaves the list.
  // `null` means Continue; `undefined` means nothing is pending.
  const pendingFocusRef = useRef<{ path: string | null } | undefined>(undefined);
  const focusRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resolvedListId = useId();
  const summaryId = useId();

  const operationState = status.repoState;
  const operationKey: RepoOperationState | null = useMemo(
    () => toRepoOperationState(operationState),
    [operationState]
  );
  const operationLabel = operationKey ? OPERATION_LABEL[operationKey] : "Operation";
  const operationNoun = operationLabel.toLowerCase();

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

  // A row that leaves the list takes its focused control with it, which would
  // drop the keyboard user on <body>. Hand focus to the neighbouring file's
  // Open, or to Continue once the last conflict is gone. Plain programmatic
  // focus, so Chromium's own heuristic decides whether it rings.
  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (pending === undefined) return;
    const target =
      pending.path !== null
        ? rowRefs.current.get(pending.path)?.querySelector<HTMLButtonElement>("button")
        : continueRef.current?.querySelector<HTMLButtonElement>("button");
    if (!target) return;
    pendingFocusRef.current = undefined;
    target.focus({ preventScroll: true });
    // A confirm dialog that resolved the row is still closing here, and its own
    // restore aims at a trigger that no longer exists — landing on <body>.
    // Re-apply once its exit has run.
    if (focusRetryRef.current) clearTimeout(focusRetryRef.current);
    focusRetryRef.current = setTimeout(() => {
      focusRetryRef.current = null;
      const active = document.activeElement;
      if (target.isConnected && (active === null || active === document.body)) {
        target.focus({ preventScroll: true });
      }
    }, DIALOG_EXIT_SETTLE_MS);
  }, [liveConflicts]);

  useEffect(
    () => () => {
      if (focusRetryRef.current) clearTimeout(focusRetryRef.current);
    },
    []
  );

  const conflictCount = liveConflicts.length;
  const canContinue = conflictCount === 0;
  const hasStagedResolutions = status.staged.length > 0;
  const continueBlocked = !canContinue || isAborting || isContinuing || busyFile !== null;

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

  // Resolving happens in the user's editor, so the path set alone never
  // notices a region being fixed. Rescan whenever the app regains focus.
  useEffect(() => {
    const onFocus = () => setScanNonce((n) => n + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    // Encode worktreePath so two worktrees with identically-named conflicted
    // files (e.g. both have `src/app.ts`) don't share stale scan results when
    // the panel is re-rendered with a different worktree.
    const scopedKey = `${worktreePath}\0${scanKey}\0${scanNonce}`;
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
  }, [scanKey, scanNonce, worktreePath, status.conflictedFiles, scanResults.size]);

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
    // `aria-disabled` keeps Continue focusable, so the veto lives here.
    if (continueBlocked) return;
    setIsContinuing(true);
    try {
      await onContinue();
    } finally {
      setIsContinuing(false);
    }
  }, [continueBlocked, onContinue]);

  // Read at the moment of intent: by the time a resolve starts, the busy row
  // has disabled the control that held focus, or a dialog holds it.
  const rowHasFocus = (filePath: string): boolean => {
    const row = rowRefs.current.get(filePath);
    const active = document.activeElement;
    return !!row && !!active && row.contains(active);
  };

  const resolveOptimistically = useCallback(
    async (filePath: string, handOffFocus: boolean, run: () => Promise<void> | void) => {
      if (handOffFocus) {
        const idx = liveConflicts.findIndex((c) => c.path === filePath);
        const neighbour = liveConflicts[idx + 1] ?? liveConflicts[idx - 1];
        pendingFocusRef.current = { path: neighbour ? neighbour.path : null };
      }
      setBusyFile(filePath);
      setOptimisticResolved((prev) => {
        if (prev.has(filePath)) return prev;
        const next = new Set(prev);
        next.add(filePath);
        return next;
      });
      try {
        await run();
      } catch (err) {
        // Roll back optimistic resolution if the operation failed — the row
        // should reappear so the user can retry.
        pendingFocusRef.current = undefined;
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
    [liveConflicts]
  );

  const markResolved = useCallback(
    (filePath: string, handOffFocus: boolean) =>
      resolveOptimistically(filePath, handOffFocus, () => onMarkResolved(filePath)),
    [resolveOptimistically, onMarkResolved]
  );

  // `git add` stages marker text as happily as a resolution. Re-read the file
  // first and make leftover markers — or a re-read that failed — a deliberate
  // choice rather than something staged silently.
  const handleMarkResolvedClick = useCallback(
    async (filePath: string) => {
      const handOffFocus = rowHasFocus(filePath);
      setBusyFile(filePath);
      let hunkCount: number | null;
      try {
        const [entry] = await window.electron.git.scanConflictMarkers(worktreePath, [filePath]);
        hunkCount = entry?.hunkCount ?? 0;
      } catch {
        hunkCount = null;
      } finally {
        setBusyFile((current) => (current === filePath ? null : current));
      }
      if (hunkCount !== 0) {
        setPendingMarkerConfirm({ filePath, hunkCount });
        return;
      }
      await markResolved(filePath, handOffFocus);
    },
    [worktreePath, markResolved]
  );

  const handleCheckoutSide = useCallback(
    (filePath: string, side: Side) =>
      resolveOptimistically(filePath, true, () => onCheckoutOursTheirs(filePath, side)),
    [resolveOptimistically, onCheckoutOursTheirs]
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
  // branch, "theirs" is the commit being replayed. Every surface that offers a
  // side names what it actually is, so the swap never has to be remembered.
  const isRebase = operationKey === "REBASING";
  const sideSource: Record<Side, string> = isRebase
    ? { ours: "destination branch", theirs: "incoming commit" }
    : { ours: "current branch", theirs: "incoming changes" };

  const isRebaseMidSequence =
    isRebase &&
    status.rebaseStep != null &&
    status.rebaseTotalSteps != null &&
    status.rebaseStep < status.rebaseTotalSteps;
  const summary =
    conflictCount > 0
      ? `${conflictCount} conflicted file${conflictCount !== 1 ? "s" : ""} — resolve each, then continue`
      : isRebaseMidSequence
        ? "Continue to replay the remaining commits"
        : `Continue to finish the ${operationNoun}`;

  return (
    <div data-testid="conflict-panel">
      {/* Region 1: Operation chrome. Warning-tinted only while something still
          needs the user; once nothing does, it steps down to a neutral band. */}
      <div
        className={cn(
          "px-4 py-3 border-b border-divider",
          conflictCount > 0 ? "bg-status-warning/10" : "bg-overlay-subtle"
        )}
      >
        <div className="flex items-start gap-2">
          <GitMerge
            className={cn(
              "w-4 h-4 mt-0.5 shrink-0",
              conflictCount > 0 ? "text-status-warning" : "text-text-secondary"
            )}
            aria-hidden
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2 flex-wrap">
              <h3 className="text-sm font-semibold text-text-primary">
                {conflictCount > 0
                  ? `Resolve ${operationNoun} conflicts`
                  : `Ready to continue ${operationNoun}`}
              </h3>
              {operationState === "REBASING" &&
                status.rebaseStep != null &&
                status.rebaseTotalSteps != null && (
                  <Badge
                    size="xs"
                    tone="outline"
                    className="text-2xs tabular-nums"
                    data-testid="conflict-rebase-progress"
                  >
                    Step {status.rebaseStep} of {status.rebaseTotalSteps}
                  </Badge>
                )}
            </div>
            <p
              id={summaryId}
              className="text-xs text-text-secondary mt-0.5"
              role="status"
              aria-live="polite"
            >
              {summary}
            </p>
          </div>
          <Button
            variant="ghost-danger"
            size="xs"
            onClick={() => setIsAbortOpen(true)}
            disabled={isAborting || isContinuing}
            className="shrink-0"
            data-testid="conflict-abort"
          >
            Abort {operationNoun}
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
        <div className={REVIEW_HUB_STICKY_BAND}>
          <div className="flex items-center justify-between px-4 py-2 bg-overlay-subtle">
            <span className="text-2xs font-semibold uppercase tracking-wider text-text-secondary">
              Conflicted
              <span className={REVIEW_HUB_COUNT_CHIP}>{conflictCount}</span>
            </span>
          </div>
        </div>
        {conflictCount > 0 ? (
          <ul className="px-2 py-1 flex flex-col gap-0.5" role="list" aria-label="Conflicted files">
            {liveConflicts.map((file) => {
              const { dir, base } = splitPath(file.path);
              const isBusy = busyFile === file.path;
              const scan = scanResults.get(file.path);
              const hunkCount = scan?.hunkCount ?? null;
              return (
                <li
                  key={`conflict-${file.path}`}
                  ref={(el) => {
                    if (el) rowRefs.current.set(file.path, el);
                    else rowRefs.current.delete(file.path);
                  }}
                  className="flex items-center gap-2 pl-2 pr-1 py-1 rounded-sm text-xs hover:bg-tint/5 transition-colors"
                >
                  <AlertTriangle className="w-3 h-3 shrink-0 text-status-error" aria-hidden />
                  <TruncatedTooltip content={`${file.path} (${file.label})`}>
                    <div className="flex-1 min-w-0 flex items-baseline gap-2">
                      {/* The directory gives way first; the basename is the
                          file's identity and truncates only once the
                          directory is gone. */}
                      <span className="min-w-0 flex items-baseline font-mono text-2xs">
                        {dir && (
                          <PathTail className="min-w-0 text-text-secondary">{`${dir}/`}</PathTail>
                        )}
                        <span className="shrink-0 max-w-full truncate text-text-primary font-medium">
                          {base}
                        </span>
                      </span>
                      <span className="shrink-0 whitespace-nowrap text-3xs uppercase tracking-wider text-text-secondary font-mono">
                        {file.label}
                      </span>
                      {hunkCount != null && hunkCount > 0 && (
                        <span
                          className="shrink-0 whitespace-nowrap text-3xs tabular-nums text-text-secondary"
                          data-testid={`conflict-hunk-count-${file.path}`}
                        >
                          {hunkCount} {hunkCount === 1 ? "region" : "regions"}
                        </span>
                      )}
                    </div>
                  </TruncatedTooltip>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => handleOpenRow(file.path)}
                      disabled={isBusy}
                      aria-label={`Open ${file.path} in external editor`}
                    >
                      <ExternalLink aria-hidden />
                      Open
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => {
                        handleMarkResolvedClick(file.path).catch(() => {});
                      }}
                      disabled={isBusy}
                      aria-label={`Mark ${file.path} as resolved`}
                    >
                      {isBusy ? <Spinner size="xs" /> : <Check aria-hidden />}
                      Mark resolved
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          disabled={isBusy}
                          aria-label={`More actions for ${file.path}`}
                        >
                          <MoreHorizontal aria-hidden />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-[220px]">
                        {(["ours", "theirs"] as const).map((side) => (
                          <DropdownMenuItem
                            key={side}
                            destructive
                            onSelect={() => setPendingCheckout({ filePath: file.path, side })}
                            aria-label={`Use ${sideSource[side]} version of ${file.path} (${side})`}
                          >
                            Use {sideSource[side]} version
                            <DropdownMenuMeta>{side}</DropdownMenuMeta>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
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
              className="w-full flex items-center gap-1.5 px-4 py-1.5 text-2xs font-semibold uppercase tracking-wider text-text-secondary hover:text-text-primary hover:bg-overlay-subtle transition-colors"
              aria-expanded={showResolved}
              aria-controls={resolvedListId}
              data-testid="conflict-resolved-toggle"
            >
              <ChevronRight
                className={cn(
                  "w-3 h-3 transition-transform duration-150 ease-out",
                  showResolved && "rotate-90"
                )}
                aria-hidden
              />
              Resolved
              <span className={cn(REVIEW_HUB_COUNT_CHIP, "ml-0")}>{status.staged.length}</span>
            </button>
            {/* Kept mounted while collapsed so `aria-controls` always names a
                real element. */}
            <ul
              id={resolvedListId}
              hidden={!showResolved}
              className="px-2 pb-1 flex flex-col gap-0.5"
              role="list"
              aria-label="Resolved files"
              data-testid="conflict-resolved-list"
            >
              {status.staged.map((file) => {
                const { dir, base } = splitPath(file.path);
                return (
                  <li
                    key={`resolved-${file.path}`}
                    className="flex items-center gap-2 pl-2 pr-1 py-1 text-xs"
                  >
                    <Check className="w-3 h-3 shrink-0 text-text-secondary" aria-hidden />
                    <TruncatedTooltip content={file.path}>
                      <div className="flex-1 min-w-0 flex items-baseline font-mono text-2xs">
                        {dir && (
                          <PathTail className="min-w-0 text-text-muted">{`${dir}/`}</PathTail>
                        )}
                        <span className="shrink-0 max-w-full truncate text-text-secondary">
                          {base}
                        </span>
                      </div>
                    </TruncatedTooltip>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      {/* Region 3: Continue action */}
      <div ref={continueRef} className="p-3 border-t border-divider">
        <Button
          variant="default"
          size="sm"
          onClick={() => void handleContinue()}
          aria-disabled={continueBlocked || undefined}
          aria-describedby={summaryId}
          className={cn("w-full", REVIEW_HUB_DISABLED_CTA)}
          data-testid="conflict-continue"
        >
          {isContinuing ? <Spinner size="sm" /> : <Play aria-hidden />}
          Continue {operationNoun}
        </Button>
      </div>

      <ConfirmDialog
        isOpen={isAbortOpen}
        onClose={() => {
          if (!isAborting) setIsAbortOpen(false);
        }}
        title={`Abort ${operationNoun}?`}
        description={abortDescription}
        confirmLabel={`Abort ${operationNoun}`}
        cancelLabel="Keep working"
        onConfirm={() => void handleAbort()}
        isConfirmLoading={isAborting}
        variant="destructive"
      />

      <ConfirmDialog
        isOpen={pendingCheckout !== null}
        onClose={() => setPendingCheckout(null)}
        title={
          pendingCheckout
            ? `Use the ${sideSource[pendingCheckout.side]} version of '${splitPath(pendingCheckout.filePath).base}'?`
            : ""
        }
        description={
          pendingCheckout ? (
            <span>
              Overwrites <span className="font-mono break-all">{pendingCheckout.filePath}</span>{" "}
              with the {sideSource[pendingCheckout.side]} version. Any manual conflict edits in this
              file are discarded and cannot be undone.
            </span>
          ) : (
            ""
          )
        }
        confirmLabel={pendingCheckout ? `Use ${sideSource[pendingCheckout.side]}` : "Confirm"}
        cancelLabel="Cancel"
        variant="destructive"
        onConfirm={() => {
          if (!pendingCheckout) return;
          const { filePath, side } = pendingCheckout;
          setPendingCheckout(null);
          handleCheckoutSide(filePath, side).catch(() => {});
        }}
      />

      <ConfirmDialog
        isOpen={pendingMarkerConfirm !== null}
        onClose={() => setPendingMarkerConfirm(null)}
        title={
          pendingMarkerConfirm
            ? pendingMarkerConfirm.hunkCount === null
              ? `Mark '${splitPath(pendingMarkerConfirm.filePath).base}' resolved without checking?`
              : `Mark '${splitPath(pendingMarkerConfirm.filePath).base}' resolved?`
            : ""
        }
        description={
          pendingMarkerConfirm ? (
            pendingMarkerConfirm.hunkCount === null ? (
              <span>
                Couldn&apos;t re-read{" "}
                <span className="font-mono break-all">{pendingMarkerConfirm.filePath}</span> to
                check for leftover conflict markers. Marking it resolved stages the file exactly as
                it is.
              </span>
            ) : (
              <span>
                <span className="font-mono break-all">{pendingMarkerConfirm.filePath}</span> still
                has {pendingMarkerConfirm.hunkCount} conflict{" "}
                {pendingMarkerConfirm.hunkCount === 1 ? "region" : "regions"}. Marking it resolved
                stages the conflict markers as file content.
              </span>
            )
          ) : (
            ""
          )
        }
        confirmLabel="Mark resolved"
        cancelLabel="Keep editing"
        variant="default"
        onConfirm={() => {
          if (!pendingMarkerConfirm) return;
          const { filePath } = pendingMarkerConfirm;
          setPendingMarkerConfirm(null);
          markResolved(filePath, true).catch(() => {});
        }}
      />
    </div>
  );
}
