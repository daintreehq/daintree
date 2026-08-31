import { performance } from "node:perf_hooks";
import {
  addToWorktreeIndex,
  buildWorktreeIndex,
  collectUngroupedCandidateIds,
  NO_WORKTREE,
  panelMatchesWorktreeScope,
  removeFromWorktreeIndex,
  transferBetweenWorktreeIndex,
  type PanelIdsByWorktreeId,
} from "../../../src/store/slices/panelRegistry/worktreeIndex";

/**
 * The real per-worktree panel index (`src/store/slices/panelRegistry/worktreeIndex.ts`),
 * driven through the sequence a worktree switch runs.
 *
 * This module is a store leaf with one type-only import, so it loads under
 * `tsx` unmodified — the code here is production, not a stand-in. What it
 * decides is what a worktree switch re-scopes: which panels the incoming
 * worktree's grid and dock contain (`panelMatchesWorktreeScope`, the single
 * predicate every render and reorder-commit path shares, #11289), which
 * candidates a group re-derive walks including ids added eagerly during a spawn
 * batch (`collectUngroupedCandidateIds`, #9649), and the index maintenance a
 * move performs.
 *
 * SCOPE LIMIT: no React, so nothing here prices selector re-render or paint.
 * The reference-stability probe below is the closest this can get to the
 * re-render question — the invariant the module documents is that an unrelated
 * worktree's bucket keeps its array identity across a mutation, because a
 * selector that strict-equals a fresh array re-fires on every per-terminal tick.
 * A correct-but-copying implementation passes every membership check and fails
 * that one.
 */

export interface ScopePanel {
  id: string;
  worktreeId: string | undefined;
  location: "grid" | "dock";
}

export interface WorktreeScopePlan {
  label: string;
  panels: ScopePanel[];
  panelIds: string[];
  panelsById: Record<string, { worktreeId?: string | null }>;
  /** Ids the index knows about that `panelIds` has not committed yet (#9649). */
  pending: ScopePanel[];
  targetWorktreeId: string;
  /** Bucket key -> sorted committed ids. The oracle's half of the build check. */
  expectedCommittedBuckets: Record<string, string[]>;
  /** Same, once the pending ids are folded in. */
  expectedPendingBuckets: Record<string, string[]>;
  /** What `collectUngroupedCandidateIds` must return, in order. */
  expectedCandidateIds: string[];
  /** Panels the target worktree's GRID contains: worktree-exact. */
  expectedGridIds: string[];
  /** Panels its DOCK contains: worktree-exact plus the globals. */
  expectedDockIds: string[];
  moves: Array<{ id: string; from: string | undefined; to: string | undefined }>;
  removals: Array<{ id: string; worktreeId: string | undefined }>;
  /** Bucket membership once the moves and removals have been applied. */
  expectedMutatedBuckets: Record<string, string[]>;
  /** The single add used for the reference-stability probe. */
  probe: { id: string; worktreeId: string };
}

function bucketKeyOf(worktreeId: string | undefined): string {
  return worktreeId ?? NO_WORKTREE;
}

function pushInto(buckets: Record<string, string[]>, key: string, id: string): void {
  (buckets[key] ??= []).push(id);
}

/**
 * Build a worktree-scoped layout and every expectation it implies.
 *
 * The expected buckets, candidate list and scope selections are assembled from
 * the panel array directly — no call into `worktreeIndex` — so an index that
 * stopped bucketing, a predicate that matched everything, and a predicate that
 * matched nothing are all visible.
 */
