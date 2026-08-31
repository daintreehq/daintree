import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import type { FileTreeNode } from "../../../shared/types/ipc";
import type { PerfScenario } from "../types";
import { percentile } from "../lib/stats";
import {
  addJunkFile,
  expectedHiddenCounts,
  expectedVisiblePaths,
  getFileBrowserFixture,
  getReviewFixture,
  getViewerFixture,
  listDirectories,
  loadAlwaysHiddenPatterns,
  loadBrowserTreeModule,
  loadReviewModules,
  loadViewerModules,
  mapStagingEntries,
  mutateTree,
  pickExpansion,
  rowPathSet,
  setDifferenceCount,
  stagingStatusFor,
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
  listMs: number;
  flattenMs: number;
  hiddenMs: number;
  nodeCount: number;
  directoryCount: number;
  rowCount: number;
  hiddenDotfileCount: number;
  hiddenJunkCount: number;
  rowMisses: number;
  hiddenMisses: number;
}

/**
 * Fetch every listing a panel with this expansion would hold, then run the real
 * row build over it.
 *
 * The two miss counts are the whole point of the return shape: `rowMisses` is
 * the symmetric difference against the manifest, so both a tree that produced
 * too few rows and one that leaked hidden entries into the list score; and
 * `hiddenMisses` holds the two tallies to the numbers the generator wrote,
 * which is what stops a filter that silently over-hides from reading as a
 * cheaper tree build.
 */
async function buildTreeRows(
  tree: ReturnType<typeof getFileBrowserFixture>["representative"],
  expanded: Set<string>,
  hideDotfiles: boolean,
  alwaysHiddenPatterns: readonly string[]
): Promise<TreeBuild> {
  const browserTree = await loadBrowserTreeModule();
  const directories = ["", ...[...expanded].sort()];

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

  const expectedRows = expectedVisiblePaths(tree, expanded, hideDotfiles);
  const expectedHidden = expectedHiddenCounts(tree, expanded, hideDotfiles);

  return {
    listMs,
    flattenMs,
    hiddenMs,
    nodeCount: nodes,
    directoryCount: directories.length,
    rowCount: rows.length,
    hiddenDotfileCount: hidden.dotfiles,
    hiddenJunkCount: hidden.alwaysHidden,
    rowMisses: setDifferenceCount(expectedRows, rowPathSet(rows)),
    hiddenMisses:
      Math.abs(hidden.dotfiles - expectedHidden.dotfiles) +
      Math.abs(hidden.alwaysHidden - expectedHidden.alwaysHidden),
  };
}

