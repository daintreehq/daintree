import { useEffect, useMemo, useState } from "react";
import type { HunkData, HunkTokens } from "react-diff-view";
import {
  countHunkRows,
  DIFF_ROW_BATCH,
  sliceHunksToRowBudget,
  stageTokens,
} from "./diffRowStaging";

interface Stage {
  /** The view this stage belongs to; a new owner starts over. */
  owner: unknown;
  /** The flush generation this stage has caught up with. */
  flush: number;
  /** Rows mounted from the top. Infinity once the stage has finished. */
  mounted: number;
  /** The hunks the token fields below were built for. */
  tokenHunks: HunkData[] | null;
  /** The pass being applied. */
  target: HunkTokens | null;
  /** What rows past `applied` keep showing until the cursor reaches them. */
  base: HunkTokens | null;
  /** Rows from the top already showing `target`. */
  applied: number;
  /** Tokens handed to the table: `target` itself once it is fully applied. */
  shown: HunkTokens | null;
}

export interface StagedDiffRows {
  /** The prefix of the hunks the table should render now. */
  mountedHunks: HunkData[];
  /** Tokens the table should render now. */
  tokens: HunkTokens | null;
  /** Every row is mounted. */
  allRowsMounted: boolean;
  /** Admit rows added behind the current set (more hunks revealed) as a fresh batch. */
  extend: () => void;
}

function freshStage(owner: unknown, flush: number, rows: number): Stage {
  return {
    owner,
    flush,
    mounted: rows > DIFF_ROW_BATCH ? DIFF_ROW_BATCH : Number.POSITIVE_INFINITY,
    tokenHunks: null,
    target: null,
    base: null,
    applied: 0,
    shown: null,
  };
}

function finishedStage(
  stage: Stage,
  flush: number,
  hunks: HunkData[],
  tokens: HunkTokens | null
): Stage {
  return {
    ...stage,
    flush,
    mounted: Number.POSITIVE_INFINITY,
    tokenHunks: hunks,
    target: tokens,
    base: null,
    applied: Number.POSITIVE_INFINITY,
    shown: tokens,
  };
}

/**
 * One slice of work: highlight a batch of rows already in the table, or, once
 * every mounted row is highlighted, mount the next batch (already highlighted
 * when the pass is in). Never both, so a slice costs one batch of DOM however
 * the worker's timing lines up with the mount.
 */
function advanceStage(
  stage: Stage,
  hunks: HunkData[],
  rows: number,
  tokens: HunkTokens | null
): Stage {
  if (tokens === null) {
    const next = stage.mounted + DIFF_ROW_BATCH;
    return { ...stage, mounted: next >= rows ? Number.POSITIVE_INFINITY : next };
  }
  const sameHunks = stage.tokenHunks === hunks;
  const continuing = sameHunks && stage.target === tokens;
  const base = continuing ? stage.base : sameHunks ? stage.shown : null;
  let applied = continuing ? stage.applied : 0;
  let mounted = stage.mounted;
  if (applied < Math.min(mounted, rows)) {
    applied += DIFF_ROW_BATCH;
  } else {
    const next = mounted + DIFF_ROW_BATCH;
    mounted = next >= rows ? Number.POSITIVE_INFINITY : next;
    applied = mounted;
  }
  return {
    ...stage,
    mounted,
    tokenHunks: hunks,
    target: tokens,
    base,
    applied,
    shown: applied >= rows ? tokens : stageTokens(hunks, tokens, base, applied),
  };
}

/**
 * Bounded commits for a table that isn't windowed.
 *
 * Every row handed to react-diff-view is DOM that one commit creates and one
 * layout pass sizes, so a single hunk of thousands of rows (an added file, the
 * full-file merge) would land in one long frame, and its token pass in a second
 * one. Past `DIFF_ROW_BATCH` rows this hands the table a batch per frame
 * instead — first the plain rows, then their tokens, one slice at a time —
 * until the whole set is in the DOM exactly as it would have been without
 * staging. A set within one batch renders in full on its first commit, with its
 * tokens the moment they arrive, as it always did.
 *
 * `owner` names the view: a new one (another file, scope or layout, or a
 * collapsed file opening again) replaces every row, so it starts a fresh stage
 * during the same render rather than after a commit at full size. Bumping
 * `flush` finishes the stage synchronously, for a caller that needs every row
 * in the DOM right now (Select All). Frames drive the slices, so a hidden view
 * stages nothing until it is shown again.
 */
export function useStagedDiffRows(
  hunks: HunkData[],
  tokens: HunkTokens | null,
  owner: unknown,
  flush: number,
  enabled: boolean
): StagedDiffRows {
  const rows = useMemo(() => countHunkRows(hunks), [hunks]);
  const [stage, setStage] = useState<Stage>(() => freshStage(owner, flush, rows));
  const current =
    stage.owner !== owner
      ? freshStage(owner, flush, rows)
      : stage.flush !== flush
        ? finishedStage(stage, flush, hunks, tokens)
        : stage;

  const mountedHunks = useMemo(
    () => sliceHunksToRowBudget(hunks, current.mounted),
    [hunks, current.mounted]
  );

  // A set within one batch takes its tokens directly, and a stale pass (null)
  // clears at once: stale tokens must never sit on rows they weren't built for.
  const staged = rows > DIFF_ROW_BATCH && tokens !== null;
  const shownTokens = !staged ? tokens : current.tokenHunks === hunks ? current.shown : null;

  useEffect(() => {
    if (!enabled) return;
    if (stage !== current) {
      setStage(current);
      return;
    }
    const tokensDone =
      !staged || (stage.tokenHunks === hunks && stage.target === tokens && stage.shown === tokens);
    if (stage.mounted >= rows && tokensDone) {
      // Rows shrank under a finite budget: mark it finished, so a later
      // expansion of the same view mounts at once instead of being cut short.
      if (Number.isFinite(stage.mounted)) {
        setStage({ ...stage, mounted: Number.POSITIVE_INFINITY });
      }
      return;
    }
    const frame = requestAnimationFrame(() => {
      setStage((previous) =>
        previous === stage ? advanceStage(stage, hunks, rows, staged ? tokens : null) : previous
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [enabled, stage, current, staged, hunks, rows, tokens]);

  const extend = () => {
    setStage((previous) =>
      previous.owner === owner
        ? { ...previous, mounted: Math.min(previous.mounted, rows + DIFF_ROW_BATCH) }
        : previous
    );
  };

  return {
    mountedHunks,
    tokens: shownTokens,
    allRowsMounted: mountedHunks === hunks,
    extend,
  };
}
