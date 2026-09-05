import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { FileTreeNode } from "../../../shared/types/ipc";
import type { PerfScenario } from "../types";
import { percentile } from "../lib/stats";
import {
  expectedHiddenCounts,
  expectedReviewOrder,
  expectedVisiblePaths,
  expectedVisibleRowOrder,
  getFileBrowserFixture,
  getReviewFixture,
  getViewerFixture,
  listDirectories,
  listedSizeOf,
  loadAffectedDirsModule,
  loadAlwaysHiddenPatterns,
  loadBrowserTreeModule,
  loadReviewModules,
  loadViewerModules,
  mapStagingEntries,
  mutateTree,
  pickExpansion,
  rowPathSet,
  sequenceMismatchCount,
  setDifferenceCount,
  stagingStatusFor,
  writeBurst,
} from "../lib/panelsFixture";

// Panel surfaces (PERF-240..246) — the file browser, the Review Hub and the
// file viewer, the three built-in panel kinds the matrix had no coverage of at
// all. Terminal and dev-preview are measured elsewhere and diff tokenization is
// PERF-160..162; these are the remaining kinds in `shared/types/panel.ts`.
//
// Every scenario here reports counts and structural cardinalities alongside its
// durations, because all three subjects get FASTER by failing. A tree that
// builds no nodes builds instantly; a visibility filter that drops ignored
// files along with the junk walks fewer rows and is wrong in the direction the
// file browser has already shipped a bug in; a Review Hub whose numstat read
// returns an empty map paints a churn-less file list in no time; a viewer whose
// language never resolves skips the parse entirely. So each declares a miss
// count checked against what the FIXTURE wrote — not against what the product
// returned — and emits it on every iteration, 0 when healthy.
//
// `lib/panelsFixture.ts` states the scope limits in full. The two that bound
// every number here: there is no renderer, so nothing below is a frame; and
// `ipcMain` does not exist, so the file browser's listings come straight from
// `FileTreeService` rather than through its IPC handler, and the Review Hub's
// `handleGetStagingStatus` — a closure behind `ipcMain.handle` with a
// 20-per-10s rate limit — cannot be driven at all.

/** A realistic restored panel: dozens of directories remembered across sessions. */
const REPRESENTATIVE_EXPANSION = 60;
/** A monorepo panel someone has been living in. */
const LARGE_EXPANSION = 250;

interface TreeBuild {
  buildMs: number;
  listMs: number;
  flattenMs: number;
  hiddenMs: number;
  resortFlattenMs: number;
  nodeCount: number;
  directoryCount: number;
  rowCount: number;
  hiddenDotfileCount: number;
  hiddenJunkCount: number;
  rowMisses: number;
  hiddenMisses: number;
  orderMisses: number;
}

/** The one non-default order a panel can be put into without re-listing. */
const NAME_DESC_SORT = { key: "name", direction: "desc" } as const;

/**
 * Fetch every listing a panel with this expansion would hold, then run the real
 * row build over it.
 *
 * The three miss counts are the whole point of the return shape. `rowMisses` is
 * the symmetric difference against the manifest, so both a tree that produced
 * too few rows and one that leaked hidden entries into the list score;
 * `hiddenMisses` holds the two tallies to the numbers the generator wrote,
 * which is what stops a filter that silently over-hides from reading as a
 * cheaper tree build; and `orderMisses` compares the row SEQUENCE, in the
 * default order and again under a re-sort, because a set comparison scores an
 * identity `sortFileNodes` as healthy — the rows are the same rows, and only
 * their order is wrong.
 *
 * The re-sort pass runs outside `buildMs`: it is a second question asked of the
 * same listings, not part of the work a panel open pays.
 */
async function buildTreeRows(
  tree: ReturnType<typeof getFileBrowserFixture>["representative"],
  expanded: Set<string>,
  hideDotfiles: boolean,
  alwaysHiddenPatterns: readonly string[]
): Promise<TreeBuild> {
  const browserTree = await loadBrowserTreeModule();
  const directories = ["", ...[...expanded].sort()];

  const buildStart = performance.now();

  const listStart = performance.now();
  const { listings, nodes } = await listDirectories(tree.path, directories);
  const listMs = performance.now() - listStart;

  const isVisible = browserTree.createVisibilityFilter({ hideDotfiles, alwaysHiddenPatterns });

  const flattenStart = performance.now();
  const rows = browserTree.flattenTree(
    listings,
    expanded,
    new Set<string>(),
    "",
    isVisible,
    browserTree.DEFAULT_FILE_SORT
  );
  const flattenMs = performance.now() - flattenStart;

  const hiddenStart = performance.now();
  const hidden = browserTree.countHiddenRows(listings, expanded, "", {
    hideDotfiles,
    alwaysHiddenPatterns,
  });
  const hiddenMs = performance.now() - hiddenStart;

  const buildMs = performance.now() - buildStart;

  const resortStart = performance.now();
  const resortedRows = browserTree.flattenTree(
    listings,
    expanded,
    new Set<string>(),
    "",
    isVisible,
    NAME_DESC_SORT
  );
  const resortFlattenMs = performance.now() - resortStart;

  const expectedRows = expectedVisiblePaths(tree, expanded, hideDotfiles);
  const expectedHidden = expectedHiddenCounts(tree, expanded, hideDotfiles);

  return {
    buildMs,
    listMs,
    flattenMs,
    hiddenMs,
    resortFlattenMs,
    nodeCount: nodes,
    directoryCount: directories.length,
    rowCount: rows.length,
    hiddenDotfileCount: hidden.dotfiles,
    hiddenJunkCount: hidden.alwaysHidden,
    rowMisses: setDifferenceCount(expectedRows, rowPathSet(rows)),
    hiddenMisses:
      Math.abs(hidden.dotfiles - expectedHidden.dotfiles) +
      Math.abs(hidden.alwaysHidden - expectedHidden.alwaysHidden),
    orderMisses:
      sequenceMismatchCount(
        expectedVisibleRowOrder(tree, expanded, hideDotfiles, "asc"),
        rows.map((row) => row.path)
      ) +
      sequenceMismatchCount(
        expectedVisibleRowOrder(tree, expanded, hideDotfiles, "desc"),
        resortedRows.map((row) => row.path)
      ),
  };
}