export function buildWorktreeScopePlan(
  label: string,
  panelCount: number,
  worktreeCount: number
): WorktreeScopePlan {
  const panels: ScopePanel[] = [];
  for (let index = 0; index < panelCount; index += 1) {
    // Every ninth panel is global (no worktree). Globals are the interesting
    // case: they belong to every worktree's dock and to no worktree's grid.
    const worktreeId = index % 9 === 0 ? undefined : `wt-${(index % worktreeCount) + 1}`;
    panels.push({
      id: `panel-${index}`,
      worktreeId,
      location: index % 5 === 0 ? "dock" : "grid",
    });
  }

  const panelIds = panels.map((panel) => panel.id);
  const panelsById: Record<string, { worktreeId?: string | null }> = {};
  for (const panel of panels) panelsById[panel.id] = { worktreeId: panel.worktreeId };

  const targetWorktreeId = `wt-${Math.min(5, worktreeCount)}`;

  // Ids the spawn batch registered in the index but has not committed to
  // `panelIds` yet. One lands in the target bucket, one is global, one belongs
  // to a bucket the target's scan must NOT reach.
  const pending: ScopePanel[] = [
    { id: "panel-pending-target", worktreeId: targetWorktreeId, location: "grid" },
    { id: "panel-pending-global", worktreeId: undefined, location: "dock" },
    { id: "panel-pending-other", worktreeId: "wt-1", location: "grid" },
  ];
  for (const panel of pending) panelsById[panel.id] = { worktreeId: panel.worktreeId };

  const expectedCommittedBuckets: Record<string, string[]> = {};
  for (const panel of panels)
    pushInto(expectedCommittedBuckets, bucketKeyOf(panel.worktreeId), panel.id);

  const expectedPendingBuckets: Record<string, string[]> = {};
  for (const [key, ids] of Object.entries(expectedCommittedBuckets)) {
    expectedPendingBuckets[key] = [...ids];
  }
  for (const panel of pending)
    pushInto(expectedPendingBuckets, bucketKeyOf(panel.worktreeId), panel.id);

  // The tail is exactly the pending ids in the target bucket and the global
  // bucket, in that order. `panel-pending-other` sits in `wt-1`, which a scan
  // scoped to the target never opens.
  const expectedCandidateIds = [...panelIds, "panel-pending-target", "panel-pending-global"];
  // `wt-1` IS the target when worktreeCount is 1, and then the third pending id
  // is in scope too.
  if (targetWorktreeId === "wt-1") {
    expectedCandidateIds.splice(panelIds.length + 1, 0, "panel-pending-other");
  }

  const candidateSet = new Set(expectedCandidateIds);
  const expectedGridIds: string[] = [];
  const expectedDockIds: string[] = [];
  for (const panel of [...panels, ...pending]) {
    if (!candidateSet.has(panel.id)) continue;
    // Grid is worktree-exact; the dock also shows worktree-less globals.
    if (panel.worktreeId === targetWorktreeId) {
      expectedGridIds.push(panel.id);
      expectedDockIds.push(panel.id);
    } else if (panel.worktreeId === undefined) {
      expectedDockIds.push(panel.id);
    }
  }

  const moves: Array<{ id: string; from: string | undefined; to: string | undefined }> = [];
  const removals: Array<{ id: string; worktreeId: string | undefined }> = [];
  for (let index = 0; index < panels.length; index += 1) {
    const panel = panels[index];
    if (index % 17 === 4) {
      moves.push({ id: panel.id, from: panel.worktreeId, to: targetWorktreeId });
    } else if (index % 17 === 11) {
      removals.push({ id: panel.id, worktreeId: panel.worktreeId });
    }
  }

  const movedTo = new Map(moves.map((move) => [move.id, move.to]));
  const removed = new Set(removals.map((entry) => entry.id));
  const expectedMutatedBuckets: Record<string, string[]> = {};
  for (const panel of [...panels, ...pending]) {
    if (removed.has(panel.id)) continue;
    const worktreeId = movedTo.has(panel.id) ? movedTo.get(panel.id) : panel.worktreeId;
    pushInto(expectedMutatedBuckets, bucketKeyOf(worktreeId), panel.id);
  }

  return {
    label,
    panels,
    panelIds,
    panelsById,
    pending,
    targetWorktreeId,
    expectedCommittedBuckets,
    expectedPendingBuckets,
    expectedCandidateIds,
    expectedGridIds,
    expectedDockIds,
    moves,
    removals,
    expectedMutatedBuckets,
    probe: { id: "panel-probe", worktreeId: targetWorktreeId },
  };
}

