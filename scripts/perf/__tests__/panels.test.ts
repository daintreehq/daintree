import { afterAll, describe, expect, it } from "vitest";
import { allScenarios } from "../scenarios";
import { classifyMetric } from "../lib/comparability";
import {
  disposePanelFixtures,
  expectedHiddenCounts,
  expectedReviewOrder,
  expectedVisiblePaths,
  expectedVisibleRowOrder,
  getFileBrowserFixture,
  listDirectories,
  mutateTree,
  pickExpansion,
  sequenceMismatchCount,
  setDifferenceCount,
} from "../lib/panelsFixture";
import type { PerfMode, ScenarioContext } from "../types";

const PANEL_IDS = [
  "PERF-240",
  "PERF-241",
  "PERF-242",
  "PERF-243",
  "PERF-244",
  "PERF-245",
  "PERF-246",
  "PERF-247",
] as const;

function scenarioFor(id: string) {
  const scenario = allScenarios.find((candidate) => candidate.id === id);
  expect(scenario, `${id} is not registered`).toBeDefined();
  return scenario!;
}

function contextFor(mode: PerfMode): ScenarioContext {
  return { mode, now: () => performance.now() };
}

// Building ~15k fixture files plus two git repositories dominates these; the
// scenarios themselves run in tens of milliseconds.
const FIXTURE_TIMEOUT_MS = 180_000;

