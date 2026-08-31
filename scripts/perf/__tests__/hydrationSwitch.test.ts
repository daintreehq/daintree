import { describe, expect, it } from "vitest";
import {
  buildLayoutMergePlan,
  layoutMergeMisses,
  runLayoutMergePass,
  type LayoutMergeObservation,
} from "../lib/layoutMergeFixture";
import {
  buildHydrationPlan,
  hydrationPassMisses,
  loadStatePatcherModule,
  runHydrationPass,
} from "../lib/hydrationFixture";
import {
  buildWorktreeScopePlan,
  runWorktreeScopePass,
  worktreeScopeMisses,
} from "../lib/worktreeScopeFixture";
import { hydrationSwitchScenarios } from "../scenarios/hydrationSwitch";
import type { ScenarioContext } from "../types";

const context: ScenarioContext = { mode: "smoke", now: () => performance.now() };

function scenario(id: string) {
  const found = hydrationSwitchScenarios.find((candidate) => candidate.id === id);
  expect(found, `${id} is not registered`).toBeDefined();
  return found!;
}

/**
 * These prove two things the perf runner cannot: that each scenario is still
 * reaching the real subject, and that its predicate says so when the subject
 * stops working. The negative cases corrupt the OBSERVATION rather than the
 * product, since the subjects here are shipped code — the equivalent stub
 * experiment against the real module is run by hand and recorded in the PR.
 */

describe("layoutMerge fixture drives the real merge", () => {
  const plan = buildLayoutMergePlan("test", 60, 4242);

  it("clears every accumulator on a healthy pass", () => {
    const observed = runLayoutMergePass(plan);
    expect(layoutMergeMisses(plan, observed)).toEqual({
      terminalDeltaMisses: 0,
      tabGroupDeltaMisses: 0,
      draftDeltaMisses: 0,
      payloadMisses: 0,
      terminalMergeMisses: 0,
      tabGroupMergeMisses: 0,
      draftMergeMisses: 0,
      identicalPassMisses: 0,
      singleChangeMisses: 0,
      equalityProbeMisses: 0,
    });
  });

  it("actually exercised the delta: some entries changed, some were removed, one field was claimed", () => {
    const observed = runLayoutMergePass(plan);
    // A plan where nothing changed would make every "misses" reading above
    // vacuously perfect.
    expect(observed.terminalDelta.changedIds.length).toBeGreaterThan(0);
    expect(observed.terminalDelta.removedIds.length).toBeGreaterThan(0);
    expect(observed.terminalDelta.fieldEdits?.length ?? 0).toBeGreaterThan(0);
    expect(observed.deepEqualCalls).toBeGreaterThan(plan.panelCount);
  });

  it("keeps a sibling window's concurrent edit and does not resurrect its deletion", () => {
    const observed = runLayoutMergePass(plan);
    const mergedIds = new Set(observed.mergedTerminals.map((entry) => entry.id));
    const siblingAdded = plan.onDiskTerminals.filter((entry) =>
      entry.id.startsWith("panel-sibling-add-")
    );
    expect(siblingAdded.length).toBeGreaterThan(0);
    for (const entry of siblingAdded) expect(mergedIds.has(entry.id)).toBe(true);
    // An entry the writer removed must be gone.
    for (const id of plan.expectedTerminalRemovedIds) expect(mergedIds.has(id)).toBe(false);
  });

  it("scores a delta that reported everything changed", () => {
    const observed = runLayoutMergePass(plan);
    const broken: LayoutMergeObservation = {
      ...observed,
      terminalDelta: {
        changedIds: plan.writerTerminals.map((entry) => entry.id),
        removedIds: observed.terminalDelta.removedIds,
        fieldEdits: observed.terminalDelta.fieldEdits,
      },
    };
    expect(layoutMergeMisses(plan, broken).terminalDeltaMisses).toBeGreaterThan(0);
  });

  it("scores a delta that reported nothing changed — the cheapest one there is", () => {
    const observed = runLayoutMergePass(plan);
    const broken: LayoutMergeObservation = {
      ...observed,
      terminalDelta: { changedIds: [], removedIds: [] },
    };
    expect(layoutMergeMisses(plan, broken).terminalDeltaMisses).toBeGreaterThan(0);
  });

  it("scores a merge that returned the writer's array untouched (the #11350 clobber)", () => {
    const observed = runLayoutMergePass(plan);
    const broken: LayoutMergeObservation = { ...observed, mergedTerminals: plan.writerTerminals };
    expect(layoutMergeMisses(plan, broken).terminalMergeMisses).toBeGreaterThan(0);
  });

  it("scores a merge that moved an unclaimed agentSessionId (the #11461 erase)", () => {
    const observed = runLayoutMergePass(plan);
    const broken: LayoutMergeObservation = {
      ...observed,
      mergedTerminals: observed.mergedTerminals.map((entry) => ({
        ...entry,
        agentSessionId: undefined,
      })),
    };
    expect(layoutMergeMisses(plan, broken).terminalMergeMisses).toBeGreaterThan(0);
  });

  it("scores a tab-group merge that was skipped while the panel merge stayed correct", () => {
    // The reason this is one accumulator per operation: an aggregate would be
    // carried by the panel terms and read zero here.
    const observed = runLayoutMergePass(plan);
    const broken: LayoutMergeObservation = { ...observed, mergedGroups: [] };
    const misses = layoutMergeMisses(plan, broken);
    expect(misses.tabGroupMergeMisses).toBeGreaterThan(0);
    expect(misses.terminalMergeMisses).toBe(0);
  });

  it("scores a draft merge that dropped a sibling window's key", () => {
    const observed = runLayoutMergePass(plan);
    const mergedDrafts = { ...observed.mergedDrafts };
    delete mergedDrafts["panel-sibling-add-0"];
    expect(layoutMergeMisses(plan, { ...observed, mergedDrafts }).draftMergeMisses).toBeGreaterThan(
      0
    );
  });

  it("scores a re-save of an identical array that claimed authority anyway", () => {
    const observed = runLayoutMergePass(plan);
    const broken: LayoutMergeObservation = {
      ...observed,
      identicalDelta: { changedIds: ["panel-1"], removedIds: [] },
    };
    expect(layoutMergeMisses(plan, broken).identicalPassMisses).toBeGreaterThan(0);
  });

  it("scores a one-field edit reported as more than one change", () => {
    const observed = runLayoutMergePass(plan);
    const broken: LayoutMergeObservation = {
      ...observed,
      singleChangeDelta: { changedIds: ["a", "b", "c"], removedIds: [] },
    };
    expect(layoutMergeMisses(plan, broken).singleChangeMisses).toBeGreaterThan(0);
  });

  it("scores an equality function that was consulted for only some entries", () => {
    const observed = runLayoutMergePass(plan);
    const broken: LayoutMergeObservation = { ...observed, deepEqualCalls: 1 };
    expect(layoutMergeMisses(plan, broken).equalityProbeMisses).toBeGreaterThan(0);
  });
});