/** Monotonic per-call token so a mutating iteration cannot collide with another. */
let mutationToken = 0;

/**
 * PERF-247 measures REACT, which this harness's own process cannot do.
 *
 * The runner is `node --import tsx`, and the Review Hub's and the diff shelf's
 * real module graph reaches `import.meta.glob` (the agent-icon registry),
 * `import.meta.env` and a Tailwind stylesheet before it reaches a row — all
 * Vite constructs that tsx does not implement. Stubbing them would leave the
 * benchmark mounting something that is not what ships, which is the exact
 * failure this file's classification exists to prevent.
 *
 * Vitest is the one environment in the repo that supplies that pipeline, so the
 * measurement lives in `scripts/perf/renderer/` and runs there. This spawns it
 * and reads the numbers back. Spawning a child to measure is not new here —
 * PERF-004 launches the packaged binary and several fixtures spawn git — but
 * the reason is worth stating: it is the build pipeline that is needed, not the
 * isolation.
 */
async function runRendererBenchmark(): Promise<Record<string, number>> {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-perf-247-"));
  const outPath = path.join(dir, "metrics.json");
  const spec = "scripts/perf/renderer/__tests__/reviewListsBench.measure.test.tsx";
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [path.resolve("node_modules/vitest/vitest.mjs"), "run", spec, "--reporter=dot"],
        {
          stdio: ["ignore", "ignore", "pipe"],
          env: { ...process.env, DAINTREE_PERF_OUT: outPath },
        }
      );
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (status) => {
        if (status === 0) resolve();
        else reject(new Error(`renderer benchmark exited ${status}: ${stderr.slice(-2000)}`));
      });
    });
    return JSON.parse(readFileSync(outPath, "utf-8")) as Record<string, number>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Reads a metric the child must have emitted; a missing one is a broken run, not a zero. */
function requireMetric(metrics: Record<string, number>, key: string): number {
  const value = metrics[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`renderer benchmark did not report ${key}`);
  }
  return value;
}