describe("panel scenarios (PERF-240..247)", () => {
  // A vitest worker is torn down without emitting `exit`, so the fixture's own
  // exit handler never fires here and ~70 MB of synthetic trees and repos would
  // survive every `npm test`.
  afterAll(() => disposePanelFixtures());

  it("declares every panel id with a count-class correctness predicate", () => {
    for (const id of PANEL_IDS) {
      const scenario = scenarioFor(id);
      expect(scenario.correctness?.length, `${id} declares no predicate`).toBeGreaterThan(0);
      for (const metric of scenario.correctness ?? []) {
        // A predicate that classifies as a duration would be written off as
        // timing noise by `perf compare` on exactly the run that needed it.
        expect(classifyMetric(metric), `${id}:${metric}`).toBe("count");
      }
    }
  });

  it(
    "PERF-240 builds the rows the fixture wrote and hides exactly the junk",
    { timeout: FIXTURE_TIMEOUT_MS },
    async () => {
      const sample = await scenarioFor("PERF-240").run(contextFor("smoke"));
      const metrics = sample.metrics!;
      expect(metrics.treeRowMisses).toBe(0);
      expect(metrics.hiddenCountMisses).toBe(0);
      expect(metrics.rowOrderMisses).toBe(0);
      expect(metrics.resortFlattenMs).toBeGreaterThan(0);
      // A tree that produced no rows would satisfy a miss count derived from
      // its own output; these are the readings that make it impossible here.
      expect(metrics.rowCount).toBeGreaterThan(500);
      expect(metrics.nodeCount).toBeGreaterThan(metrics.rowCount!);
      expect(metrics.hiddenJunkCount).toBeGreaterThan(0);
      expect(metrics.listMs).toBeGreaterThan(0);
    }
  );

  it(
    "PERF-242 prices one sweep per write, each after its own change",
    { timeout: FIXTURE_TIMEOUT_MS },
    async () => {
      const sample = await scenarioFor("PERF-242").run(contextFor("smoke"));
      const metrics = sample.metrics!;
      expect(metrics.refreshMisses).toBe(0);
      expect(metrics.refreshTargetCount).toBeGreaterThan(1);
      expect(metrics.relistedNodeCount).toBeGreaterThan(100);
      // Three unscoped arms, each priced separately. The middle one is the
      // scenario's original point: a change with nothing to show still pays a
      // full sweep, because refreshTargets is content-blind.
      expect(metrics.sweepMs).toBeGreaterThan(0);
      expect(metrics.ignoredOnlySweepMs).toBeGreaterThan(0);
      expect(metrics.inPlaceEditSweepMs).toBeGreaterThan(0);
      expect(sample.durationMs).toBeGreaterThanOrEqual(
        metrics.sweepMs! + metrics.ignoredOnlySweepMs! + metrics.inPlaceEditSweepMs!
      );
      // An unscoped sweep re-lists the root plus every expanded directory, and
      // commits one listings-map copy per response.
      expect(metrics.fullDirectoryRequests).toBe(metrics.refreshTargetCount);
      expect(metrics.fullDirectoryRequests).toBeGreaterThan(20);
      expect(metrics.fullListingsMapCopies).toBe(metrics.fullDirectoryRequests);
    }
  );

  it(
    "PERF-242 scopes a sweep to the directories a burst actually touched",
    { timeout: FIXTURE_TIMEOUT_MS },
    async () => {
      const sample = await scenarioFor("PERF-242").run(contextFor("smoke"));
      const metrics = sample.metrics!;
      // Exact, not "smaller than": the whole feature is that the count drops to
      // the number of directories written to, and a near-miss here (an extra
      // root request, or a conversion that fell back to the full sweep) is the
      // regression the arm exists to name.
      expect(metrics.scopedSubtreeDirectoryRequests).toBe(1);
      expect(metrics.scopedRootDirectoryRequests).toBe(1);
      expect(metrics.scopedMultiDirectoryRequests).toBe(3);
      // Twenty writes over three directories cost three listings, not twenty:
      // the affected set is deduped to parents before it reaches the tree.
      expect(metrics.scopedMultiListingsMapCopies).toBe(3);
      expect(metrics.scopedSubtreeListingsMapCopies).toBe(1);
      expect(metrics.scopedRootListingsMapCopies).toBe(1);
      // And the correctness oracle covers the scoped arms too: refreshMisses is
      // asserted zero above over an expectation set that includes every burst
      // file, so a scoped sweep that dropped the listings it did not re-read
      // would score there rather than pass quietly here.
      expect(metrics.refreshMisses).toBe(0);
      expect(metrics.scopedSubtreeSweepMs).toBeGreaterThan(0);
      expect(metrics.scopedRootSweepMs).toBeGreaterThan(0);
      expect(metrics.scopedMultiSweepMs).toBeGreaterThan(0);
    }
  );

  it(
    "PERF-243 re-reads the subtree after a collapse rather than replaying a cache",
    { timeout: FIXTURE_TIMEOUT_MS },
    async () => {
      const sample = await scenarioFor("PERF-243").run(contextFor("smoke"));
      const metrics = sample.metrics!;
      expect(metrics.expandCollapseMisses).toBe(0);
      expect(metrics.spineDepth).toBeGreaterThanOrEqual(4);
      // Three cycles over the whole chain, each level a separate fetch.
      expect(metrics.expandStepCount).toBe(metrics.spineDepth! * 3);
      // pruneListings must drop the whole subtree, leaving only the root.
      expect(metrics.listingCountAfterPrune).toBe(1);
      expect(metrics.rowCountAtFullExpansion).toBeGreaterThan(0);
    }
  );

  it(
    "PERF-244 reads real churn for every tracked change and warms its cache",
    { timeout: FIXTURE_TIMEOUT_MS },
    async () => {
      const sample = await scenarioFor("PERF-244").run(contextFor("smoke"));
      const metrics = sample.metrics!;
      expect(metrics.fileListMisses).toBe(0);
      expect(metrics.churnMisses).toBe(0);
      expect(metrics.churnTotalMisses).toBe(0);
      expect(metrics.sortOrderMisses).toBe(0);
      expect(metrics.readinessMisses).toBe(0);
      expect(metrics.changedFileCount).toBeGreaterThan(30);
      expect(metrics.insertionCount).toBe(metrics.expectedInsertionCount);
      expect(metrics.deletionCount).toBe(metrics.expectedDeletionCount);
      // The generated files were committed at half the length they were
      // rewritten at, so the two totals are deliberately not the same number.
      expect(metrics.insertionCount).toBeGreaterThan(metrics.deletionCount!);
      // The 5s staging cache is dropped before the cold read, so the two are
      // genuinely different paths rather than the same cache hit twice.
      expect(metrics.churnColdMs).toBeGreaterThan(metrics.churnWarmMs!);
      // The generated files in the changeset are what the section's generated
      // tier and its hide toggle act on.
      expect(metrics.generatedFileCount).toBeGreaterThan(0);
      expect(metrics.filterMatchCount).toBeGreaterThan(0);
    }
  );

  it(
    "PERF-246 resolves a language and parses the whole document",
    { timeout: FIXTURE_TIMEOUT_MS },
    async () => {
      const sample = await scenarioFor("PERF-246").run(contextFor("smoke"));
      const metrics = sample.metrics!;
      expect(metrics.viewerLoadMisses).toBe(0);
      // Sized from the real FILE_PREVIEW_MAX_BYTES ceiling (512 KiB).
      expect(metrics.sourceBytes).toBeGreaterThan(400_000);
      expect(metrics.sourceBytes).toBeLessThan(512 * 1024);
      expect(metrics.sourceLineCount).toBeGreaterThan(5_000);
      expect(metrics.fullParseMs).toBeGreaterThan(0);
      expect(metrics.viewportParseMs).toBeGreaterThan(0);
      // The viewport slice must be a fraction of the whole-document parse, or
      // the split into "a screenful" and "the rest" is not measuring anything.
      expect(metrics.viewportParseMs).toBeLessThan(metrics.fullParseMs!);
    }
  );

  it(
    "the manifest oracle is independent of the product filter",
    { timeout: FIXTURE_TIMEOUT_MS },
    async () => {
      const tree = getFileBrowserFixture().representative;
      const expanded = pickExpansion(tree, 12);
      const visible = expectedVisiblePaths(tree, expanded, false);
      const hidden = expectedHiddenCounts(tree, expanded, false);

      // The expectation is built from the generator's buckets, never by
      // matching a pattern, so no junk basename can appear in it and the junk
      // tally is non-zero regardless of what the shipped globs currently are.
      expect(hidden.alwaysHidden).toBeGreaterThan(0);
      for (const path of visible) {
        const basename = path.slice(path.lastIndexOf("/") + 1);
        expect(basename).not.toBe(".git");
        expect(basename).not.toBe(".DS_Store");
      }

      // Hiding dotfiles must strictly shrink the expected rows and grow the
      // expected dotfile tally — an oracle that ignored the toggle would let a
      // filter regression through in whichever direction it broke.
      const hidingDotfiles = expectedVisiblePaths(tree, expanded, true);
      expect(hidingDotfiles.size).toBeLessThan(visible.size);
      expect(expectedHiddenCounts(tree, expanded, true).dotfiles).toBeGreaterThan(0);
    }
  );

  it(
    "the row-order oracle scores an order the set comparison cannot see",
    { timeout: FIXTURE_TIMEOUT_MS },
    async () => {
      const tree = getFileBrowserFixture().representative;
      const expanded = pickExpansion(tree, 12);
      const ascending = expectedVisibleRowOrder(tree, expanded, false, "asc");
      const descending = expectedVisibleRowOrder(tree, expanded, false, "desc");

      // Same rows either way — which is exactly why membership cannot tell a
      // working sort from one that handed its input straight back.
      expect(setDifferenceCount(new Set(ascending), new Set(descending))).toBe(0);
      expect(
        setDifferenceCount(new Set(ascending), expectedVisiblePaths(tree, expanded, false))
      ).toBe(0);
      expect(sequenceMismatchCount(descending, ascending)).toBeGreaterThan(0);
      expect(sequenceMismatchCount(ascending, ascending)).toBe(0);

      // Folders lead at every level, so the first row is a directory whatever
      // the direction — the grouping is structural, not part of the sort.
      const directories = new Set(tree.directories);
      expect(directories.has(ascending[0]!)).toBe(true);
      expect(directories.has(descending[0]!)).toBe(true);
    }
  );

  it("the Review Hub order oracle puts the generated tier last", () => {
    const paths = ["src/a.ts", "package-lock.json", "src/b.ts", "dist/bundle.js"];
    const generated = ["package-lock.json", "dist/bundle.js"];
    expect(expectedReviewOrder(paths, generated)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "dist/bundle.js",
      "package-lock.json",
    ]);
    // `git status` hands paths over already sorted, so the tier boundary is the
    // only thing separating the expectation from an untouched input.
    expect(
      sequenceMismatchCount(expectedReviewOrder(paths, generated), [...paths].sort())
    ).toBeGreaterThan(0);
  });

  it(
    "mutateTree restores the tree exactly, so an iteration cannot leak into the next",
    { timeout: FIXTURE_TIMEOUT_MS },
    async () => {
      const tree = getFileBrowserFixture().mutable;
      const directories = tree.directories;
      const before = await listDirectories(tree.path, ["", ...directories]);

      const mutation = mutateTree(
        tree,
        { visibleDir: directories[1]!, junkDir: directories[2]!, touchDir: directories[3]! },
        "unit"
      );
      // Nothing is written until each arm asks for it — that is what lets a
      // sweep be measured against a change made since the last one.
      const untouched = await listDirectories(tree.path, ["", ...directories]);
      expect(untouched.nodes).toBe(before.nodes);

      mutation.writeVisible();
      mutation.writeJunk();
      mutation.writeTouch();
      const during = await listDirectories(tree.path, ["", ...directories]);
      expect(during.nodes).toBe(before.nodes + 2);

      mutation.revert();
      const after = await listDirectories(tree.path, ["", ...directories]);
      expect(after.nodes).toBe(before.nodes);

      const beforePaths = new Set<string>();
      for (const nodes of before.listings.values()) for (const n of nodes) beforePaths.add(n.path);
      const afterPaths = new Set<string>();
      for (const nodes of after.listings.values()) for (const n of nodes) afterPaths.add(n.path);
      expect(setDifferenceCount(beforePaths, afterPaths)).toBe(0);
    }
  );
});