describe("hydration fixture drives the real statePatcher", () => {
  it("clears every accumulator, and every route was actually taken", async () => {
    const plan = buildHydrationPlan("test", 64, 4);
    const mod = await loadStatePatcherModule();
    const observed = runHydrationPass(mod, plan);

    expect(hydrationPassMisses(plan, observed)).toEqual({
      kindInferenceMisses: 0,
      backendRestoreMisses: 0,
      reconnectRestoreMisses: 0,
      respawnResumeMisses: 0,
      resumeSuppressionMisses: 0,
      nonPtyRestoreMisses: 0,
      sanitizerMisses: 0,
      orphanMisses: 0,
      routeCoverageMisses: 0,
    });
    expect(observed.backendCount).toBeGreaterThan(0);
    expect(observed.reconnectedCount).toBeGreaterThan(0);
    expect(observed.respawnResumeCount).toBeGreaterThan(0);
    expect(observed.respawnWithheldCount).toBeGreaterThan(0);
    expect(observed.nonPtyCount).toBeGreaterThan(0);
    expect(observed.orphanCount).toBeGreaterThan(0);
    expect(observed.builtPanelCount).toBe(plan.panels.length);
  }, 30_000);

  it("plans every non-PTY kind, so each deserializer is actually reached", () => {
    // The slots that take the non-PTY routes are congruent mod 8, so cycling
    // the kind on the panel index left two of the four unreachable and their
    // sanitizer terms vacuously zero.
    const kinds = new Set(
      buildHydrationPlan("test", 64, 4)
        .panels.filter((planned) => planned.route === "nonPty")
        .map((planned) => planned.expectedKind)
    );
    expect([...kinds].sort()).toEqual(["browser", "diff", "file", "file-browser"]);
  });

  it("replays the saved session on the allowed route and withholds it on the other", async () => {
    const plan = buildHydrationPlan("test", 64, 4);
    const mod = await loadStatePatcherModule();
    const observed = runHydrationPass(mod, plan);

    // The two-sided pair, read directly rather than through the accumulator:
    // the same builder and the same snapshot, opposite requirements.
    for (let i = 0; i < plan.panels.length; i += 1) {
      const planned = plan.panels[i];
      const command = observed.built[i].command ?? "";
      if (planned.route === "respawnResume") {
        expect(command).toContain(planned.plantedSessionId!);
      } else if (planned.route === "respawnWithheld") {
        expect(command).not.toContain(planned.plantedSessionId!);
        expect(observed.built[i].sessionLostOnRestore).toBe(true);
      }
    }
  }, 30_000);

  it("scores a builder that always resumes, and one that never does", async () => {
    const plan = buildHydrationPlan("test", 64, 4);
    const mod = await loadStatePatcherModule();
    const observed = runHydrationPass(mod, plan);

    const alwaysResumes = {
      ...observed,
      built: observed.built.map((args, i) => ({
        ...args,
        command: `agent --resume ${plan.panels[i].plantedSessionId ?? ""}`,
        sessionLostOnRestore: undefined,
      })),
    };
    expect(hydrationPassMisses(plan, alwaysResumes).resumeSuppressionMisses).toBeGreaterThan(0);

    const neverResumes = {
      ...observed,
      built: observed.built.map((args) => ({
        ...args,
        command: "agent",
        agentSessionId: undefined,
      })),
    };
    expect(hydrationPassMisses(plan, neverResumes).respawnResumeMisses).toBeGreaterThan(0);
  }, 30_000);

  it("scores a deserializer that trusted its untrusted input", async () => {
    const plan = buildHydrationPlan("test", 64, 4);
    const mod = await loadStatePatcherModule();
    const observed = runHydrationPass(mod, plan);

    const trusting = {
      ...observed,
      built: observed.built.map((args, i) => {
        const hostile = plan.panels[i].hostile;
        if (!hostile) return args;
        return {
          ...args,
          browserExpandedPaths: [hostile.safeExpandedPath, ...hostile.droppedExpandedPaths],
        };
      }),
    };
    expect(hydrationPassMisses(plan, trusting).sanitizerMisses).toBeGreaterThan(0);

    // ...and one that dropped everything, which is the cheaper wrong answer.
    const overzealous = {
      ...observed,
      built: observed.built.map((args) =>
        args.browserExpandedPaths ? { ...args, browserExpandedPaths: [] } : args
      ),
    };
    expect(hydrationPassMisses(plan, overzealous).sanitizerMisses).toBeGreaterThan(0);
  }, 30_000);

  it("scores a pass that skipped the orphan-adoption sweep, leaving every other term at zero", async () => {
    const plan = buildHydrationPlan("test", 64, 4);
    const mod = await loadStatePatcherModule();
    const observed = runHydrationPass(mod, plan);
    const misses = hydrationPassMisses(plan, {
      ...observed,
      orphanBuilt: [],
      orphanCount: 0,
    });
    expect(misses.routeCoverageMisses).toBeGreaterThan(0);
    expect(misses.backendRestoreMisses).toBe(0);
  }, 30_000);
});