export const panelScenarios: PerfScenario[] = [
  {
    id: "PERF-240",
    name: "File Browser Tree Build - Representative Repo",
    description:
      "Opens a file-browser panel restored with 60 expanded directories over a ~4,500-entry tree: " +
      "the real FileTreeService lists the root and every expanded directory (readdir + per-entry " +
      "lstat + collator sort), then the panel's own flattenTree/createVisibilityFilter/" +
      "countHiddenRows build the rendered rows under the shipped always-hidden junk list. " +
      "durationMs is the whole build; listMs is the filesystem half and flattenMs the row half. " +
      "No renderer and no paint — this is the work a commit must finish before React can render. " +
      "treeRowMisses diffs the rows against what the fixture wrote, in BOTH directions, so a " +
      "filter that over-hides is not rewarded for walking fewer rows, and rowOrderMisses holds " +
      "the row sequence — default order and a name-descending re-sort, priced as " +
      "resortFlattenMs — to the manifest, which a set comparison cannot do and an identity sort " +
      "would otherwise pass.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 5, ci: 10, nightly: 14 },
    warmups: 1,
    correctness: ["treeRowMisses", "hiddenCountMisses", "rowOrderMisses"],
    async run() {
      const fixture = getFileBrowserFixture();
      const alwaysHiddenPatterns = await loadAlwaysHiddenPatterns();
      const expanded = pickExpansion(fixture.representative, REPRESENTATIVE_EXPANSION);

      // The product default: dotfiles shown, the junk list applied.
      const build = await buildTreeRows(
        fixture.representative,
        expanded,
        false,
        alwaysHiddenPatterns
      );

      return {
        durationMs: build.buildMs,
        metrics: {
          listMs: build.listMs,
          flattenMs: build.flattenMs,
          hiddenCountMs: build.hiddenMs,
          resortFlattenMs: build.resortFlattenMs,
          directoryCount: build.directoryCount,
          nodeCount: build.nodeCount,
          rowCount: build.rowCount,
          hiddenDotfileCount: build.hiddenDotfileCount,
          hiddenJunkCount: build.hiddenJunkCount,
          treeRowMisses: build.rowMisses,
          hiddenCountMisses: build.hiddenMisses,
          rowOrderMisses: build.orderMisses,
        },
        notes:
          build.rowMisses > 0
            ? `${build.rowMisses} rows differ from the manifest — the tree is not showing what is on disk`
            : undefined,
      };
    },
  },
  {
    id: "PERF-241",
    name: "File Browser Tree Build - Repo Scaling and Filter Cost",
    description:
      "The same build at two scales (60 expanded directories over ~4,500 entries against 250 over " +
      "~11,500 in wider directories), plus a third pass over the large tree with the dotfile toggle " +
      "ON so the cost of the hiding is separable from the cost of the walk. msPerKNode normalises " +
      "the large tree's build by entries listed — the fixed-scale signal for a regression in the " +
      "per-entry lstat path or in sortFileNodes — which every pass exercises for real, because " +
      "each re-sorts its listings name-descending and holds the resulting sequence to the " +
      "manifest. All three passes carry their own miss counts.",
    tier: "heavy",
    modes: ["ci", "nightly"],
    iterations: { ci: 6, nightly: 10 },
    warmups: 1,
    correctness: ["treeRowMisses", "hiddenCountMisses", "rowOrderMisses"],
    async run() {
      const fixture = getFileBrowserFixture();
      const alwaysHiddenPatterns = await loadAlwaysHiddenPatterns();
      const smallExpansion = pickExpansion(fixture.representative, REPRESENTATIVE_EXPANSION);
      const largeExpansion = pickExpansion(fixture.large, LARGE_EXPANSION);

      const small = await buildTreeRows(
        fixture.representative,
        smallExpansion,
        false,
        alwaysHiddenPatterns
      );
      const large = await buildTreeRows(fixture.large, largeExpansion, false, alwaysHiddenPatterns);
      const largeHidingDotfiles = await buildTreeRows(
        fixture.large,
        largeExpansion,
        true,
        alwaysHiddenPatterns
      );

      return {
        durationMs: small.buildMs + large.buildMs + largeHidingDotfiles.buildMs,
        metrics: {
          smallListMs: small.listMs,
          smallFlattenMs: small.flattenMs,
          largeListMs: large.listMs,
          largeFlattenMs: large.flattenMs,
          largeHiddenCountMs: large.hiddenMs,
          largeResortFlattenMs: large.resortFlattenMs,
          dotfilesHiddenFlattenMs: largeHidingDotfiles.flattenMs,
          msPerKNode: large.buildMs / (large.nodeCount / 1000),
          largeNodeCount: large.nodeCount,
          largeRowCount: large.rowCount,
          largeHiddenJunkCount: large.hiddenJunkCount,
          dotfilesHiddenRowCount: largeHidingDotfiles.rowCount,
          dotfilesHiddenTallyCount: largeHidingDotfiles.hiddenDotfileCount,
          treeRowMisses: small.rowMisses + large.rowMisses + largeHidingDotfiles.rowMisses,
          hiddenCountMisses:
            small.hiddenMisses + large.hiddenMisses + largeHidingDotfiles.hiddenMisses,
          rowOrderMisses: small.orderMisses + large.orderMisses + largeHidingDotfiles.orderMisses,
        },
      };
    },
  },
  {
    id: "PERF-242",
    name: "File Browser Refresh Sweep After a Change",
    description:
      "The incremental path, as six write→sweep arms over a fully-expanded tree. Three price the " +
      "UNSCOPED sweep — a new visible file (sweepMs), a new file the junk list hides " +
      "(ignoredOnlySweepMs), an in-place edit (inPlaceEditSweepMs) — and report what one costs in " +
      "fullDirectoryRequests and fullListingsMapCopies. Three price the SCOPED sweep the watcher's " +
      "affected-directory signal makes possible (#12244): one write in one expanded subtree, one " +
      "at the root, and twenty writes across three subtrees in a single burst. Each write lands " +
      "between the preceding sweep and its own, so every arm prices a refresh over a change that " +
      "had not yet happened when the last one ran. Each sweep is the real refreshTargets → " +
      "re-list → flattenTree/countHiddenRows path, committing one listings-map copy per accepted " +
      "response exactly as the panel does. The scoped arms derive their directory set by feeding " +
      "ABSOLUTE paths through the production conversion helper, so an absolute-vs-relative " +
      "mismatch scores as a full sweep rather than passing silently. refreshMisses proves every " +
      "arm reconciled its own write — the visible file as a row, the junk file as a hidden tally " +
      "and never a row, the edit as the file's new byte length, and each burst file as a row in " +
      "the directory it landed in — which a sweep that skipped the re-read cannot produce.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 5, ci: 10, nightly: 14 },
    warmups: 1,
    correctness: ["refreshMisses"],
    async run() {
      const fixture = getFileBrowserFixture();
      const tree = fixture.mutable;
      const alwaysHiddenPatterns = await loadAlwaysHiddenPatterns();
      const browserTree = await loadBrowserTreeModule();
      const { affectedDirsForBurst } = await loadAffectedDirsModule();
      const expanded = new Set(tree.directories);
      const isVisible = browserTree.createVisibilityFilter({
        hideDotfiles: false,
        alwaysHiddenPatterns,
      });

      // Cold state a refresh starts from: every expanded listing already held,
      // taken before any write so the first sweep has something to discover.
      const initial = await listDirectories(tree.path, ["", ...tree.directories]);
      let listings = initial.listings;

      const token = `${(mutationToken += 1)}`;
      const targetDirs = tree.directories;
      const mutation = mutateTree(
        tree,
        {
          visibleDir: targetDirs[1] ?? "",
          junkDir: targetDirs[2] ?? "",
          touchDir: targetDirs[3] ?? "",
        },
        token
      );

      /**
       * One refresh over whatever is on disk now, timed end to end.
       *
       * `affectedDirs` is the watcher's answer for the burst that preceded this
       * sweep, or null for the unscoped sweep the panel took before #12244.
       *
       * Each returned listing is merged under its own fresh Map, never swapped
       * in wholesale. MERGING is what a scoped sweep requires — a wholesale
       * swap would discard every directory it deliberately did not re-read —
       * and ONE COPY PER RESPONSE is the fidelity choice on top of that: it is
       * what the panel's `setListings` does, where a single merged copy would
       * price a batching layer the panel does not have.
       *
       * That second half moves the three unscoped arms' durations: they now
       * carry per-response copies they previously did not. `sweepMs`,
       * `ignoredOnlySweepMs` and `inPlaceEditSweepMs` are therefore not
       * comparable across this change, and neither is `durationMs` (three arms
       * became six). Compare implementations under this harness, not against
       * readings taken before it.
       */
      const sweep = async (affectedDirs: ReadonlySet<string> | null = null) => {
        const startedAt = performance.now();
        const targets = browserTree.refreshTargets(
          listings,
          expanded,
          "",
          isVisible,
          null,
          affectedDirs
        );
        const swept = await listDirectories(tree.path, targets);
        let listingsMapCopies = 0;
        for (const [dirPath, nodes] of swept.listings) {
          const next = new Map(listings);
          next.set(dirPath, nodes);
          listings = next;
          listingsMapCopies += 1;
        }
        const rows = browserTree.flattenTree(
          listings,
          expanded,
          new Set<string>(),
          "",
          isVisible,
          browserTree.DEFAULT_FILE_SORT
        );
        const hidden = browserTree.countHiddenRows(listings, expanded, "", {
          hideDotfiles: false,
          alwaysHiddenPatterns,
        });
        return {
          ms: performance.now() - startedAt,
          directoryRequests: targets.length,
          listingsMapCopies,
          relistedNodes: swept.nodes,
          rowPaths: rowPathSet(rows),
          rowCount: rows.length,
          hiddenJunk: hidden.alwaysHidden,
          touchedSize: listedSizeOf(listings, mutation.touchedPath),
        };
      };

      /**
       * Pick `count` directories no two of which contain each other, so a
       * multi-directory burst really does land in separate subtrees.
       */
      const disjointDirs = (candidates: readonly string[], count: number): string[] => {
        const picked: string[] = [];
        for (const candidate of candidates) {
          if (picked.length === count) break;
          const nested = picked.some(
            (chosen) => candidate.startsWith(`${chosen}/`) || chosen.startsWith(`${candidate}/`)
          );
          if (!nested) picked.push(candidate);
        }
        return picked;
      };

      /**
       * The directory scope a burst of absolute paths resolves to, through the
       * production helper. A conversion that fails hands back null, which is
       * the full sweep — so an arm that expected to be scoped scores its
       * unscoped request count and the regression is visible in the number.
       */
      const scopeFor = (absolutePaths: readonly string[]): ReadonlySet<string> | null => {
        const dirs = affectedDirsForBurst(new Set(absolutePaths), tree.path, null);
        return dirs === null ? null : new Set(dirs);
      };

      const burstsToRevert: Array<{ revert: () => void }> = [];

      try {
        // Every arm's expectation, from the manifest: the added visible file is
        // a row from the first sweep on, the added junk file is a hidden tally
        // from the second, and the edited file's byte length is the sweep's own
        // evidence that it re-read the directory rather than replaying a cache.
        const expectedRows = expectedVisiblePaths(tree, expanded, false);
        expectedRows.add(mutation.visiblePath);
        const baseHiddenJunk = expectedHiddenCounts(tree, expanded, false).alwaysHidden;

        mutation.writeVisible();
        const visibleSweep = await sweep();

        mutation.writeJunk();
        const ignoredOnlySweep = await sweep();

        mutation.writeTouch();
        const editSweep = await sweep();

        // Scored before the scoped arms write anything. `expectedRows` is a
        // live set that each arm below adds to, and an arm can only be held to
        // the rows that existed when it ran.
        const unscopedMisses =
          setDifferenceCount(expectedRows, visibleSweep.rowPaths) +
          setDifferenceCount(expectedRows, ignoredOnlySweep.rowPaths) +
          setDifferenceCount(expectedRows, editSweep.rowPaths);

        // The scoped arms, each over the same fully-listed tree the unscoped
        // ones left behind. Every burst's expected rows accumulate, so a later
        // arm also re-proves that an earlier arm's directories were not thrown
        // away by a sweep that skipped them.
        const runScopedArm = async (dirs: readonly string[], count: number, suffix: string) => {
          const burst = writeBurst(tree, dirs, count, `${token}${suffix}`);
          // Registered before the write so a failure mid-arm still cleans up.
          burstsToRevert.push(burst);
          burst.write();
          for (const path of burst.paths) expectedRows.add(path);
          // Snapshotted here: this arm has to account for every row expected so
          // far, not just its own — a scoped sweep that dropped the listings it
          // deliberately did not re-read loses the earlier arms' rows, and that
          // is precisely the failure this arm exists to catch.
          const expectedNow = new Set(expectedRows);
          const swept = await sweep(scopeFor(burst.absolutePaths));
          return { ...swept, misses: setDifferenceCount(expectedNow, swept.rowPaths) };
        };

        const subtreeSweep = await runScopedArm([targetDirs[4] ?? ""], 1, "s");
        const rootSweep = await runScopedArm([""], 1, "r");
        // Three subtrees that are genuinely disjoint, not a parent and two of
        // its children: nesting still yields three targets, but it would not
        // demonstrate what the arm claims to.
        const multiSweep = await runScopedArm(disjointDirs(targetDirs, 3), 20, "m");

        const refreshMisses =
          unscopedMisses +
          Math.abs(visibleSweep.hiddenJunk - baseHiddenJunk) +
          Math.abs(ignoredOnlySweep.hiddenJunk - (baseHiddenJunk + 1)) +
          Math.abs(editSweep.hiddenJunk - (baseHiddenJunk + 1)) +
          (visibleSweep.touchedSize === mutation.touchedBytesBefore ? 0 : 1) +
          (ignoredOnlySweep.touchedSize === mutation.touchedBytesBefore ? 0 : 1) +
          (editSweep.touchedSize === mutation.touchedBytesAfter ? 0 : 1) +
          // Each scoped arm against the rows expected at its own point, and
          // against the hidden tally as well: a scoped response that dropped
          // only the hidden entries would leave every visible row, request
          // count and file size intact and score zero on rows alone.
          subtreeSweep.misses +
          rootSweep.misses +
          multiSweep.misses +
          Math.abs(subtreeSweep.hiddenJunk - (baseHiddenJunk + 1)) +
          Math.abs(rootSweep.hiddenJunk - (baseHiddenJunk + 1)) +
          Math.abs(multiSweep.hiddenJunk - (baseHiddenJunk + 1)) +
          // The edited file's size has to survive the scoped arms untouched:
          // they never re-read its directory, so a stale value here means a
          // scoped sweep discarded a listing it was right not to re-request.
          (multiSweep.touchedSize === mutation.touchedBytesAfter ? 0 : 1);

        return {
          durationMs:
            visibleSweep.ms +
            ignoredOnlySweep.ms +
            editSweep.ms +
            subtreeSweep.ms +
            rootSweep.ms +
            multiSweep.ms,
          metrics: {
            sweepMs: visibleSweep.ms,
            ignoredOnlySweepMs: ignoredOnlySweep.ms,
            inPlaceEditSweepMs: editSweep.ms,
            // The before-numbers the scoped arms are read against: one unscoped
            // sweep over this tree, whatever moved.
            fullDirectoryRequests: visibleSweep.directoryRequests,
            fullListingsMapCopies: visibleSweep.listingsMapCopies,
            scopedSubtreeSweepMs: subtreeSweep.ms,
            scopedSubtreeDirectoryRequests: subtreeSweep.directoryRequests,
            scopedSubtreeListingsMapCopies: subtreeSweep.listingsMapCopies,
            scopedRootSweepMs: rootSweep.ms,
            scopedRootDirectoryRequests: rootSweep.directoryRequests,
            scopedRootListingsMapCopies: rootSweep.listingsMapCopies,
            scopedMultiSweepMs: multiSweep.ms,
            scopedMultiDirectoryRequests: multiSweep.directoryRequests,
            scopedMultiListingsMapCopies: multiSweep.listingsMapCopies,
            // Still the UNSCOPED sweep's shape, so the pre-existing series keeps
            // measuring the same thing now that scoped arms follow it.
            refreshTargetCount: editSweep.directoryRequests,
            relistedNodeCount: editSweep.relistedNodes,
            rowCount: visibleSweep.rowCount,
            hiddenJunkCount: editSweep.hiddenJunk,
            refreshMisses,
          },
          notes:
            refreshMisses > 0
              ? "a refresh sweep did not reconcile the write that preceded it — rows, hidden tallies or the edited file's size disagree with disk"
              : undefined,
        };
      } finally {
        mutation.revert();
        for (const burst of burstsToRevert) burst.revert();
      }
    },
  },
  {
    id: "PERF-243",
    name: "File Browser Deep Subtree Expand and Collapse",
    description:
      "The gesture a user repeats: expand a six-level chain one level at a time (each level is a " +
      "listing fetch plus a full flattenTree over everything already open), then collapse the top " +
      "of it and run the real pruneListings, which forgets the subtree so re-expanding re-reads. " +
      "Three cycles, so the re-expansion after a prune is measured rather than served from a " +
      "cache the product does not keep. p99ExpandStepMs is the single click a user waits on. " +
      "expandCollapseMisses checks each cycle's fully-expanded rows against the manifest and its " +
      "collapsed rows against the baseline, so a chain that stopped descending scores every " +
      "cycle — and holds the surviving listing KEYS to the root plus whatever is still expanded, " +
      "because the collapsed rows alone are reproduced just as well by a prune that dropped " +
      "nothing at all.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 5, ci: 10, nightly: 14 },
    warmups: 1,
    correctness: ["expandCollapseMisses"],
    async run() {
      const fixture = getFileBrowserFixture();
      const tree = fixture.representative;
      const alwaysHiddenPatterns = await loadAlwaysHiddenPatterns();
      const browserTree = await loadBrowserTreeModule();
      const isVisible = browserTree.createVisibilityFilter({
        hideDotfiles: false,
        alwaysHiddenPatterns,
      });
      const spine = tree.spine;
      const spineSet = new Set(spine);

      const flatten = (
        listings: Map<string, readonly FileTreeNode[]>,
        expanded: ReadonlySet<string>
      ) =>
        browserTree.flattenTree(
          listings,
          expanded,
          new Set<string>(),
          "",
          isVisible,
          browserTree.DEFAULT_FILE_SORT
        );

      const CYCLES = 3;
      const stepDurations: number[] = [];
      let expandMs = 0;
      let collapseMs = 0;
      let pruneMs = 0;
      let listingCountAfterPrune = 0;
      let rowCountAtFullExpansion = 0;
      let misses = 0;

      const start = performance.now();

      const rootOnly = await listDirectories(tree.path, [""]);
      let listings = rootOnly.listings;
      const expanded = new Set<string>();
      const baselineRows = rowPathSet(flatten(listings, expanded));

      for (let cycle = 0; cycle < CYCLES; cycle += 1) {
        for (const level of spine) {
          const stepStart = performance.now();
          const fetched = await listDirectories(tree.path, [level]);
          const nodes = fetched.listings.get(level);
          if (nodes) listings.set(level, nodes);
          expanded.add(level);
          const rows = flatten(listings, expanded);
          const stepMs = performance.now() - stepStart;
          stepDurations.push(stepMs);
          expandMs += stepMs;
          rowCountAtFullExpansion = rows.length;
        }

        const fullRows = rowPathSet(flatten(listings, expanded));
        misses += setDifferenceCount(expectedVisiblePaths(tree, spineSet, false), fullRows);

        // Collapsing the top of a branch collapses everything inside it, so the
        // post-collapse expansion set is the whole spine removed. Taken from the
        // fixture's own chain rather than recomputed with the product's prefix
        // sweep, which lives in the panel component and cannot be imported here.
        const collapseStart = performance.now();
        for (const level of spine) expanded.delete(level);
        const loadedBeforePrune = new Set(listings.keys());
        const pruneStart = performance.now();
        listings = browserTree.pruneListings(listings, expanded, "", []);
        pruneMs += performance.now() - pruneStart;
        const collapsedRows = rowPathSet(flatten(listings, expanded));
        collapseMs += performance.now() - collapseStart;

        listingCountAfterPrune = listings.size;
        misses += setDifferenceCount(baselineRows, collapsedRows);
        // The rows above cannot see the prune: with the spine collapsed,
        // `flattenTree` never reaches those listings, so a prune that returned
        // its input untouched renders exactly the same collapsed tree. What it
        // cannot fake is which listings survived — the root plus whatever is
        // still expanded, and nothing else. Keeping the root matters in the
        // other direction: losing it empties the tree outright, which reads as
        // a very fast collapse.
        const expectedSurviving = new Set<string>([""]);
        for (const dir of expanded) if (loadedBeforePrune.has(dir)) expectedSurviving.add(dir);
        misses += setDifferenceCount(expectedSurviving, new Set(listings.keys()));
      }

      const durationMs = performance.now() - start;

      return {
        durationMs,
        metrics: {
          expandMs,
          collapseMs,
          pruneMs,
          p99ExpandStepMs: percentile(stepDurations, 99),
          expandStepCount: stepDurations.length,
          spineDepth: spine.length,
          rowCountAtFullExpansion,
          listingCountAfterPrune,
          expandCollapseMisses: misses,
        },
      };
    },
  },
  {
    id: "PERF-244",
    name: "Review Hub File List - Realistic Changeset",
    description:
      "Opening the Review Hub on a ~45-file changeset: a real hardened simple-git client runs " +
      "`git status` and `rev-parse HEAD`, the real getPerFileDiffStats issues the two batched " +
      "`git diff --numstat` calls behind the churn column, and the hub's own derivation " +
      "(isGeneratedFile, matchesFilter, sortFiles, sumChurn, deriveReviewReadiness) builds the " +
      "rendered lists. churnColdMs drops the 5s staging cache first, which is what a real refresh " +
      "pays; churnWarmMs is the cache hit beside it. The status→entry mapping lives inside an " +
      "unreachable IPC handler closure and is reproduced in the fixture — its share is reported " +
      "as mappingMs so it can never hide inside a measured number. sortOrderMisses holds the two " +
      "section orders to the manifest and churnTotalMisses holds the chip's totals to the churn " +
      "the fixture wrote, so neither an identity sortFiles nor a sumChurn returning zeros can " +
      "read as a fast, healthy open.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 5, ci: 10, nightly: 14 },
    warmups: 1,
    correctness: [
      "fileListMisses",
      "churnMisses",
      "churnTotalMisses",
      "sortOrderMisses",
      "readinessMisses",
    ],
    async run() {
      const fixture = getReviewFixture();
      return runReviewHub(fixture.representative);
    },
  },
  {
    id: "PERF-245",
    name: "Review Hub File List - Changeset Scaling",
    description:
      "The same pipeline against a long-running branch: ~420 changed files at double the churn " +
      "per file, so both axes the Review Hub scales on move at once. msPerKFile normalises the " +
      "whole open by changed-file count. The same five miss counts apply — a numstat that " +
      "returned nothing would make this the fastest run in the table.",
    tier: "heavy",
    modes: ["ci", "nightly"],
    iterations: { ci: 6, nightly: 10 },
    warmups: 1,
    correctness: [
      "fileListMisses",
      "churnMisses",
      "churnTotalMisses",
      "sortOrderMisses",
      "readinessMisses",
    ],
    async run() {
      const fixture = getReviewFixture();
      const sample = await runReviewHub(fixture.large);
      const changed = sample.metrics?.changedFileCount ?? 0;
      return {
        ...sample,
        metrics: {
          ...sample.metrics,
          msPerKFile: sample.durationMs / (Math.max(1, changed) / 1000),
        },
      };
    },
  },
  {
    id: "PERF-246",
    name: "File Viewer Load - Large Source File",
    description:
      "Opening the file panel on a TypeScript file sized from the real FILE_PREVIEW_MAX_BYTES " +
      "ceiling: read it, resolve a language through the viewer's own CODEMIRROR_LANGUAGES " +
      "registry, build the CodeMirror EditorState and force the Lezer parse — first to a " +
      "screenful, then to the end of the document. This is PARSE COST, not first paint: " +
      "production mounts an EditorView that parses incrementally against the viewport under a " +
      "time budget, and the main-process read (containment, O_NOFOLLOW, the null-byte scan) sits " +
      "in an IPC handler closure that cannot be called here, so fileReadMs is a plain read. " +
      "languageLoadMs is the memoized resolution after the warmup paid the chunk import once. " +
      "viewerLoadMisses proves a language matched and both parses covered the text they claimed.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 6, ci: 12, nightly: 16 },
    warmups: 1,
    correctness: ["viewerLoadMisses"],
    async run() {
      const fixture = await getViewerFixture();
      const modules = await loadViewerModules();

      const start = performance.now();

      const readStart = performance.now();
      const content = await readFile(fixture.largeSource.path, "utf-8");
      const fileReadMs = performance.now() - readStart;

      const basename = fixture.largeSource.path.split(/[/\\]/).pop() ?? "";
      const matchStart = performance.now();
      const description = modules.LanguageDescription.matchFilename(
        modules.CODEMIRROR_LANGUAGES,
        basename
      );
      const matchFilenameMs = performance.now() - matchStart;

      let languageLoadMs = 0;
      let stateCreateMs = 0;
      let viewportParseMs = 0;
      let fullParseMs = 0;
      let viewportCovered = false;
      let fullCovered = false;

      if (description) {
        const loadStart = performance.now();
        const support = await description.load();
        languageLoadMs = performance.now() - loadStart;

        const createStart = performance.now();
        const state = modules.EditorState.create({ doc: content, extensions: [support] });
        stateCreateMs = performance.now() - createStart;

        // A screenful before anything can render, then the rest — the split the
        // viewport-biased parser makes in production.
        const viewportChars = Math.min(state.doc.length, 6_000);
        const viewportStart = performance.now();
        const viewportTree = modules.ensureSyntaxTree(state, viewportChars, 10_000);
        viewportParseMs = performance.now() - viewportStart;
        viewportCovered = viewportTree !== null && viewportTree.length >= viewportChars;

        const fullStart = performance.now();
        const fullTree = modules.ensureSyntaxTree(state, state.doc.length, 30_000);
        fullParseMs = performance.now() - fullStart;
        fullCovered = fullTree !== null && fullTree.length >= state.doc.length;
      }

      const durationMs = performance.now() - start;
      const viewerLoadMisses =
        (description?.name === "TypeScript" ? 0 : 1) +
        (viewportCovered ? 0 : 1) +
        (fullCovered ? 0 : 1);

      return {
        durationMs,
        metrics: {
          fileReadMs,
          matchFilenameMs,
          languageLoadMs,
          stateCreateMs,
          viewportParseMs,
          fullParseMs,
          msPerKLine: (viewportParseMs + fullParseMs) / (fixture.largeSource.lines / 1000),
          sourceBytes: fixture.largeSource.bytes,
          sourceLineCount: fixture.largeSource.lines,
          viewerLoadMisses,
        },
        notes:
          viewerLoadMisses > 0
            ? "the viewer pipeline did not resolve a language or did not parse the whole document"
            : undefined,
      };
    },
  },
  {
    id: "PERF-247",
    name: "Review Hub + Diff Shelf File Lists - Mount and Selection",
    description:
      "What the Review Hub's file section and the diff workspace's shelf cost to MOUNT, at " +
      "PERF-245's 423-file changeset and a 2,000-file one. PERF-244/245 measure the same " +
      "surfaces with the renderer deliberately absent; this is the half they cannot see. Real " +
      "components, real react-virtuoso, real React 19 reconciliation, under jsdom — so there " +
      "is no compositor, no paint and no Chromium layout, and the viewport is supplied by " +
      "react-virtuoso's own VirtuosoMockContext at a documented 640px. These are JS-thread " +
      "mount and reconcile costs, not frames. mountedRows counts DOM nodes that exist, not a " +
      "range Virtuoso reported about itself — overscan makes those different numbers. Each run " +
      "carries its own negative control: the same lists are measured again with windowing " +
      "disabled, and controlMisses is nonzero unless that arm mounted every row, because a " +
      "benchmark that cannot tell a windowed list from an unwindowed one cannot report either.",
    tier: "heavy",
    modes: ["ci", "nightly"],
    iterations: { ci: 3, nightly: 5 },
    warmups: 0,
    correctness: ["windowingMisses", "selectionMisses", "controlMisses"],
    workloadFloors: { workingTree2000FileCount: 2000, shelf2000FileCount: 2000 },
    async run() {
      const m = await runRendererBenchmark();

      const windowed = [
        "windowedWorkingTree420",
        "windowedWorkingTree2000",
        "windowedShelf420",
        "windowedShelf2000",
      ];
      const windowingMisses = windowed.reduce(
        (sum, key) => sum + requireMetric(m, `${key}WindowingMisses`),
        0
      );
      const selectionMisses = windowed.reduce(
        (sum, key) => sum + requireMetric(m, `${key}SelectionMisses`),
        0
      );
      // Inverted on purpose: the control arm is SUPPOSED to mount every row. A
      // control that quietly windowed would make the comparison a comparison of
      // the same thing twice, and every "before" number below it a fiction.
      const controlMisses =
        (requireMetric(m, "staticWorkingTree2000MountedRows") === 2000 ? 0 : 1) +
        (requireMetric(m, "staticShelf2000MountedRows") === 2000 ? 0 : 1);

      const durationMs = windowed.reduce(
        (sum, key) =>
          sum +
          requireMetric(m, `${key}InitialRenderMs`) +
          requireMetric(m, `${key}SelectionChangeMs`),
        0
      );

      return {
        durationMs,
        metrics: {
          workingTree420MountedRows: requireMetric(m, "windowedWorkingTree420MountedRows"),
          workingTree420InitialRenderMs: requireMetric(m, "windowedWorkingTree420InitialRenderMs"),
          workingTree420SelectionChangeMs: requireMetric(
            m,
            "windowedWorkingTree420SelectionChangeMs"
          ),
          workingTree2000MountedRows: requireMetric(m, "windowedWorkingTree2000MountedRows"),
          workingTree2000InitialRenderMs: requireMetric(
            m,
            "windowedWorkingTree2000InitialRenderMs"
          ),
          workingTree2000SelectionChangeMs: requireMetric(
            m,
            "windowedWorkingTree2000SelectionChangeMs"
          ),
          workingTree2000FileCount: requireMetric(m, "windowedWorkingTree2000FileCount"),
          shelf420MountedRows: requireMetric(m, "windowedShelf420MountedRows"),
          shelf420InitialRenderMs: requireMetric(m, "windowedShelf420InitialRenderMs"),
          shelf420SelectionChangeMs: requireMetric(m, "windowedShelf420SelectionChangeMs"),
          shelf2000MountedRows: requireMetric(m, "windowedShelf2000MountedRows"),
          shelf2000InitialRenderMs: requireMetric(m, "windowedShelf2000InitialRenderMs"),
          shelf2000SelectionChangeMs: requireMetric(m, "windowedShelf2000SelectionChangeMs"),
          shelf2000FileCount: requireMetric(m, "windowedShelf2000FileCount"),
          // The control arm, reported rather than discarded: it is what a
          // before/after reading of this change is made of, measured in the
          // same process on the same machine as the numbers above it.
          controlWorkingTree2000MountedRows: requireMetric(m, "staticWorkingTree2000MountedRows"),
          controlWorkingTree2000InitialRenderMs: requireMetric(
            m,
            "staticWorkingTree2000InitialRenderMs"
          ),
          controlWorkingTree2000SelectionChangeMs: requireMetric(
            m,
            "staticWorkingTree2000SelectionChangeMs"
          ),
          controlShelf2000MountedRows: requireMetric(m, "staticShelf2000MountedRows"),
          controlShelf2000InitialRenderMs: requireMetric(m, "staticShelf2000InitialRenderMs"),
          controlShelf2000SelectionChangeMs: requireMetric(m, "staticShelf2000SelectionChangeMs"),
          windowingMisses,
          selectionMisses,
          controlMisses,
        },
      };
    },
  },
];

