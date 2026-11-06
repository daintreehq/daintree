// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChangeData, HunkData, HunkTokens, TokenNode } from "react-diff-view";
import { countHunkRows, DIFF_ROW_BATCH } from "../diffRowStaging";
import { useStagedDiffRows, type StagedDiffRows } from "../useStagedDiffRows";

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let originalRaf: typeof globalThis.requestAnimationFrame;
let originalCancel: typeof globalThis.cancelAnimationFrame;

beforeEach(() => {
  frames = new Map();
  nextFrame = 1;
  originalRaf = globalThis.requestAnimationFrame;
  originalCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, cb);
    return id;
  };
  globalThis.cancelAnimationFrame = (id: number) => {
    frames.delete(id);
  };
});

afterEach(() => {
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCancel;
});

function runFrame() {
  const queued = [...frames.values()];
  frames.clear();
  act(() => {
    for (const cb of queued) cb(0);
  });
}

/** Runs frames until `done`, failing (rather than spinning) if the stage stops making progress. */
function drainUntil(done: () => boolean, maxFrames = 40) {
  for (let i = 0; i < maxFrames && !done(); i++) {
    if (frames.size === 0) throw new Error("stage stalled: nothing scheduled and not done");
    runFrame();
  }
  expect(done()).toBe(true);
}

function insertsFrom(first: number, lines: number): ChangeData[] {
  const changes: ChangeData[] = [];
  for (let i = first; i < first + lines; i++) {
    changes.push({
      type: "insert",
      content: `line ${i}`,
      lineNumber: i,
      isInsert: true,
    } as ChangeData);
  }
  return changes;
}

function addedHunk(lines: number, first = 1): HunkData {
  return {
    content: `@@ -0,0 +${first},${lines} @@`,
    oldStart: 0,
    newStart: first,
    oldLines: 0,
    newLines: lines,
    changes: insertsFrom(first, lines),
  };
}

function tokensFor(lines: number, label: string): HunkTokens {
  const line = (i: number): TokenNode[] => [{ type: "text", value: `${label}${i}` }];
  return { old: [], new: Array.from({ length: lines }, (_, i) => line(i + 1)) };
}

/** How many of the table's new-side lines currently show this pass's own arrays. */
function appliedFrom(shown: HunkTokens | null, pass: HunkTokens): number {
  if (shown === null) return 0;
  let count = 0;
  pass.new.forEach((line: TokenNode[], i: number) => {
    if (shown.new[i] === line) count++;
  });
  return count;
}

const mountedRows = (hunks: HunkData[]) => countHunkRows(hunks);

interface Props {
  hunks: HunkData[];
  tokens: HunkTokens | null;
  owner: unknown;
  flush: number;
  enabled: boolean;
}

function renderStage(initial: Props, onRender?: (result: StagedDiffRows) => void) {
  return renderHook(
    (props: Props) => {
      const result = useStagedDiffRows(
        props.hunks,
        props.tokens,
        props.owner,
        props.flush,
        props.enabled
      );
      onRender?.(result);
      return result;
    },
    { initialProps: initial }
  );
}

const ROWS = DIFF_ROW_BATCH * 3 + 7;