describe("worktree scope fixture drives the real panel index", () => {
  const plan = buildWorktreeScopePlan("test", 90, 6);

  it("clears every accumulator on a healthy pass", () => {
    expect(worktreeScopeMisses(plan, runWorktreeScopePass(plan))).toEqual({
      indexBuildMisses: 0,
      pendingIndexMisses: 0,
      candidateMisses: 0,
      gridScopeMisses: 0,
      dockScopeMisses: 0,
      mutationMisses: 0,
      referenceStabilityMisses: 0,
      scopeProbeMisses: 0,
    });
  });

  it("keeps the grid worktree-exact and lets globals into the dock", () => {
    const observed = runWorktreeScopePass(plan);
    // The dock holds the grid's panels plus every worktree-less global; if the
    // two were equal the predicate would have collapsed to worktree equality.
    expect(observed.visibleDockPanels).toBeGreaterThan(observed.visiblePanels);
    expect(observed.visiblePanels).toBeGreaterThan(0);
  });

  it("scores a scope predicate that matched everything, and one that matched nothing", () => {
    const observed = runWorktreeScopePass(plan);
    expect(
      worktreeScopeMisses(plan, { ...observed, gridIds: observed.candidateIds }).gridScopeMisses
    ).toBeGreaterThan(0);
    expect(worktreeScopeMisses(plan, { ...observed, gridIds: [] }).gridScopeMisses).toBeGreaterThan(
      0
    );
    expect(worktreeScopeMisses(plan, { ...observed, dockIds: [] }).dockScopeMisses).toBeGreaterThan(
      0
    );
  });

  it("scores a candidate walk that dropped the uncommitted spawn-batch ids (#9649)", () => {
    const observed = runWorktreeScopePass(plan);
    expect(
      worktreeScopeMisses(plan, { ...observed, candidateIds: plan.panelIds }).candidateMisses
    ).toBeGreaterThan(0);
  });

  it("scores an index that rebuilt every bucket, which every membership check would pass", () => {
    const observed = runWorktreeScopePass(plan);
    const misses = worktreeScopeMisses(plan, {
      ...observed,
      churnedBuckets: 5,
      stableBuckets: 0,
    });
    expect(misses.referenceStabilityMisses).toBe(5);
    expect(misses.indexBuildMisses).toBe(0);
    expect(misses.mutationMisses).toBe(0);
  });

  it("scores a probe whose add never happened, which churns no bucket at all", () => {
    // The half the term used to be missing. Deleting `addToWorktreeIndex` from
    // the probe leaves every OTHER bucket holding its original array, so the
    // identity half is perfect — `churnedBuckets` is 0 — while nothing was
    // added. This is what that pass reports.
    const observed = runWorktreeScopePass(plan);
    const misses = worktreeScopeMisses(plan, {
      ...observed,
      churnedBuckets: 0,
      probeIdLanded: false,
      probeBucketGrowth: 0,
      probeBucketReplaced: false,
    });
    expect(misses.referenceStabilityMisses).toBeGreaterThan(0);
    // Every other accumulator stays clean, which is why this one has to speak.
    expect(misses.indexBuildMisses).toBe(0);
    expect(misses.pendingIndexMisses).toBe(0);
    expect(misses.mutationMisses).toBe(0);
    expect(misses.candidateMisses).toBe(0);
  });

  it("scores a bucket mutated in place, which every membership check would pass", () => {
    // A `push` onto the existing array lands the id and grows the bucket, so
    // both of the landing checks are satisfied — and the per-row selector for
    // that worktree never re-fires, because the array is the same reference.
    const observed = runWorktreeScopePass(plan);
    const misses = worktreeScopeMisses(plan, { ...observed, probeBucketReplaced: false });
    expect(misses.referenceStabilityMisses).toBe(1);
  });
});

