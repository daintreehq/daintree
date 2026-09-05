import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { VirtuosoMockContext } from "react-virtuoso";
import { performance } from "node:perf_hooks";
import type { DiffChangeSetEntry, StagingFileEntry } from "@shared/types/git";
import { FileSection } from "@/components/Worktree/ReviewHub/FileSection";
import { DiffFileSidebar } from "@/components/FileViewer/DiffFileSidebar";
import { DEFAULT_SECTION_STATE } from "@/components/Worktree/ReviewHub/reviewHubUtils";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * What the Review Hub's and the diff shelf's file lists cost to MOUNT.
 *
 * This is the renderer-side half of PERF-244/245, which measure the same
 * surfaces with the renderer deliberately absent. It lives under
 * `scripts/perf/renderer/` rather than in `scenarios/` because it cannot run in
 * the harness's own process: the perf runner is `node --import tsx`, and these
 * components' real module graph reaches `import.meta.glob` (the agent-icon
 * registry), `import.meta.env` and a Tailwind stylesheet — all of which resolve
 * only under Vite. Vitest is the one environment in this repo that supplies
 * that pipeline, so PERF-247 drives this file through vitest and reads the
 * numbers back.
 *
 * What that buys and what it does not:
 *
 *   - REAL components, real `react-virtuoso`, real React 19 reconciliation.
 *     `mountedRows` counts DOM nodes that actually exist, not a range Virtuoso
 *     reported about itself — overscan makes those two different numbers.
 *   - NO compositor, no paint, no Chromium layout. jsdom measures nothing, so
 *     the viewport is supplied by `VirtuosoMockContext` at a documented size.
 *     These are JS-thread mount and reconcile costs, not frames.
 *
 * The second point is why `windowingMisses` exists. A list that silently
 * stopped windowing gets FASTER by this instrument's blindest measure — fewer
 * commits, no measurement pass — while mounting every row, so the predicate
 * fails on `mountedRows >= fileCount` rather than trusting the duration.
 */

/** Item height fed to Virtuoso in place of jsdom's zero. Comfortable density. */
export const BENCH_ITEM_HEIGHT_PX = 32;
/** Viewport height fed to Virtuoso. ~20 comfortable rows, a plausible pane. */
export const BENCH_VIEWPORT_HEIGHT_PX = 640;

export interface ReviewListSample {
  /** Row elements in the document after mount. The whole point of the exercise. */
  mountedRows: number;
  /** First mount of the list, from `createRoot().render` to a committed tree. */
  initialRenderMs: number;
  /** One re-render after the selected/current file changes. */
  selectionChangeMs: number;
  /** Files the fixture handed the component. Proves the workload was delivered. */
  fileCount: number;
  /** Nonzero when the list mounted everything, or nothing, or all but a handful. */
  windowingMisses: number;
  /** Nonzero when the selection did not land on a mounted row. */
  selectionMisses: number;
}

const STATUSES = ["modified", "added", "deleted", "untracked", "renamed"] as const;

/**
 * The row the timed selection change lands on.
 *
 * Near the top so it is inside the first mounted window at every size, and the
 * SAME row at every size so the two fixtures time the same operation. Its
 * neighbour is checked too, which is what makes a list that mounted exactly one
 * row fail rather than pass.
 */
const SELECTION_TARGET_INDEX = 5;

/** Files per directory. ~17 groups at 423 files, ~80 at 2,000 — a real repo's shape. */
const FILES_PER_DIR = 25;

/**
 * A synthetic changeset with realistic path shape.
 *
 * Deterministic by index: the same call produces the same list, so two runs
 * measure the same work.
 *
 * Directories are sequential and ZERO-PADDED, which is load-bearing rather than
 * tidy. The diff shelf sorts its groups by `localeCompare` and keeps each
 * group's files in their incoming order, so padded sequential directories make
 * the shelf's DISPLAY order identical to the changeset's own order. Without
 * that, `area10` sorts before `area2` and the file at changeset index 5 lands
 * somewhere unpredictable on screen — which would make the selection this
 * benchmark times a different operation at every size.
 */