describe("useStagedDiffRows", () => {
  it("leaves a set within one batch alone: whole on the first render, nothing scheduled", () => {
    const hunks = [addedHunk(DIFF_ROW_BATCH)];
    const { result } = renderStage({ hunks, tokens: null, owner: {}, flush: 0, enabled: true });
    expect(result.current.mountedHunks).toBe(hunks);
    expect(result.current.allRowsMounted).toBe(true);
    expect(result.current.tokens).toBeNull();
    expect(frames.size).toBe(0);
  });

  it("passes tokens straight to a small set the moment they arrive", () => {
    const hunks = [addedHunk(10)];
    const tokens = tokensFor(10, "t");
    const owner = {};
    const { result, rerender } = renderStage({
      hunks,
      tokens: null,
      owner,
      flush: 0,
      enabled: true,
    });
    rerender({ hunks, tokens, owner, flush: 0, enabled: true });
    expect(result.current.tokens).toBe(tokens);
    expect(frames.size).toBe(0);
  });

  it("mounts one batch first, then one more per frame, until the set is whole", () => {
    const hunks = [addedHunk(ROWS)];
    const { result } = renderStage({ hunks, tokens: null, owner: {}, flush: 0, enabled: true });
    expect(mountedRows(result.current.mountedHunks)).toBe(DIFF_ROW_BATCH);
    expect(result.current.allRowsMounted).toBe(false);

    let previous = DIFF_ROW_BATCH;
    drainUntil(() => {
      const now = mountedRows(result.current.mountedHunks);
      expect(now - previous).toBeLessThanOrEqual(DIFF_ROW_BATCH);
      previous = now;
      return result.current.allRowsMounted;
    });
    expect(result.current.mountedHunks).toBe(hunks);
    // Nothing left scheduled once the stage is done.
    expect(frames.size).toBe(0);
  });

  it("hands a staged table an empty pass, not none, before any tokens arrive", () => {
    // Rows past the cursor of a partial pass read `undefined`; reading the same
    // before any pass keeps their memoized props unchanged when one lands.
    const hunks = [addedHunk(ROWS)];
    const { result } = renderStage({ hunks, tokens: null, owner: {}, flush: 0, enabled: true });
    expect(result.current.tokens).not.toBeNull();
    expect(result.current.tokens!.new).toHaveLength(0);
    expect(result.current.tokens!.old).toHaveLength(0);
  });

  it("does not stage while disabled (a collapsed file)", () => {
    const hunks = [addedHunk(ROWS)];
    renderStage({ hunks, tokens: null, owner: {}, flush: 0, enabled: false });
    expect(frames.size).toBe(0);
  });

  it("highlights mounted rows a batch at a time, then mounts the rest already highlighted", () => {
    const hunks = [addedHunk(ROWS)];
    const tokens = tokensFor(ROWS, "t");
    const owner = {};
    const { result, rerender } = renderStage({
      hunks,
      tokens: null,
      owner,
      flush: 0,
      enabled: true,
    });
    runFrame(); // two batches mounted, plain
    expect(mountedRows(result.current.mountedHunks)).toBe(DIFF_ROW_BATCH * 2);

    rerender({ hunks, tokens, owner, flush: 0, enabled: true });
    // Nothing applied before the first slice: the table keeps plain rows.
    expect(appliedFrom(result.current.tokens, tokens)).toBe(0);

    runFrame();
    // Mounted rows get tokens first; no new rows join in the same slice.
    expect(appliedFrom(result.current.tokens, tokens)).toBe(DIFF_ROW_BATCH);
    expect(mountedRows(result.current.mountedHunks)).toBe(DIFF_ROW_BATCH * 2);
    expect(result.current.tokens!.new[DIFF_ROW_BATCH]).toBeUndefined();

    runFrame();
    expect(appliedFrom(result.current.tokens, tokens)).toBe(DIFF_ROW_BATCH * 2);
    expect(mountedRows(result.current.mountedHunks)).toBe(DIFF_ROW_BATCH * 2);

    runFrame();
    // Every mounted row is highlighted, so this slice mounts the next batch with its tokens.
    expect(mountedRows(result.current.mountedHunks)).toBe(DIFF_ROW_BATCH * 3);
    expect(appliedFrom(result.current.tokens, tokens)).toBe(DIFF_ROW_BATCH * 3);

    drainUntil(() => result.current.allRowsMounted && result.current.tokens === tokens);
    expect(frames.size).toBe(0);
  });

  it("keeps the previous pass on rows the new one hasn't reached yet", () => {
    const hunks = [addedHunk(ROWS)];
    const first = tokensFor(ROWS, "a");
    const second = tokensFor(ROWS, "b");
    const owner = {};
    const { result, rerender } = renderStage({
      hunks,
      tokens: first,
      owner,
      flush: 0,
      enabled: true,
    });
    drainUntil(() => result.current.allRowsMounted && result.current.tokens === first);

    rerender({ hunks, tokens: second, owner, flush: 0, enabled: true });
    expect(result.current.tokens).toBe(first);
    runFrame();
    const shown = result.current.tokens!;
    expect(shown.new[0]).toBe(second.new[0]);
    expect(shown.new[DIFF_ROW_BATCH - 1]).toBe(second.new[DIFF_ROW_BATCH - 1]);
    expect(shown.new[DIFF_ROW_BATCH]).toBe(first.new[DIFF_ROW_BATCH]);
    expect(shown.new[ROWS - 1]).toBe(first.new[ROWS - 1]);

    drainUntil(() => result.current.tokens === second);
    expect(frames.size).toBe(0);
  });

  it("clears stale tokens at once rather than leaving them on rows they weren't built for", () => {
    const hunks = [addedHunk(ROWS)];
    const tokens = tokensFor(ROWS, "t");
    const owner = {};
    const { result, rerender } = renderStage({ hunks, tokens, owner, flush: 0, enabled: true });
    drainUntil(() => result.current.allRowsMounted && result.current.tokens === tokens);
    rerender({ hunks, tokens: null, owner, flush: 0, enabled: true });
    expect(appliedFrom(result.current.tokens, tokens)).toBe(0);
  });

  it("never brings an invalidated pass back as the base for the next one", () => {
    // A grammar change over the same hunks: the old pass is dropped (null),
    // then the new one lands. Rows the new pass hasn't reached stay plain.
    const hunks = [addedHunk(ROWS)];
    const oldGrammar = tokensFor(ROWS, "old");
    const newGrammar = tokensFor(ROWS, "new");
    const owner = {};
    const { result, rerender } = renderStage({
      hunks,
      tokens: oldGrammar,
      owner,
      flush: 0,
      enabled: true,
    });
    drainUntil(() => result.current.allRowsMounted && result.current.tokens === oldGrammar);
    rerender({ hunks, tokens: null, owner, flush: 0, enabled: true });
    rerender({ hunks, tokens: newGrammar, owner, flush: 0, enabled: true });
    expect(appliedFrom(result.current.tokens, oldGrammar)).toBe(0);
    runFrame();
    expect(appliedFrom(result.current.tokens, newGrammar)).toBe(DIFF_ROW_BATCH);
    expect(appliedFrom(result.current.tokens, oldGrammar)).toBe(0);
  });

  it("drops tokens built for other hunks", () => {
    const hunks = [addedHunk(ROWS)];
    const tokens = tokensFor(ROWS, "t");
    const owner = {};
    const { result, rerender } = renderStage({ hunks, tokens, owner, flush: 0, enabled: true });
    drainUntil(() => result.current.allRowsMounted && result.current.tokens === tokens);
    const regrown = [addedHunk(ROWS + 5)];
    const newTokens = tokensFor(ROWS + 5, "n");
    rerender({ hunks: regrown, tokens: newTokens, owner, flush: 0, enabled: true });
    expect(appliedFrom(result.current.tokens, tokens)).toBe(0);
    expect(appliedFrom(result.current.tokens, newTokens)).toBe(0);
  });

  it("never hands a new owner the previous owner's budget, not even for one render", () => {
    const seen: number[] = [];
    const hunks = [addedHunk(ROWS)];
    const { result, rerender } = renderStage(
      { hunks, tokens: null, owner: {}, flush: 0, enabled: true },
      (staged) => seen.push(mountedRows(staged.mountedHunks))
    );
    drainUntil(() => result.current.allRowsMounted);
    seen.length = 0;
    rerender({ hunks: [addedHunk(ROWS)], tokens: null, owner: {}, flush: 0, enabled: true });
    // Every render of the new owner, the one before its effect syncs included.
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBe(DIFF_ROW_BATCH);
  });

  it("mounts later growth of a finished view at once", () => {
    const hunks = [addedHunk(ROWS)];
    const owner = {};
    const { result, rerender } = renderStage({
      hunks,
      tokens: null,
      owner,
      flush: 0,
      enabled: true,
    });
    drainUntil(() => result.current.allRowsMounted);
    const grown = [addedHunk(ROWS + 20)];
    rerender({ hunks: grown, tokens: null, owner, flush: 0, enabled: true });
    expect(result.current.mountedHunks).toBe(grown);
  });

  it("stages hunks admitted behind a finished view as a fresh batch", () => {
    const first = addedHunk(ROWS);
    const owner = {};
    const { result, rerender } = renderStage({
      hunks: [first],
      tokens: null,
      owner,
      flush: 0,
      enabled: true,
    });
    drainUntil(() => result.current.allRowsMounted);
    act(() => result.current.extend());
    const more = addedHunk(ROWS, ROWS + 100);
    rerender({ hunks: [first, more], tokens: null, owner, flush: 0, enabled: true });
    expect(mountedRows(result.current.mountedHunks)).toBe(ROWS + DIFF_ROW_BATCH);
    expect(result.current.mountedHunks[0]).toBe(first);
    drainUntil(() => result.current.allRowsMounted);
    expect(mountedRows(result.current.mountedHunks)).toBe(ROWS * 2);
  });

  it("finishes the stage synchronously when flushed", () => {
    const hunks = [addedHunk(ROWS)];
    const tokens = tokensFor(ROWS, "t");
    const owner = {};
    const { result, rerender } = renderStage({
      hunks,
      tokens: null,
      owner,
      flush: 0,
      enabled: true,
    });
    expect(result.current.allRowsMounted).toBe(false);
    rerender({ hunks, tokens: null, owner, flush: 1, enabled: true });
    expect(result.current.mountedHunks).toBe(hunks);

    // A pass arriving after the flush still lands in slices on the whole table.
    rerender({ hunks, tokens, owner, flush: 1, enabled: true });
    expect(appliedFrom(result.current.tokens, tokens)).toBe(0);
    runFrame();
    expect(result.current.mountedHunks).toBe(hunks);
    expect(appliedFrom(result.current.tokens, tokens)).toBe(DIFF_ROW_BATCH);
    expect(result.current.tokens!.new[ROWS - 1]).toBeUndefined();
  });

  it("cancels its pending frame on unmount", () => {
    const { unmount } = renderStage({
      hunks: [addedHunk(ROWS)],
      tokens: null,
      owner: {},
      flush: 0,
      enabled: true,
    });
    expect(frames.size).toBe(1);
    unmount();
    expect(frames.size).toBe(0);
  });
});