export interface WorktreeScopeObservation {
  /** Wall time of the scope pass alone, oracle excluded. */
  elapsedMs: number;
  /** `panelMatchesWorktreeScope` invocations, counted at the call site. */
  scopeChecks: number;
  builtIndex: PanelIdsByWorktreeId;
  pendingIndex: PanelIdsByWorktreeId;
  candidateIds: string[];
  gridIds: string[];
  dockIds: string[];
  mutatedIndex: PanelIdsByWorktreeId;
  /** Buckets whose array identity survived the probe add, and those that did not. */
  stableBuckets: number;
  churnedBuckets: number;
  /** The probe id is in the bucket the add named. */
  probeIdLanded: boolean;
  /** Entries the probed bucket gained. Exactly one add, so exactly one. */
  probeBucketGrowth: number;
  /** The probed bucket came back as a NEW array, not mutated in place. */
  probeBucketReplaced: boolean;
  /** Panels the target worktree's grid and dock ended up holding. */
  visiblePanels: number;
  visibleDockPanels: number;
}

/** The timed bracket: index rebuild, batch fold, scope selection, maintenance. */
export function runWorktreeScopePass(plan: WorktreeScopePlan): WorktreeScopeObservation {
  let scopeChecks = 0;
  const startedAt = performance.now();

  // 1. Full rebuild — the defensive recovery path after a bulk worktreeId repair.
  const builtIndex = buildWorktreeIndex(plan.panelIds, plan.panelsById);

  // 2. The eager spawn-batch adds that have not reached `panelIds` yet (#9649).
  let pendingIndex = builtIndex;
  for (const panel of plan.pending) {
    pendingIndex = addToWorktreeIndex(pendingIndex, panel.worktreeId, panel.id);
  }

  // 3. The candidate walk a group re-derive performs on the incoming worktree.
  const candidateIds = collectUngroupedCandidateIds(
    plan.panelIds,
    pendingIndex,
    plan.targetWorktreeId
  );

  // 4. The scope predicate, once per candidate per surface.
  const gridIds: string[] = [];
  const dockIds: string[] = [];
  for (const id of candidateIds) {
    const worktreeId = plan.panelsById[id]?.worktreeId ?? undefined;
    scopeChecks += 1;
    if (panelMatchesWorktreeScope(worktreeId, plan.targetWorktreeId, "grid")) gridIds.push(id);
    scopeChecks += 1;
    if (panelMatchesWorktreeScope(worktreeId, plan.targetWorktreeId, "dock")) dockIds.push(id);
  }

  // 5. Index maintenance: moves into the incoming worktree, then closures.
  let mutatedIndex = pendingIndex;
  for (const move of plan.moves) {
    mutatedIndex = transferBetweenWorktreeIndex(mutatedIndex, move.from, move.to, move.id);
  }
  for (const removal of plan.removals) {
    mutatedIndex = removeFromWorktreeIndex(mutatedIndex, removal.worktreeId, removal.id);
  }

  // 6. Reference stability: one add to one bucket must land in that bucket and
  //    leave every other bucket's array identity untouched.
  const before = new Map(Object.entries(mutatedIndex));
  const probedIndex = addToWorktreeIndex(mutatedIndex, plan.probe.worktreeId, plan.probe.id);
  let stableBuckets = 0;
  let churnedBuckets = 0;
  for (const [key, bucket] of before) {
    if (key === plan.probe.worktreeId) continue;
    if (probedIndex[key] === bucket) stableBuckets += 1;
    else churnedBuckets += 1;
  }

  const elapsedMs = performance.now() - startedAt;

  // The other half of the same invariant, read after the clock stops so the
  // membership scan is not priced as index maintenance. Without it the probe
  // graded only the buckets it did NOT touch: deleting the add entirely left
  // every other bucket holding its original array, so `churnedBuckets` stayed
  // 0 and the term passed a pass in which nothing was added at all.
  const probeBucketBefore = before.get(plan.probe.worktreeId) ?? [];
  const probeBucketAfter = probedIndex[plan.probe.worktreeId] ?? [];

  return {
    elapsedMs,
    scopeChecks,
    builtIndex,
    pendingIndex,
    candidateIds,
    gridIds,
    dockIds,
    mutatedIndex,
    stableBuckets,
    churnedBuckets,
    probeIdLanded: probeBucketAfter.includes(plan.probe.id),
    probeBucketGrowth: probeBucketAfter.length - probeBucketBefore.length,
    // An in-place `push` answers every membership question correctly and is the
    // exact regression the stability half exists for, one bucket over.
    probeBucketReplaced: probeBucketAfter !== probeBucketBefore,
    visiblePanels: gridIds.length,
    visibleDockPanels: dockIds.length,
  };
}