/** Monotonic per-call token so a mutating iteration cannot collide with another. */
let mutationToken = 0;

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
      "filter that over-hides is not rewarded for walking fewer rows.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 5, ci: 10, nightly: 14 },
    warmups: 1,
    correctness: ["treeRowMisses", "hiddenCountMisses"],
    async run() {
      const fixture = getFileBrowserFixture();
      const alwaysHiddenPatterns = await loadAlwaysHiddenPatterns();
      const expanded = pickExpansion(fixture.representative, REPRESENTATIVE_EXPANSION);

      const start = performance.now();
      // The product default: dotfiles shown, the junk list applied.
      const build = await buildTreeRows(
        fixture.representative,
        expanded,
        false,
        alwaysHiddenPatterns
      );
      const durationMs = performance.now() - start;

      return {
        durationMs,
        metrics: {
          listMs: build.listMs,
          flattenMs: build.flattenMs,
          hiddenCountMs: build.hiddenMs,
          directoryCount: build.directoryCount,
          nodeCount: build.nodeCount,
          rowCount: build.rowCount,
          hiddenDotfileCount: build.hiddenDotfileCount,
          hiddenJunkCount: build.hiddenJunkCount,
          treeRowMisses: build.rowMisses,
          hiddenCountMisses: build.hiddenMisses,
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
      "per-entry lstat path or in sortFileNodes. All three passes carry their own miss counts.",
    tier: "heavy",
    modes: ["ci", "nightly"],
    iterations: { ci: 6, nightly: 10 },
    warmups: 1,
    correctness: ["treeRowMisses", "hiddenCountMisses"],
    async run() {
      const fixture = getFileBrowserFixture();
      const alwaysHiddenPatterns = await loadAlwaysHiddenPatterns();
      const smallExpansion = pickExpansion(fixture.representative, REPRESENTATIVE_EXPANSION);
      const largeExpansion = pickExpansion(fixture.large, LARGE_EXPANSION);

      const start = performance.now();
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
      const durationMs = performance.now() - start;

      const largeBuildMs = large.listMs + large.flattenMs + large.hiddenMs;

      return {
        durationMs,
        metrics: {
          smallListMs: small.listMs,
          smallFlattenMs: small.flattenMs,
          largeListMs: large.listMs,
          largeFlattenMs: large.flattenMs,
          largeHiddenCountMs: large.hiddenMs,
          dotfilesHiddenFlattenMs: largeHidingDotfiles.flattenMs,
          msPerKNode: largeBuildMs / (large.nodeCount / 1000),
          largeNodeCount: large.nodeCount,
          largeRowCount: large.rowCount,
          largeHiddenJunkCount: large.hiddenJunkCount,
          dotfilesHiddenRowCount: largeHidingDotfiles.rowCount,
          dotfilesHiddenTallyCount: largeHidingDotfiles.hiddenDotfileCount,
          treeRowMisses: small.rowMisses + large.rowMisses + largeHidingDotfiles.rowMisses,
          hiddenCountMisses:
            small.hiddenMisses + large.hiddenMisses + largeHidingDotfiles.hiddenMisses,
        },
      };
    },
  },
  {
    id: "PERF-242",
    name: "File Browser Refresh Sweep After a Change",
    description:
      "The incremental path: a fully-expanded tree takes three writes (a new visible file, a new " +
      "file the junk list hides, and an in-place edit), then runs the real refreshTargets → " +
      "re-list → flattenTree/countHiddenRows sweep. refreshTargets is content-blind, so " +
      "ignoredOnlySweepMs — a second sweep after nothing but a junk write — is deliberately " +
      "measured beside it: the cost of a refresh that had nothing to show. refreshMisses proves " +
      "the sweep both surfaced the new visible file AND counted the hidden one, which is the " +
      "shape of the staleness bug this panel has already shipped: an ignored-only write that the " +
      "tree never accounts for.",
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
      const expanded = new Set(tree.directories);
      const isVisible = browserTree.createVisibilityFilter({
        hideDotfiles: false,
        alwaysHiddenPatterns,
      });

      // Cold state a refresh starts from: every expanded listing already held.
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
      const removeQuietJunk = addJunkFile(tree, targetDirs[4] ?? "", token);

      try {
        const start = performance.now();

        const targets = browserTree.refreshTargets(listings, expanded, "", isVisible, null);
        const sweepStart = performance.now();
        const swept = await listDirectories(tree.path, targets);
        listings = swept.listings;
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
        const sweepMs = performance.now() - sweepStart;

        // A second sweep with only a junk file added since. Same targets, same
        // re-listing, nothing new to render — the tax an ignored-only change
        // levies when the tree does notice it.
        const quietStart = performance.now();
        const quietTargets = browserTree.refreshTargets(listings, expanded, "", isVisible, null);
        const quiet = await listDirectories(tree.path, quietTargets);
        const quietRows = browserTree.flattenTree(
          quiet.listings,
          expanded,
          new Set<string>(),
          "",
          isVisible,
          browserTree.DEFAULT_FILE_SORT
        );
        const quietHidden = browserTree.countHiddenRows(quiet.listings, expanded, "", {
          hideDotfiles: false,
          alwaysHiddenPatterns,
        });
        const ignoredOnlySweepMs = performance.now() - quietStart;

        const durationMs = performance.now() - start;

        // Both writes added this iteration are junk, so the expected hidden
        // tally is the manifest's plus two.
        const expectedRows = expectedVisiblePaths(tree, expanded, false);
        expectedRows.add(mutation.visiblePath);
        const expectedHidden = expectedHiddenCounts(tree, expanded, false);

        const refreshMisses =
          setDifferenceCount(expectedRows, rowPathSet(rows)) +
          setDifferenceCount(expectedRows, rowPathSet(quietRows)) +
          Math.abs(hidden.alwaysHidden - (expectedHidden.alwaysHidden + 2)) +
          Math.abs(quietHidden.alwaysHidden - (expectedHidden.alwaysHidden + 2));

        return {
          durationMs,
          metrics: {
            sweepMs,
            ignoredOnlySweepMs,
            refreshTargetCount: targets.length,
            relistedNodeCount: swept.nodes,
            rowCount: rows.length,
            hiddenJunkCount: hidden.alwaysHidden,
            refreshMisses,
          },
          notes:
            refreshMisses > 0
              ? "the refresh sweep did not reconcile the staged writes — rows or hidden tallies disagree with disk"
              : undefined,
        };
      } finally {
        removeQuietJunk();
        mutation.revert();
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
      "collapsed rows against the baseline, so a chain that stopped descending scores every cycle.",
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
        const pruneStart = performance.now();
        listings = browserTree.pruneListings(listings, expanded, "", []);
        pruneMs += performance.now() - pruneStart;
        const collapsedRows = rowPathSet(flatten(listings, expanded));
        collapseMs += performance.now() - collapseStart;

        listingCountAfterPrune = listings.size;
        misses += setDifferenceCount(baselineRows, collapsedRows);
        // The prune must keep the root; losing it empties the tree outright,
        // which reads as a very fast collapse.
        if (!listings.has("")) misses += 1;
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
      "as mappingMs so it can never hide inside a measured number.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 5, ci: 10, nightly: 14 },
    warmups: 1,
    correctness: ["fileListMisses", "churnMisses", "readinessMisses"],
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
      "whole open by changed-file count. The same three miss counts apply — a numstat that " +
      "returned nothing would make this the fastest run in the table.",
    tier: "heavy",
    modes: ["ci", "nightly"],
    iterations: { ci: 6, nightly: 10 },
    warmups: 1,
    correctness: ["fileListMisses", "churnMisses", "readinessMisses"],
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

  // Untracked files legitimately carry no numstat entry; every tracked change
  // must have one, and a numstat that returned nothing leaves them all null.
  const trackedChanged = [...derivedStaged, ...derivedUnstaged].filter(
    (file) => file.status !== "untracked"
  );
  const churnMisses = trackedChanged.filter((file) => file.insertions === null).length;

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
      fileListMisses,
      churnMisses,
      readinessMisses,
    },
    notes:
      churnMisses > 0
        ? `${churnMisses} changed files came back without churn — the numstat read produced nothing`
        : undefined,
  };
}
