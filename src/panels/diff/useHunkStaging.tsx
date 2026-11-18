import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FileDiff as FileDiffIcon, Minus, Plus, RefreshCw, XCircle } from "lucide-react";
import type { HunkData } from "react-diff-view";
import { Button } from "@/components/ui/button";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { plainMessage } from "@/components/Git/fileMutationCopy";
import { actionService } from "@/services/ActionService";
import { pluralize } from "@/lib/pluralize";
import type { GitHunkStagingResult } from "@shared/types/ipc/git";
import {
  formatHunk,
  hunksWithin,
  isPlainModification,
  parseFilePatch,
  type FilePatch,
} from "@shared/utils/patchHunks";
import { evictCachedDiffsForFile } from "./diffContentCache";

/** The side of the index a Review Hub diff shows: what Stage or Unstage acts on. */
export type HunkStagingSide = "staged" | "unstaged";

type HunkStagingOutcome =
  | { kind: "stale" }
  | { kind: "unsupported" }
  | { kind: "failed"; message: string; retry: () => void };

export interface HunkStagingNotice {
  side: HunkStagingSide;
  outcome: HunkStagingOutcome;
}

/**
 * The patch whose hunks a diff pane can stage, or null when it can't (#17331).
 *
 * Only a side-specific diff: a HEAD-to-worktree diff mixes both sides of a
 * partially staged file. Never one read with whitespace ignored: its hunks
 * aren't the change git would stage. And only a regular file changed in place.
 */
export function stageablePatch(
  content: string | undefined,
  side: HunkStagingSide | undefined,
  ignoreWhitespace: boolean
): FilePatch | null {
  if (!side || ignoreWhitespace || !content) return null;
  const patch = parseFilePatch(content);
  if (!patch || patch.hunks.length === 0 || !isPlainModification(patch.header)) return null;
  return patch;
}

function stageLabel(side: HunkStagingSide, count: number): string {
  const verb = side === "unstaged" ? "Stage" : "Unstage";
  return count === 1 ? `${verb} hunk` : `${verb} ${pluralize(count, "hunk")}`;
}

interface UseHunkStagingInput {
  /** The diff on screen, exactly as it was read. */
  content: string | undefined;
  side: HunkStagingSide | undefined;
  ignoreWhitespace: boolean;
  worktreeId: string | undefined;
  worktreePath: string;
  filePath: string | undefined;
  /** Read the diff again. */
  onReload: () => void;
}

interface UseHunkStagingResult {
  renderHunkActions: ((hunk: HunkData) => ReactNode) | undefined;
  notice: HunkStagingNotice | null;
  dismissNotice: () => void;
}

/**
 * Stage hunk and Unstage hunk for one diff pane. A rendered hunk can hold
 * several of git's (expanded context, or the full-file view, merges them), so
 * each button stages exactly the git hunks inside its header and says how many.
 * Main reads the side again before it writes and refuses a hunk that changed;
 * either way both sides' cached diffs are dropped and the pane reads again.
 */