describe("PERF-010..013 scenario output", () => {
  it("PERF-010 restores every panel through the real builders", async () => {
    const sample = await scenario("PERF-010").run(context);
    const metrics = sample.metrics!;
    expect(metrics.restoredPanels).toBe(120);
    for (const name of scenario("PERF-010").correctness!) {
      expect(metrics[name], name).toBe(0);
    }
  }, 30_000);

  it("PERF-011 merges two real switches and grades every operation", async () => {
    const sample = await scenario("PERF-011").run(context);
    const metrics = sample.metrics!;
    expect(metrics.changedEntries).toBeGreaterThan(0);
    expect(metrics.removedEntries).toBeGreaterThan(0);
    expect(metrics.mergedEntries).toBeGreaterThan(0);
    expect(metrics.payloadBytes).toBeGreaterThan(0);
    for (const name of scenario("PERF-011").correctness!) {
      expect(metrics[name], name).toBe(0);
    }
  }, 30_000);

  it("PERF-012 runs twelve switches", async () => {
    const sample = await scenario("PERF-012").run(context);
    const metrics = sample.metrics!;
    expect(metrics.switchCount).toBe(12);
    for (const name of scenario("PERF-012").correctness!) {
      expect(metrics[name], name).toBe(0);
    }
  }, 30_000);

  it("PERF-013 re-scopes through the real index", async () => {
    const sample = await scenario("PERF-013").run(context);
    const metrics = sample.metrics!;
    expect(metrics.visiblePanels).toBeGreaterThan(0);
    expect(metrics.visibleDockPanels).toBeGreaterThan(metrics.visiblePanels);
    expect(metrics.scopeChecks).toBe(metrics.candidatePanels * 2);
    for (const name of scenario("PERF-013").correctness!) {
      expect(metrics[name], name).toBe(0);
    }
  }, 30_000);

  it("every metric is finite — run.ts throws otherwise", async () => {
    for (const id of ["PERF-010", "PERF-011", "PERF-012", "PERF-013"]) {
      const sample = await scenario(id).run(context);
      expect(Number.isFinite(sample.durationMs), `${id} durationMs`).toBe(true);
      for (const [name, value] of Object.entries(sample.metrics ?? {})) {
        expect(Number.isFinite(value), `${id}.${name} = ${value}`).toBe(true);
      }
    }
  }, 60_000);
});
