// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeData, HunkData, HunkTokens, TokenNode } from "react-diff-view";
import { countHunkRows, DIFF_ROW_BATCH } from "../diffRowStaging";
import { useStagedDiffRows } from "../useStagedDiffRows";

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

beforeEach(() => {
  frames = new Map();
  nextFrame = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function runFrame() {
  const queued = [...frames.values()];
  frames.clear();
  act(() => {
    for (const cb of queued) cb(0);
  });
}

function addedHunk(lines: number): HunkData {
  const changes: ChangeData[] = [];
  for (let i = 1; i <= lines; i++) {
    changes.push({ type: "insert", content: `line ${i}`, lineNumber: i, isInsert: true } as ChangeData);
  }
  return {
    content: `@@ -0,0 +1,${lines} @@`,
    oldStart: 0,
    newStart: 1,
    oldLines: 0,
    newLines: lines,
    changes,
  };
}

function tokensFor(lines: number, label: string): HunkTokens {
  const line = (i: number): TokenNode[] => [{ type: "text", value: `${label}${i}` }];
  return { old: [], new: Array.from({ length: lines }, (_, i) => line(i + 1)) };
}

const mountedRows = (hunks: HunkData[]) => countHunkRows(hunks);

interface Props {
  hunks: HunkData[];
  tokens: HunkTokens | null;
  owner: unknown;
  flush: number;
  enabled: boolean;
}

function renderStage(initial: Props) {
  return renderHook((props: Props) =>
    useStagedDiffRows(props.hunks, props.tokens, props.owner, props.flush, props.enabled),
    { initialProps: initial }
  );
}

const ROWS = DIFF_ROW_BATCH * 3 + 7;

describe("useStagedDiffRows", () => {
  it("leaves a set within one batch alone: whole on the first render, tokens straight through", () => {
    const hunks = [addedHunk(DIFF_ROW_BATCH)];
    const tokens = tokensFor(DIFF_ROW_BATCH, "t");
    const owner = {};
    const { result } = renderStage({ hunks, tokens: null, owner, flush: 0, enabled: true });
    expect(result.current.mountedHunks).toBe(hunks);
    expect(result.current.allRowsMounted).toBe(true);
    expect(frames.size).toBe(0);
  });

  it("passes tokens straight to a small set the moment they arrive", () => {
    const hunks = [addedHunk(10)];
    const tokens = tokensFor(10, "t");
    const owner = {};
    const { result, rerender } = renderStage({ hunks, tokens: null, owner, flush: 0, enabled: true });
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
    let slices = 0;
    while (!result.current.allRowsMounted) {
      runFrame();
      const now = mountedRows(result.current.mountedHunks);
      expect(now - previous).toBeLessThanOrEqual(DIFF_ROW_BATCH);
      expect(now).toBeGreaterThan(previous);
      previous = now;
      slices++;
      expect(slices).toBeLessThan(10);
    }
    expect(result.current.mountedHunks).toBe(hunks);
    // Nothing left scheduled once the stage is done.
    expect(frames.size).toBe(0);
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
    const { result, rerender } = renderStage({ hunks, tokens: null, owner, flush: 0, enabled: true });
    runFrame(); // two batches mounted, plain
    expect(mountedRows(result.current.mountedHunks)).toBe(DIFF_ROW_BATCH * 2);

    rerender({ hunks, tokens, owner, flush: 0, enabled: true });
    // Nothing applied before the first slice: the table keeps plain rows.
    expect(result.current.tokens).toBeNull();

    const applied = () =>
      result.current.tokens === null
        ? 0
        : result.current.tokens.new.filter((line, i) => line === tokens.new[i]).length;

    runFrame();
    // Mounted rows get tokens first; no new rows join in the same slice.
    expect(applied()).toBe(DIFF_ROW_BATCH);
    expect(mountedRows(result.current.mountedHunks)).toBe(DIFF_ROW_BATCH * 2);
    // Rows past the cursor read null, as they did with no tokens at all.
    expect(result.current.tokens!.new[DIFF_ROW_BATCH]).toBeNull();

    runFrame();
    expect(applied()).toBe(DIFF_ROW_BATCH * 2);
    expect(mountedRows(result.current.mountedHunks)).toBe(DIFF_ROW_BATCH * 2);

    runFrame();
    // Every mounted row is highlighted, so this slice mounts the next batch with its tokens.
    expect(mountedRows(result.current.mountedHunks)).toBe(DIFF_ROW_BATCH * 3);
    expect(applied()).toBe(DIFF_ROW_BATCH * 3);

    while (!result.current.allRowsMounted || result.current.tokens !== tokens) runFrame();
    expect(result.current.tokens).toBe(tokens);
    expect(frames.size).toBe(0);
  });

  it("keeps the previous pass on rows the new one hasn't reached yet", () => {
    const hunks = [addedHunk(ROWS)];
    const first = tokensFor(ROWS, "a");
    const second = tokensFor(ROWS, "b");
    const owner = {};
    const { result, rerender } = renderStage({ hunks, tokens: first, owner, flush: 0, enabled: true });
    while (!result.current.allRowsMounted || result.current.tokens !== first) runFrame();

    rerender({ hunks, tokens: second, owner, flush: 0, enabled: true });
    expect(result.current.tokens).toBe(first);
    runFrame();
    const shown = result.current.tokens!;
    expect(shown.new[0]).toBe(second.new[0]);
    expect(shown.new[DIFF_ROW_BATCH - 1]).toBe(second.new[DIFF_ROW_BATCH - 1]);
    expect(shown.new[DIFF_ROW_BATCH]).toBe(first.new[DIFF_ROW_BATCH]);
    expect(shown.new[ROWS - 1]).toBe(first.new[ROWS - 1]);

    while (result.current.tokens !== second) runFrame();
    expect(frames.size).toBe(0);
  });

  it("clears stale tokens at once rather than leaving them on rows they weren't built for", () => {
    const hunks = [addedHunk(ROWS)];
    const tokens = tokensFor(ROWS, "t");
    const owner = {};
    const { result, rerender } = renderStage({ hunks, tokens, owner, flush: 0, enabled: true });
    while (!result.current.allRowsMounted || result.current.tokens !== tokens) runFrame();
    rerender({ hunks, tokens: null, owner, flush: 0, enabled: true });
    expect(result.current.tokens).toBeNull();
  });

  it("drops tokens built for other hunks", () => {
    const hunks = [addedHunk(ROWS)];
    const tokens = tokensFor(ROWS, "t");
    const owner = {};
    const { result, rerender } = renderStage({ hunks, tokens, owner, flush: 0, enabled: true });
    while (!result.current.allRowsMounted || result.current.tokens !== tokens) runFrame();
    const regrown = [addedHunk(ROWS + 5)];
    const newTokens = tokensFor(ROWS + 5, "n");
    rerender({ hunks: regrown, tokens: newTokens, owner, flush: 0, enabled: true });
    expect(result.current.tokens).toBeNull();
  });

  it("starts over within the same render when the owner changes", () => {
    const hunks = [addedHunk(ROWS)];
    const { result, rerender } = renderStage({
      hunks,
      tokens: null,
      owner: {},
      flush: 0,
      enabled: true,
    });
    while (!result.current.allRowsMounted) runFrame();
    // A new view is never handed the previous view's finished budget, even
    // for the one render before an effect could catch up.
    const next = [addedHunk(ROWS)];
    rerender({ hunks: next, tokens: null, owner: {}, flush: 0, enabled: true });
    expect(mountedRows(result.current.mountedHunks)).toBe(DIFF_ROW_BATCH);
  });

  it("mounts later growth of a finished view at once", () => {
    const hunks = [addedHunk(ROWS)];
    const owner = {};
    const { result, rerender } = renderStage({ hunks, tokens: null, owner, flush: 0, enabled: true });
    while (!result.current.allRowsMounted) runFrame();
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
    while (!result.current.allRowsMounted) runFrame();
    act(() => result.current.extend());
    const more: HunkData = { ...addedHunk(ROWS), oldStart: 9000, newStart: 9000 };
    rerender({ hunks: [first, more], tokens: null, owner, flush: 0, enabled: true });
    expect(mountedRows(result.current.mountedHunks)).toBe(ROWS + DIFF_ROW_BATCH);
    while (!result.current.allRowsMounted) runFrame();
    expect(mountedRows(result.current.mountedHunks)).toBe(ROWS * 2);
  });

  it("finishes the stage synchronously when flushed", () => {
    const hunks = [addedHunk(ROWS)];
    const tokens = tokensFor(ROWS, "t");
    const owner = {};
    const { result, rerender } = renderStage({ hunks, tokens: null, owner, flush: 0, enabled: true });
    expect(result.current.allRowsMounted).toBe(false);
    rerender({ hunks, tokens: null, owner, flush: 1, enabled: true });
    expect(result.current.mountedHunks).toBe(hunks);

    // A pass arriving after the flush still lands in slices on the whole table.
    rerender({ hunks, tokens, owner, flush: 1, enabled: true });
    expect(result.current.tokens).toBeNull();
    runFrame();
    expect(result.current.mountedHunks).toBe(hunks);
    expect(result.current.tokens!.new[0]).toBe(tokens.new[0]);
    expect(result.current.tokens!.new[ROWS - 1]).toBeNull();
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