export interface WorktreeScopeMisses {
  /** Step 1: `buildWorktreeIndex` bucket membership. */
  indexBuildMisses: number;
  /** Step 2: `addToWorktreeIndex` over the uncommitted batch. */
  pendingIndexMisses: number;
  /** Step 3: `collectUngroupedCandidateIds`, set AND committed-prefix order. */
  candidateMisses: number;
  /** Step 4a: the grid is worktree-exact. */
  gridScopeMisses: number;
  /** Step 4b: the dock also holds the globals. */
  dockScopeMisses: number;
  /** Step 5: `transfer`/`remove` membership after the maintenance pass. */
  mutationMisses: number;
  /** Step 6: the add landed, and the documented bucket-identity invariant held. */
  referenceStabilityMisses: number;
  /** The predicate was consulted once per candidate per surface. */
  scopeProbeMisses: number;
}

function bucketMisses(observed: PanelIdsByWorktreeId, expected: Record<string, string[]>): number {
  let misses = 0;
  const keys = new Set([...Object.keys(observed), ...Object.keys(expected)]);
  for (const key of keys) {
    const observedIds = new Set(observed[key] ?? []);
    const expectedIds = expected[key] ?? [];
    misses += Math.abs((observed[key]?.length ?? 0) - observedIds.size);
    for (const id of expectedIds) if (!observedIds.has(id)) misses += 1;
    for (const id of observedIds) if (!expectedIds.includes(id)) misses += 1;
  }
  return misses;
}

function listMisses(observed: readonly string[], expected: readonly string[]): number {
  const observedSet = new Set(observed);
  const expectedSet = new Set(expected);
  let misses = Math.abs(observed.length - observedSet.size);
  for (const id of expectedSet) if (!observedSet.has(id)) misses += 1;
  for (const id of observedSet) if (!expectedSet.has(id)) misses += 1;
  return misses;
}

export function worktreeScopeMisses(
  plan: WorktreeScopePlan,
  observed: WorktreeScopeObservation
): WorktreeScopeMisses {
  let candidateMisses = listMisses(observed.candidateIds, plan.expectedCandidateIds);
  // The committed ids must still lead, in their committed order — that ordering
  // is what keeps explicit group ordering and drag-reorder correct.
  const prefix = Math.min(plan.panelIds.length, observed.candidateIds.length);
  for (let i = 0; i < prefix; i += 1) {
    if (observed.candidateIds[i] !== plan.panelIds[i]) candidateMisses += 1;
  }

  return {
    indexBuildMisses: bucketMisses(observed.builtIndex, plan.expectedCommittedBuckets),
    pendingIndexMisses: bucketMisses(observed.pendingIndex, plan.expectedPendingBuckets),
    candidateMisses,
    gridScopeMisses: listMisses(observed.gridIds, plan.expectedGridIds),
    dockScopeMisses: listMisses(observed.dockIds, plan.expectedDockIds),
    mutationMisses: bucketMisses(observed.mutatedIndex, plan.expectedMutatedBuckets),
    // Two-sided over one operation. The add must LAND — the probe id present
    // in the bucket it named, that bucket one entry longer and returned as a
    // fresh array — and every other bucket must come back by identity. Only
    // the second half used to be here, so deleting the `addToWorktreeIndex`
    // call outright scored a perfect zero: no add, no churn. A
    // rebuild-everything index still fails the identity half, and an index
    // that stopped adding now fails the landing half.
    referenceStabilityMisses:
      observed.churnedBuckets +
      (observed.probeIdLanded ? 0 : 1) +
      Math.abs(1 - observed.probeBucketGrowth) +
      (observed.probeBucketReplaced ? 0 : 1),
    scopeProbeMisses: Math.abs(observed.candidateIds.length * 2 - observed.scopeChecks),
  };
}