export function useHunkStaging({
  content,
  side,
  ignoreWhitespace,
  worktreeId,
  worktreePath,
  filePath,
  onReload,
}: UseHunkStagingInput): UseHunkStagingResult {
  const patch = useMemo(
    () => stageablePatch(content, side, ignoreWhitespace),
    [content, side, ignoreWhitespace]
  );
  const target = `${worktreePath}\u0000${filePath ?? ""}\u0000${side ?? ""}`;
  // A write outlives a step to another file: its answer must not reload, or
  // report on, whatever the pane shows by then.
  const targetRef = useRef(target);
  useEffect(() => {
    targetRef.current = target;
  }, [target]);

  const inFlightRef = useRef(false);
  const [pendingTarget, setPendingTarget] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ target: string; notice: HunkStagingNotice } | null>(null);

  const stage = useCallback(
    async (indices: readonly number[]): Promise<void> => {
      if (!patch || !side || !filePath || inFlightRef.current) return;
      inFlightRef.current = true;
      const requestTarget = target;
      setPendingTarget(requestTarget);
      const show = (outcome: HunkStagingOutcome | null) => {
        if (targetRef.current !== requestTarget) return;
        setNotice(outcome ? { target: requestTarget, notice: { side, outcome } } : null);
      };
      try {
        const result = await actionService.dispatch<GitHunkStagingResult>(
          side === "unstaged" ? "git.stageHunk" : "git.unstageHunk",
          {
            ...(worktreeId ? { worktreeId } : { worktreePath }),
            filePath,
            hunks: indices.map((index) => formatHunk(patch.hunks[index]!)),
          },
          { source: "user" }
        );
        if (!result.ok) {
          show({
            kind: "failed",
            message: plainMessage(result.error.details, result.error.message),
            retry: () => void stage(indices),
          });
          return;
        }
        // Every answer read the side again, so the diff on screen may be old
        // even when nothing was written.
        evictCachedDiffsForFile(worktreePath, filePath);
        const { status } = result.result;
        show(status === "applied" ? null : { kind: status });
        if (targetRef.current === requestTarget) onReload();
      } finally {
        inFlightRef.current = false;
        setPendingTarget(null);
      }
    },
    [patch, side, filePath, target, worktreeId, worktreePath, onReload]
  );

  const pending = pendingTarget === target;
  const renderHunkActions = useMemo(() => {
    if (!patch || !side) return undefined;
    const renderActions = (hunk: HunkData) => {
      const indices = hunksWithin(patch, hunk);
      if (indices.length === 0) return null;
      return (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={pending}
          onClick={() => void stage(indices)}
          data-hunk-staging={side === "unstaged" ? "stage" : "unstage"}
        >
          {side === "unstaged" ? <Plus /> : <Minus />}
          {stageLabel(side, indices.length)}
        </Button>
      );
    };
    return renderActions;
  }, [patch, side, pending, stage]);

  const dismissNotice = useCallback(() => setNotice(null), []);

  return {
    renderHunkActions,
    notice: notice && notice.target === target ? notice.notice : null,
    dismissNotice,
  };
}

const STALE_COPY: Record<HunkStagingSide, string> = {
  unstaged: "Nothing was staged. The diff now shows the file as it is.",
  staged: "Nothing was unstaged. The diff now shows the index as it is.",
};

/** What a hunk stage or unstage that wrote nothing has to say. */
export function HunkStagingBanner({
  notice,
  onDismiss,
}: {
  notice: HunkStagingNotice;
  onDismiss: () => void;
}) {
  const { side, outcome } = notice;
  if (outcome.kind === "stale") {
    return (
      <InlineStatusBanner
        severity="info"
        icon={FileDiffIcon}
        title="Hunk changed since this diff loaded"
        description={STALE_COPY[side]}
        role="status"
        ariaLive="polite"
        onClose={onDismiss}
        closeAriaLabel="Dismiss"
      />
    );
  }
  const title = side === "unstaged" ? "Couldn't stage hunk" : "Couldn't unstage hunk";
  if (outcome.kind === "unsupported") {
    return (
      <InlineStatusBanner
        severity="warning"
        icon={XCircle}
        title={title}
        description={
          side === "unstaged"
            ? "Git can't stage this file a hunk at a time. Stage the whole file instead."
            : "Git can't unstage this file a hunk at a time. Unstage the whole file instead."
        }
        role="status"
        ariaLive="polite"
        onClose={onDismiss}
        closeAriaLabel="Dismiss"
      />
    );
  }
  return (
    <InlineStatusBanner
      severity="error"
      icon={XCircle}
      title={title}
      description={outcome.message}
      role="alert"
      action={{
        id: "retry-hunk-staging",
        label: "Retry",
        icon: RefreshCw,
        variant: "dangerFilled",
        onClick: outcome.retry,
      }}
      onClose={onDismiss}
      closeAriaLabel="Dismiss"
    />
  );
}