export function buildStagingFixture(count: number, offset = 0): StagingFileEntry[] {
  const files: StagingFileEntry[] = [];
  for (let i = 0; i < count; i++) {
    const n = i + offset;
    const dir = String(Math.floor(n / FILES_PER_DIR)).padStart(4, "0");
    files.push({
      path: `src/area-${dir}/file-${String(n).padStart(5, "0")}.ts`,
      status: STATUSES[n % STATUSES.length] ?? "modified",
      insertions: (n * 7) % 130,
      deletions: (n * 3) % 90,
    });
  }
  return files;
}

export function buildChangeSetFixture(count: number): DiffChangeSetEntry[] {
  return buildStagingFixture(count).map((file) => ({
    path: file.path,
    status: file.status,
    insertions: file.insertions,
    deletions: file.deletions,
    viewedKey: `unstaged:${file.path}`,
  }));
}

interface Harness {
  container: HTMLDivElement;
  root: Root;
  dispose: () => void;
}

function mountHarness(): Harness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  return {
    container,
    root,
    dispose: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/**
 * Every miss this instrument can detect, in one place.
 *
 * `mountedRows === 0` and `mountedRows >= fileCount` are the two ways a reading
 * flatters: nothing rendered at all, and nothing windowed at all. The third —
 * mounting `fileCount - 1` rows — passes the second check and is not windowing
 * either, so the bound is stated in rows the viewport could plausibly hold
 * rather than as "fewer than all of them".
 */
function scoreWindowing(mountedRows: number, fileCount: number): number {
  const plausibleCeiling = Math.ceil((BENCH_VIEWPORT_HEIGHT_PX / BENCH_ITEM_HEIGHT_PX) * 6 + 40);
  let misses = 0;
  if (mountedRows === 0) misses++;
  if (mountedRows >= fileCount) misses++;
  if (mountedRows > plausibleCeiling) misses++;
  return misses;
}

function countRows(container: HTMLElement, selector: string): number {
  return container.querySelectorAll(selector).length;
}

const noop = () => {};

/**
 * The Review Hub's unstaged section at `fileCount` files.
 *
 * `FileSection` rather than `ReviewHubContent`: the hub's own chrome is a fixed
 * cost that does not scale with the changeset, and mounting it would drag the
 * whole staging/IPC surface in for no measured benefit. The section carries the
 * rows, the density, the header and the empty states — everything that scales.
 */
export async function measureWorkingTreeList(
  fileCount: number,
  windowed = true
): Promise<ReviewListSample> {
  const files = buildStagingFixture(fileCount);
  const harness = mountHarness();
  const scrollParent = document.createElement("div");
  document.body.appendChild(scrollParent);

  // Both surfaces put a tooltip on every row, and both are mounted by the app
  // under the provider the real tree supplies. It is part of the row's cost,
  // so it is part of the measurement.
  const render = (focusedIndex: number) => (
    <TooltipProvider>
      <VirtuosoMockContext.Provider
        value={{ itemHeight: BENCH_ITEM_HEIGHT_PX, viewportHeight: BENCH_VIEWPORT_HEIGHT_PX }}
      >
        <FileSection
          isStaged={false}
          files={files}
          allFiles={files}
          indexOffset={0}
          focusedIndex={focusedIndex}
          selectionSection={null}
          selectedPaths={new Set()}
          hasSelection={false}
          view={DEFAULT_SECTION_STATE}
          setView={noop}
          inputRef={{ current: null }}
          setFilterQuery={noop}
          clearFilter={noop}
          onToggle={noop}
          onRowClick={noop}
          onBulkAction={noop}
          viewedFiles={new Set()}
          onViewedChange={noop}
          renderRowMenu={() => null}
          virtualized={windowed}
          scrollParent={scrollParent}
        />
      </VirtuosoMockContext.Provider>
    </TooltipProvider>
  );

  const mountStart = performance.now();
  await act(async () => {
    harness.root.render(render(-1));
  });
  const initialRenderMs = performance.now() - mountStart;

  const mountedRows = countRows(harness.container, '[role="option"]');

  // A row inside the mounted window. What is priced here is the RE-RENDER a
  // selection change costs — the number that is supposed to stop scaling with
  // N. Reveal of an off-screen cursor is a behavioural contract, not a cost,
  // and jsdom cannot honestly measure it: Virtuoso's scroll path needs a
  // scroller with a real height, and jsdom gives every element zero. The
  // component tests cover reveal against a mocked virtualizer instead.
  const selectionIndex = Math.min(SELECTION_TARGET_INDEX, fileCount - 1);
  const selectionStart = performance.now();
  await act(async () => {
    harness.root.render(render(selectionIndex));
  });
  const selectionChangeMs = performance.now() - selectionStart;

  const selected = harness.container.querySelector(`[data-row-index="${selectionIndex}"]`);
  const neighbour = harness.container.querySelector(
    `[data-row-index="${Math.max(0, selectionIndex - 1)}"]`
  );
  const selectionMisses = (selected ? 0 : 1) + (neighbour ? 0 : 1);

  harness.dispose();
  scrollParent.remove();

  return {
    mountedRows,
    initialRenderMs,
    selectionChangeMs,
    fileCount: files.length,
    windowingMisses: scoreWindowing(mountedRows, files.length),
    selectionMisses,
  };
}

/** The diff workspace's file shelf at `fileCount` files, grouped by directory. */
export async function measureDiffShelf(fileCount: number): Promise<ReviewListSample> {
  const files = buildChangeSetFixture(fileCount);
  const harness = mountHarness();

  const render = (currentIndex: number) => (
    <TooltipProvider>
      <VirtuosoMockContext.Provider
        value={{ itemHeight: BENCH_ITEM_HEIGHT_PX, viewportHeight: BENCH_VIEWPORT_HEIGHT_PX }}
      >
        <DiffFileSidebar
          files={files}
          currentIndex={currentIndex}
          worktreePath=""
          worktreeId={null}
          onSelect={noop}
        />
      </VirtuosoMockContext.Provider>
    </TooltipProvider>
  );

  const mountStart = performance.now();
  await act(async () => {
    harness.root.render(render(-1));
  });
  const initialRenderMs = performance.now() - mountStart;

  const mountedRows = countRows(harness.container, '[data-testid="diff-sidebar-file"]');

  const selectionIndex = Math.min(SELECTION_TARGET_INDEX, fileCount - 1);
  const selectionStart = performance.now();
  await act(async () => {
    harness.root.render(render(selectionIndex));
  });
  const selectionChangeMs = performance.now() - selectionStart;

  const selected = harness.container.querySelector(`[data-file-index="${selectionIndex}"]`);
  const neighbour = harness.container.querySelector(
    `[data-file-index="${Math.max(0, selectionIndex - 1)}"]`
  );
  const selectionMisses = (selected ? 0 : 1) + (neighbour ? 0 : 1);

  harness.dispose();

  return {
    mountedRows,
    initialRenderMs,
    selectionChangeMs,
    fileCount: files.length,
    windowingMisses: scoreWindowing(mountedRows, files.length),
    selectionMisses,
  };
}

/** Flattens a sample into the harness's flat `metrics` record under one prefix. */
export function toMetrics(prefix: string, sample: ReviewListSample): Record<string, number> {
  return {
    [`${prefix}MountedRows`]: sample.mountedRows,
    [`${prefix}InitialRenderMs`]: sample.initialRenderMs,
    [`${prefix}SelectionChangeMs`]: sample.selectionChangeMs,
    [`${prefix}FileCount`]: sample.fileCount,
    [`${prefix}WindowingMisses`]: sample.windowingMisses,
    [`${prefix}SelectionMisses`]: sample.selectionMisses,
  };
}