/**
 * One Review Hub open, end to end.
 *
 * Shared by PERF-244 and PERF-245 because the pipeline is identical and only
 * the changeset differs — a second copy would let the two drift and stop being
 * a scaling pair.
 */
async function runReviewHub(
  repo: ReturnType<typeof getReviewFixture>["representative"]
): Promise<{ durationMs: number; metrics: Record<string, number>; notes?: string }> {
  const modules = await loadReviewModules();
  const { sortFiles, matchesFilter, sumChurn, DEFAULT_SECTION_STATE } = modules.reviewHubUtils;

  const start = performance.now();

  const git = await modules.createHardenedGit(repo.path);

  const statusStart = performance.now();
  const status = await git.status();
  const statusMs = performance.now() - statusStart;

  const mappingStart = performance.now();
  const { staged, unstaged } = mapStagingEntries({
    files: status.files,
    conflicted: status.conflicted,
  });
  const mappingMs = performance.now() - mappingStart;

  const headOid = (await git.revparse(["HEAD"])).trim();
  const stagedPaths = staged.map((entry) => entry.path);
  const unstagedTrackedPaths = unstaged
    .filter((entry) => entry.status !== "untracked")
    .map((entry) => entry.path);

  // The product's own 5s cache would otherwise serve every iteration after the
  // first, reporting a cache hit as the cost of a refresh.
  modules.clearStagingDiffStatCache();
  const churnStart = performance.now();
  const [stagedStats, unstagedStats] = await Promise.all([
    modules.getPerFileDiffStats(git, repo.path, headOid, stagedPaths, "staged"),
    modules.getPerFileDiffStats(git, repo.path, headOid, unstagedTrackedPaths, "unstaged"),
  ]);
  const churnColdMs = performance.now() - churnStart;

  const warmStart = performance.now();
  await Promise.all([
    modules.getPerFileDiffStats(git, repo.path, headOid, stagedPaths, "staged"),
    modules.getPerFileDiffStats(git, repo.path, headOid, unstagedTrackedPaths, "unstaged"),
  ]);
  const churnWarmMs = performance.now() - warmStart;

  for (const entry of staged) {
    const stats = stagedStats.get(entry.path);
    if (stats) {
      entry.insertions = stats.insertions;
      entry.deletions = stats.deletions;
    }
  }
  for (const entry of unstaged) {
    const stats = unstagedStats.get(entry.path);
    if (stats) {
      entry.insertions = stats.insertions;
      entry.deletions = stats.deletions;
    }
  }

  // Exactly ReviewHubContent's derivation: hide generated, apply the section
  // filter, sort, then the churn chip and the readiness rail.
  const deriveStart = performance.now();
  const derivedStaged = sortFiles(
    staged,
    DEFAULT_SECTION_STATE.sortKey,
    DEFAULT_SECTION_STATE.sortDir
  );
  const derivedUnstaged = sortFiles(
    unstaged,
    DEFAULT_SECTION_STATE.sortKey,
    DEFAULT_SECTION_STATE.sortDir
  );
  const withoutGenerated = derivedStaged.filter((file) => !modules.isGeneratedFile(file.path));
  const filtered = [...derivedStaged, ...derivedUnstaged].filter((file) =>
    matchesFilter(file.path, repo.filterGlob)
  );
  const churn = sumChurn([...derivedStaged, ...derivedUnstaged]);
  const readiness = modules.deriveReviewReadiness({
    status: stagingStatusFor(derivedStaged, derivedUnstaged, status.current),
  });
  const deriveMs = performance.now() - deriveStart;

  const durationMs = performance.now() - start;

  // Oracles, all against what the fixture wrote to the repository.
  const expectedStaged = new Set(repo.stagedPaths);
  const expectedUnstaged = new Set([...repo.unstagedPaths, ...repo.untrackedPaths]);
  const expectedFiltered = [...derivedStaged, ...derivedUnstaged].filter((file) =>
    file.path.startsWith(repo.filterPrefix)
  ).length;
  const expectedGeneratedDropped = repo.generatedPaths.length;

  const fileListMisses =
    setDifferenceCount(expectedStaged, new Set(derivedStaged.map((f) => f.path))) +
    setDifferenceCount(expectedUnstaged, new Set(derivedUnstaged.map((f) => f.path))) +
    (filtered.length === expectedFiltered ? 0 : 1) +
    (derivedStaged.length - withoutGenerated.length === expectedGeneratedDropped ? 0 : 1);

  // The sets above are blind to order, and order is all `sortFiles` produces:
  // `git status` already hands its files over path-ordered, so a version
  // returning its input unchanged differs from a working one only in where the
  // generated tier sits.
  const sortOrderMisses =
    sequenceMismatchCount(
      expectedReviewOrder(repo.stagedPaths, repo.generatedPaths),
      derivedStaged.map((file) => file.path)
    ) +
    sequenceMismatchCount(
      expectedReviewOrder([...repo.unstagedPaths, ...repo.untrackedPaths], repo.generatedPaths),
      derivedUnstaged.map((file) => file.path)
    );

  // Untracked files legitimately carry no numstat entry; every tracked change
  // must have one, and a numstat that returned nothing leaves them all null.
  const trackedChanged = [...derivedStaged, ...derivedUnstaged].filter(
    (file) => file.status !== "untracked"
  );
  const churnMisses = trackedChanged.filter((file) => file.insertions === null).length;

  // Per-file non-null is not enough for the chip: `sumChurn` returning zeros
  // paints a plausible changeset over a file list that is otherwise correct.
  // The fixture generated the changeset, so the totals are known exactly.
  const churnTotalMisses =
    (churn.ins === repo.expectedInsertions ? 0 : 1) +
    (churn.del === repo.expectedDeletions ? 0 : 1);

  const readinessMisses =
    (readiness.commitReady ? 0 : 1) +
    (readiness.level === "ready" ? 0 : 1) +
    (readiness.blockers.length === 0 ? 0 : 1);

  const changedFileCount = derivedStaged.length + derivedUnstaged.length;

  return {
    durationMs,
    metrics: {
      statusMs,
      mappingMs,
      churnColdMs,
      churnWarmMs,
      deriveMs,
      stagedFileCount: derivedStaged.length,
      unstagedFileCount: derivedUnstaged.length,
      changedFileCount,
      filterMatchCount: filtered.length,
      generatedFileCount: expectedGeneratedDropped,
      insertionCount: churn.ins,
      deletionCount: churn.del,
      expectedInsertionCount: repo.expectedInsertions,
      expectedDeletionCount: repo.expectedDeletions,
      fileListMisses,
      churnMisses,
      churnTotalMisses,
      sortOrderMisses,
      readinessMisses,
    },
    notes:
      churnMisses > 0
        ? `${churnMisses} changed files came back without churn — the numstat read produced nothing`
        : churnTotalMisses > 0
          ? `churn totalled ${churn.ins}/${churn.del} against the ${repo.expectedInsertions}/${repo.expectedDeletions} the fixture wrote`
          : undefined,
  };
}
