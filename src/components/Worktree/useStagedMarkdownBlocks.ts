import { useCallback, useEffect, useMemo, useState } from "react";

/** One thing the rendered diff mounts as a whole: a change, or an unchanged block. */
export interface StagedMarkdownUnit {
  key: string;
  /** Markdown pipelines it runs: two for a modified pair, one otherwise. */
  pipelines: number;
  /** Characters those pipelines parse, definitions included. */
  chars: number;
}

/**
 * How much one commit may parse. A paragraph's remark + rehype pass costs a
 * millisecond or two, a table or a highlighted fence several, so a dozen units
 * or 24 KB of source keeps a slice well inside a frame — and a first screen of
 * a typical document still lands in the first commit.
 */
export const MARKDOWN_STAGE_PIPELINES = 12;
export const MARKDOWN_STAGE_CHARS = 24 * 1024;

interface Stage {
  /** The model this stage belongs to; a new one starts over. */
  owner: unknown;
  /** The flush generation this stage has caught up with. */
  flush: number;
  admitted: ReadonlySet<string>;
}

/**
 * The next slice: units in document order that aren't mounted yet, as many as
 * fit the budget. Always at least one, so a single oversized block still
 * makes progress. Returns `admitted` itself when nothing is left.
 */
function admitBatch(
  admitted: ReadonlySet<string>,
  units: readonly StagedMarkdownUnit[]
): ReadonlySet<string> {
  let next: Set<string> | null = null;
  let pipelines = 0;
  let chars = 0;
  for (const unit of units) {
    if (admitted.has(unit.key)) continue;
    if (
      next !== null &&
      (pipelines + unit.pipelines > MARKDOWN_STAGE_PIPELINES ||
        chars + unit.chars > MARKDOWN_STAGE_CHARS)
    ) {
      break;
    }
    next ??= new Set(admitted);
    next.add(unit.key);
    pipelines += unit.pipelines;
    chars += unit.chars;
  }
  return next ?? admitted;
}

function admitAll(
  admitted: ReadonlySet<string>,
  units: readonly StagedMarkdownUnit[]
): ReadonlySet<string> {
  if (units.every((unit) => admitted.has(unit.key))) return admitted;
  const next = new Set(admitted);
  for (const unit of units) next.add(unit.key);
  return next;
}

function freshStage(owner: unknown, flush: number, units: readonly StagedMarkdownUnit[]): Stage {
  return { owner, flush, admitted: admitBatch(new Set(), units) };
}

export interface StagedMarkdownBlocks {
  /** Keys of the units that render for real; the rest show their placeholder. */
  admitted: ReadonlySet<string>;
  /**
   * Mount these now, ahead of the sweep — the units the reader has scrolled or
   * stepped to. Ignored once the model they belong to has been replaced.
   */
  admit: (keys: readonly string[]) => void;
}

/**
 * Bounded commits for the rendered Markdown diff.
 *
 * Every block runs its own unified pipeline, so a document of hundreds of
 * changed or expanded blocks would parse all of them in one synchronous
 * commit. This admits one budgeted slice per frame instead, in document order,
 * until every unit is mounted; the rest render a cheap placeholder meanwhile.
 * A mounted unit stays mounted, so units that appear later (a fold opening)
 * are staged without disturbing what is already on screen.
 *
 * `owner` names the model: a new one starts a fresh stage during the same
 * render rather than after a commit at full size. Bumping `flush` mounts every
 * current unit synchronously, for a caller that needs it all in the DOM now
 * (Select All). Frames drive the slices, so a hidden view stages nothing until
 * it is shown again.
 */
export function useStagedMarkdownBlocks(
  units: readonly StagedMarkdownUnit[],
  owner: unknown,
  flush: number
): StagedMarkdownBlocks {
  const [stage, setStage] = useState<Stage>(() => freshStage(owner, flush, units));
  const current = useMemo(
    () =>
      stage.owner !== owner
        ? freshStage(owner, flush, units)
        : stage.flush !== flush
          ? { ...stage, flush, admitted: admitAll(stage.admitted, units) }
          : stage,
    [stage, owner, flush, units]
  );

  useEffect(() => {
    if (stage !== current) {
      setStage(current);
      return;
    }
    if (units.every((unit) => stage.admitted.has(unit.key))) return;
    const frame = requestAnimationFrame(() => {
      setStage((previous) =>
        previous === stage ? { ...stage, admitted: admitBatch(stage.admitted, units) } : previous
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [stage, current, units]);

  const admit = useCallback(
    (keys: readonly string[]) => {
      setStage((previous) => {
        if (previous.owner !== owner || keys.every((key) => previous.admitted.has(key))) {
          return previous;
        }
        return { ...previous, admitted: new Set([...previous.admitted, ...keys]) };
      });
    },
    [owner]
  );

  return { admitted: current.admitted, admit };
}
