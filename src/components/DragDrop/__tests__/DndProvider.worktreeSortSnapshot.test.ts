import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const DND_PROVIDER_PATH = path.resolve(__dirname, "../DndProvider.tsx");

// Static-source guard for issue #8393 — when the worktree sidebar is
// virtualized, the source row's useSortable hook unmounts as soon as it
// scrolls outside Virtuoso's overscan window. dnd-kit's `active.data.current`
// then becomes undefined before handleDragEnd fires, dropping the reorder
// entirely. The DndProvider must snapshot `active.data.current` at
// onDragStart and read from the snapshot in onDragEnd / onDragCancel.
describe("DndProvider worktree-sort drag snapshot — issue #8393", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(DND_PROVIDER_PATH, "utf-8");
  });

  it("declares a ref for the active worktree-sort data snapshot", () => {
    expect(source).toMatch(
      /const\s+activeWorktreeSortDataRef\s*=\s*useRef<Record<string,\s*unknown>\s*\|\s*null>\(null\)/
    );
  });

  it("snapshots active.data.current at the top of the worktree-sort branch in handleDragStart", () => {
    expect(source).toMatch(
      /activeWorktreeSortDataRef\.current\s*=\s*active\.data\.current\s+as\s+Record<string,\s*unknown>/
    );
  });

  it("prefers the ref snapshot over active.data.current in handleDragEnd", () => {
    // The ref is the canonical source — without this, an unmounted source
    // row leaves active.data.current undefined and the reorder is dropped.
    expect(source).toMatch(/activeWorktreeSortDataRef\.current\s*\?\?/);
  });

  it("clears the snapshot ref once the worktree-sort drop is processed", () => {
    expect(source).toMatch(/activeWorktreeSortDataRef\.current\s*=\s*null/);
  });

  it("clears the snapshot ref on handleDragCancel for worktree-sort drags", () => {
    // Two clears: one in handleDragEnd after the reorder, one in handleDragCancel.
    const matches = source.match(/activeWorktreeSortDataRef\.current\s*=\s*null/g);
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("consults the snapshot ref inside cancelDrop so an unmounted source row doesn't convert the drop to a cancel", () => {
    // dnd-kit fires cancelDrop before handleDragEnd. If active.data.current
    // is undefined (source row unmounted outside Virtuoso's overscan), the
    // worktree-sort branch must still short-circuit cancelDrop to let the
    // drop fall through to handleDragEnd, where the ref-based snapshot does
    // the actual reorder.
    const cancelDropBlock = source.match(/const cancelDrop = useCallback\(([\s\S]*?)\}, \[/);
    expect(cancelDropBlock).toBeTruthy();
    expect(cancelDropBlock?.[1]).toMatch(/activeWorktreeSortDataRef\.current\s*!==\s*null/);
  });
});
