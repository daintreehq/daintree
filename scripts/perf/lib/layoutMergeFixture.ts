import { performance } from "node:perf_hooks";
import {
  computeIdArrayDelta,
  computeRecordDelta,
  deepEqualIgnoringUndefined,
  mergeIdArray,
  mergeRecord,
  type IdArrayDelta,
} from "../../../shared/utils/layoutMerge";
import { createRng } from "./workloads";

/**
 * The real concurrent-layout merge (`shared/utils/layoutMerge.ts`), driven the
 * way the product drives it on a project switch and on every panel autosave.
 *
 * Two callers, both real:
 * - The renderer's autosave and outgoing-state capture
 *   (`src/store/persistence/panelPersistence.ts`) call `computeIdArrayDelta`
 *   with `deepEqualIgnoringUndefined` and `TERMINAL_TRACKED_FIELDS`, once for
 *   panels and once for tab groups, plus `computeRecordDelta` for draft inputs.
 * - Main's project-switch handler
 *   (`electron/ipc/handlers/projectCrud/switch.ts`, lines 373/391/423) applies
 *   `mergeIdArray` to panels (with the `agentSessionId` field-level authority
 *   rule) and tab groups, and `mergeRecord` to drafts.
 *
 * `deepEqualIgnoringUndefined` is the hot part and the reason this is worth
 * measuring: it recursively key-sorts AND `JSON.stringify`s both sides of every
 * entry that has a baseline, so the cost is O(panels x serialized entry size)
 * on the renderer's main thread at autosave and again at switch time.
 *
 * The module imports nothing renderer-only and nothing from `electron`, so it
 * runs under `tsx` unmodified — this fixture is the production code, not a
 * stand-in for it.
 *
 * SCOPE LIMIT: the IPC hop, `sanitizeTerminals`/`sanitizeTabGroups` (they reach
 * `projectStore` and so the electron-store engine — priced separately by
 * PERF-057), the write queue and the disk write are all outside the bracket.
 * What is inside is the delta computation and the merge, which is the CPU the
 * switch spends on layout reconciliation.
 */

/** Fields Main can author out-of-band. Mirrors `TERMINAL_TRACKED_FIELDS`. */
const TRACKED_FIELDS = ["agentSessionId"] as const;

export interface LayoutEntry {
  id: string;
  kind: string;
  title: string;
  titleMode: string | undefined;
  worktreeId: string | undefined;
  worktreeGitDir: string | undefined;
  location: "grid" | "dock";
  cwd: string;
  createdAt: number;
  command: string | undefined;
  agentState: string | undefined;
  agentSessionId: string | undefined;
  agentLaunchFlags: string[] | undefined;
  agentModelId: string | undefined;
  extensionState: Record<string, unknown> | undefined;
  browserHistory: { entries: string[]; index: number } | undefined;
  lastActiveAt: number | undefined;
}

export interface LayoutGroupEntry {
  id: string;
  tabIds: string[];
  activeTabId: string;
  location: "grid" | "dock";
  worktreeId: string | undefined;
}

/** What one merged entry must be, by id, title and tracked field. */
export interface ExpectedEntry {
  id: string;
  title: string;
  agentSessionId: string | undefined;
}

export interface ExpectedGroup {
  id: string;
  activeTabId: string;
  tabCount: number;
}

const KINDS = ["terminal", "browser", "dev-preview", "file", "file-browser", "diff"] as const;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function makeEntry(index: number, rng: () => number): LayoutEntry {
  const kind = KINDS[index % KINDS.length];
  const worktreeIndex = index % 9;
  const isAgent = kind === "terminal" && index % 3 === 0;
  return {
    id: `panel-${index}`,
    kind,
    title: `${kind} ${index}`,
    // Explicit `undefined` on roughly half the entries. This is the shape the
    // renderer actually diffs (#11350): a JSON round-trip drops the key, the
    // in-memory snapshot keeps it, and a naive comparison flags every such
    // entry as changed on the first save after hydration.
    titleMode: index % 2 === 0 ? undefined : "user",
    worktreeId: worktreeIndex === 0 ? undefined : `wt-${worktreeIndex}`,
    worktreeGitDir: worktreeIndex === 0 ? undefined : `/repo/.git/worktrees/wt-${worktreeIndex}`,
    location: index % 7 === 0 ? "dock" : "grid",
    cwd: `/repo/worktrees/wt-${worktreeIndex}/packages/app`,
    createdAt: 1_700_000_000_000 + index * 137,
    command: isAgent ? `claude --model 'opus' --resume sess-base-${index}` : undefined,
    agentState: isAgent ? "idle" : undefined,
    agentSessionId: isAgent ? `sess-base-${index}` : undefined,
    agentLaunchFlags: isAgent ? ["--model", "opus", "--dangerously-skip-permissions"] : undefined,
    agentModelId: isAgent ? "opus" : undefined,
    // Nested payload, because canonicalizeForJson recurses and key-sorts. A
    // flat entry would price a fraction of the real comparison.
    extensionState:
      kind === "file-browser"
        ? {
            browserRootPath: `packages/app/src`,
            browserExpandedPaths: [`packages`, `packages/app`, `packages/app/src`],
            browserSortKey: rng() > 0.5 ? "modified" : undefined,
            browserSidebarWidth: 280,
            browserTreeSnapshot: {
              rootPath: "packages/app/src",
              listings: [
                { path: "packages/app/src", entries: ["index.ts", "store", "utils"] },
                { path: "packages/app/src/store", entries: ["panelStore.ts"] },
              ],
            },
          }
        : undefined,
    browserHistory:
      kind === "browser" || kind === "dev-preview"
        ? {
            entries: [
              `http://localhost:${3000 + (index % 20)}/`,
              `http://localhost:${3000 + (index % 20)}/settings`,
            ],
            index: 1,
          }
        : undefined,
    lastActiveAt: index % 4 === 0 ? 1_700_000_500_000 + index : undefined,
  };
}

/**
 * Which mutation each index carries. Fixed by arithmetic on the index rather
 * than sampled, so every expectation below is derivable without consulting the
 * subject.
 */
type Role =
  | "untouched"
  | "writerChanged"
  | "writerFieldClaim"
  | "writerAmbient"
  | "siblingChanged"
  | "writerRemoved"
  | "siblingRemoved";

function roleFor(index: number, entry: LayoutEntry): Role {
  const slot = index % 11;
  // The two session-id roles only make sense on an entry that carries one.
  const hasSession = entry.agentSessionId !== undefined;
  if (slot === 3) return hasSession ? "writerFieldClaim" : "writerChanged";
  if (slot === 5) return hasSession ? "writerAmbient" : "untouched";
  if (slot === 1) return "writerChanged";
  if (slot === 7) return "siblingChanged";
  if (slot === 9) return "writerRemoved";
  if (slot === 10) return "siblingRemoved";
  return "untouched";
}

export interface LayoutMergePlan {
  label: string;
  panelCount: number;

  baselineTerminals: LayoutEntry[];
  onDiskTerminals: LayoutEntry[];
  writerTerminals: LayoutEntry[];
  /** A deep clone of `writerTerminals` — the identical-re-delta probe. */
  identicalTerminals: LayoutEntry[];
  /** `writerTerminals` with exactly one entry's title changed. */
  singleChangeTerminals: LayoutEntry[];

  expectedTerminalChangedIds: string[];
  expectedTerminalRemovedIds: string[];
  expectedFieldEditIds: string[];
  expectedMergedTerminals: ExpectedEntry[];

  baselineGroups: LayoutGroupEntry[];
  onDiskGroups: LayoutGroupEntry[];
  writerGroups: LayoutGroupEntry[];
  expectedGroupChangedIds: string[];
  expectedGroupRemovedIds: string[];
  expectedMergedGroups: ExpectedGroup[];

  onDiskDrafts: Record<string, string>;
  writerDrafts: Record<string, string>;
  baselineDrafts: Record<string, string>;
  expectedDraftChangedIds: string[];
  expectedDraftRemovedIds: string[];
  expectedMergedDrafts: Record<string, string>;
}

/**
 * Build one switch's worth of concurrent-window state, plus every expectation,
 * from the mutation plan alone.
 *
 * Nothing here calls `computeIdArrayDelta`, `mergeIdArray`, `computeRecordDelta`
 * or `mergeRecord`: the expected delta and the expected merged array are
 * assembled from the roles assigned above, which is what makes them an oracle
 * rather than a second opinion from the subject.
 */
export function buildLayoutMergePlan(
  label: string,
  panelCount: number,
  seed: number
): LayoutMergePlan {
  const rng = createRng(seed);
  const baselineTerminals: LayoutEntry[] = [];
  for (let index = 0; index < panelCount; index += 1) {
    baselineTerminals.push(makeEntry(index, rng));
  }

  const roles = new Map<string, Role>();
  baselineTerminals.forEach((entry, index) => roles.set(entry.id, roleFor(index, entry)));

  const onDiskTerminals: LayoutEntry[] = [];
  const writerTerminals: LayoutEntry[] = [];
  const expectedTerminalChangedIds: string[] = [];
  const expectedTerminalRemovedIds: string[] = [];
  const expectedFieldEditIds: string[] = [];
  const onDiskById = new Map<string, LayoutEntry>();
  const writerById = new Map<string, LayoutEntry>();

  for (const base of baselineTerminals) {
    const role = roles.get(base.id)!;
    const onDisk = clone(base);
    const writer = clone(base);

    switch (role) {
      case "writerChanged":
        writer.title = `${base.title} (moved)`;
        writer.location = base.location === "dock" ? "grid" : "dock";
        expectedTerminalChangedIds.push(base.id);
        break;
      case "writerFieldClaim":
        // The writer genuinely re-authored the tracked field, so it claims it.
        writer.agentSessionId = `sess-writer-${base.id}`;
        expectedTerminalChangedIds.push(base.id);
        expectedFieldEditIds.push(base.id);
        break;
      case "writerAmbient":
        // The #11461 shape: an ambient field moved, so the entry reads as
        // changed, but the writer never touched `agentSessionId` and is
        // carrying a stale copy of the one Main authored on disk.
        writer.agentState = "working";
        onDisk.agentSessionId = `sess-main-${base.id}`;
        expectedTerminalChangedIds.push(base.id);
        break;
      case "siblingChanged":
        onDisk.title = `${base.title} (sibling)`;
        onDisk.lastActiveAt = 1_700_100_000_000;
        break;
      case "writerRemoved":
        expectedTerminalRemovedIds.push(base.id);
        break;
      case "siblingRemoved":
        break;
      case "untouched":
        break;
    }

    if (role !== "siblingRemoved") {
      onDiskTerminals.push(onDisk);
      onDiskById.set(onDisk.id, onDisk);
    }
    if (role !== "writerRemoved") {
      writerTerminals.push(writer);
      writerById.set(writer.id, writer);
    }
  }

  // Additions on both sides. The writer's are entries Main has never seen; the
  // sibling's are entries the writer has never seen and must not delete.
  const addCount = Math.max(2, Math.round(panelCount * 0.05));
  const siblingAddedIds: string[] = [];
  for (let i = 0; i < addCount; i += 1) {
    const writerAdd = makeEntry(panelCount + i, rng);
    writerAdd.id = `panel-writer-add-${i}`;
    writerTerminals.push(writerAdd);
    writerById.set(writerAdd.id, writerAdd);
    expectedTerminalChangedIds.push(writerAdd.id);

    const siblingAdd = makeEntry(panelCount + addCount + i, rng);
    siblingAdd.id = `panel-sibling-add-${i}`;
    onDiskTerminals.push(siblingAdd);
    onDiskById.set(siblingAdd.id, siblingAdd);
    siblingAddedIds.push(siblingAdd.id);
  }

  const changedSet = new Set(expectedTerminalChangedIds);
  const claimedSet = new Set(expectedFieldEditIds);
  const expectedMergedTerminals: ExpectedEntry[] = [];
  for (const writer of writerTerminals) {
    const onDisk = onDiskById.get(writer.id);
    if (changedSet.has(writer.id)) {
      expectedMergedTerminals.push({
        id: writer.id,
        title: writer.title,
        // Field authority: the writer's value only when it claimed the field,
        // otherwise whatever is on disk. With no on-disk row there is nothing
        // to defer to.
        agentSessionId:
          onDisk === undefined || claimedSet.has(writer.id)
            ? writer.agentSessionId
            : onDisk.agentSessionId,
      });
      continue;
    }
    // Untouched by the writer: the on-disk row stands, and a row a sibling
    // deleted is not resurrected.
    if (onDisk !== undefined) {
      expectedMergedTerminals.push({
        id: onDisk.id,
        title: onDisk.title,
        agentSessionId: onDisk.agentSessionId,
      });
    }
  }
  for (const id of siblingAddedIds) {
    const onDisk = onDiskById.get(id)!;
    expectedMergedTerminals.push({
      id,
      title: onDisk.title,
      agentSessionId: onDisk.agentSessionId,
    });
  }

  const identicalTerminals = clone(writerTerminals);
  const singleChangeTerminals = clone(writerTerminals);
  const singleChangeIndex = Math.floor(singleChangeTerminals.length / 2);
  singleChangeTerminals[singleChangeIndex].title =
    `${singleChangeTerminals[singleChangeIndex].title} (one edit)`;

  // --- Tab groups -----------------------------------------------------------

  const groupSize = 4;
  const baselineGroups: LayoutGroupEntry[] = [];
  for (let start = 0; start < baselineTerminals.length; start += groupSize) {
    const slice = baselineTerminals.slice(start, start + groupSize);
    if (slice.length === 0) continue;
    baselineGroups.push({
      id: `group-${baselineGroups.length}`,
      tabIds: slice.map((entry) => entry.id),
      activeTabId: slice[slice.length - 1].id,
      location: "grid",
      worktreeId: slice[0].worktreeId,
    });
  }

  const onDiskGroups: LayoutGroupEntry[] = [];
  const writerGroups: LayoutGroupEntry[] = [];
  const expectedGroupChangedIds: string[] = [];
  const expectedGroupRemovedIds: string[] = [];
  const onDiskGroupById = new Map<string, LayoutGroupEntry>();
  const siblingAddedGroupIds: string[] = [];

  baselineGroups.forEach((base, index) => {
    const onDisk = clone(base);
    const writer = clone(base);
    const slot = index % 6;
    if (slot === 1) {
      writer.activeTabId = writer.tabIds[0];
      expectedGroupChangedIds.push(base.id);
    } else if (slot === 3) {
      onDisk.activeTabId = onDisk.tabIds[0];
      onDisk.tabIds = onDisk.tabIds.slice(0, Math.max(1, onDisk.tabIds.length - 1));
    } else if (slot === 5) {
      expectedGroupRemovedIds.push(base.id);
    }
    onDiskGroups.push(onDisk);
    onDiskGroupById.set(onDisk.id, onDisk);
    if (slot !== 5) writerGroups.push(writer);
  });

  const writerAddedGroup: LayoutGroupEntry = {
    id: "group-writer-add",
    tabIds: [`panel-writer-add-0`],
    activeTabId: `panel-writer-add-0`,
    location: "grid",
    worktreeId: "wt-1",
  };
  writerGroups.push(writerAddedGroup);
  expectedGroupChangedIds.push(writerAddedGroup.id);

  const siblingAddedGroup: LayoutGroupEntry = {
    id: "group-sibling-add",
    tabIds: [`panel-sibling-add-0`],
    activeTabId: `panel-sibling-add-0`,
    location: "dock",
    worktreeId: "wt-2",
  };
  onDiskGroups.push(siblingAddedGroup);
  onDiskGroupById.set(siblingAddedGroup.id, siblingAddedGroup);
  siblingAddedGroupIds.push(siblingAddedGroup.id);

  const groupChangedSet = new Set(expectedGroupChangedIds);
  const expectedMergedGroups: ExpectedGroup[] = [];
  for (const writer of writerGroups) {
    const onDisk = onDiskGroupById.get(writer.id);
    if (groupChangedSet.has(writer.id)) {
      expectedMergedGroups.push({
        id: writer.id,
        activeTabId: writer.activeTabId,
        tabCount: writer.tabIds.length,
      });
    } else if (onDisk !== undefined) {
      expectedMergedGroups.push({
        id: onDisk.id,
        activeTabId: onDisk.activeTabId,
        tabCount: onDisk.tabIds.length,
      });
    }
  }
  for (const id of siblingAddedGroupIds) {
    const onDisk = onDiskGroupById.get(id)!;
    expectedMergedGroups.push({
      id,
      activeTabId: onDisk.activeTabId,
      tabCount: onDisk.tabIds.length,
    });
  }
  // --- Draft inputs ---------------------------------------------------------

  const baselineDrafts: Record<string, string> = {};
  const onDiskDrafts: Record<string, string> = {};
  const writerDrafts: Record<string, string> = {};
  const expectedDraftChangedIds: string[] = [];
  const expectedDraftRemovedIds: string[] = [];
  const expectedMergedDrafts: Record<string, string> = {};

  baselineTerminals.forEach((entry, index) => {
    if (index % 3 !== 0) return;
    const text = `draft for ${entry.id}: ${"the quick brown fox ".repeat(3)}`;
    baselineDrafts[entry.id] = text;
    onDiskDrafts[entry.id] = text;
    if (index % 9 === 0) {
      writerDrafts[entry.id] = `${text} (edited)`;
      expectedDraftChangedIds.push(entry.id);
      expectedMergedDrafts[entry.id] = `${text} (edited)`;
    } else if (index % 9 === 3) {
      // Cleared by the writer — only derivable as a tombstone from the baseline.
      expectedDraftRemovedIds.push(entry.id);
    } else {
      writerDrafts[entry.id] = text;
      expectedMergedDrafts[entry.id] = text;
    }
  });
  // A sibling window's draft the writer never knew: it must survive.
  onDiskDrafts["panel-sibling-add-0"] = "sibling draft text";
  expectedMergedDrafts["panel-sibling-add-0"] = "sibling draft text";

  return {
    label,
    panelCount,
    baselineTerminals,
    onDiskTerminals,
    writerTerminals,
    identicalTerminals,
    singleChangeTerminals,
    expectedTerminalChangedIds,
    expectedTerminalRemovedIds,
    expectedFieldEditIds,
    expectedMergedTerminals,
    baselineGroups,
    onDiskGroups,
    writerGroups,
    expectedGroupChangedIds,
    expectedGroupRemovedIds,
    expectedMergedGroups,
    baselineDrafts,
    onDiskDrafts,
    writerDrafts,
    expectedDraftChangedIds,
    expectedDraftRemovedIds,
    expectedMergedDrafts,
  };
}

export interface LayoutMergeObservation {
  /** Wall time of the merge pipeline alone, oracle excluded. */
  elapsedMs: number;
  /** Renderer side: the three deltas plus the outgoing payload (steps 1-4). */
  captureMs: number;
  /** Main side: the two array merges and the record merge (steps 5-7). */
  mergeMs: number;
  /** The null and unit correctness probes (steps 8-9), timed separately so a
   *  scenario can report switch cost without its own oracle inside it. */
  probeMs: number;
  /** Serialized size of the payload the switch would put on the wire. */
  payloadBytes: number;
  /** `deepEqualIgnoringUndefined` invocations, counted at the call site. */
  deepEqualCalls: number;
  terminalDelta: IdArrayDelta;
  groupDelta: IdArrayDelta;
  draftDelta: IdArrayDelta;
  mergedTerminals: LayoutEntry[];
  mergedGroups: LayoutGroupEntry[];
  mergedDrafts: Record<string, string>;
  identicalDelta: IdArrayDelta;
  identicalMerged: LayoutEntry[];
  singleChangeDelta: IdArrayDelta;
}

/**
 * The timed bracket: the exact call sequence a project switch runs, in order.
 *
 * `deepEqualIgnoringUndefined` is wrapped only to count invocations at the call
 * site — the wrapper forwards to the real export and adds no comparison of its
 * own, so the equality decision is entirely the product's.
 */
export function runLayoutMergePass(plan: LayoutMergePlan): LayoutMergeObservation {
  let deepEqualCalls = 0;
  const countingEquals = <T>(a: T, b: T): boolean => {
    deepEqualCalls += 1;
    return deepEqualIgnoringUndefined(a, b);
  };

  const startedAt = performance.now();

  // 1. Renderer: the outgoing panel delta against its last-acknowledged baseline.
  const terminalDelta = computeIdArrayDelta(
    plan.baselineTerminals,
    plan.writerTerminals,
    countingEquals,
    TRACKED_FIELDS
  );
  // 2. Renderer: the tab-group delta (no tracked fields).
  const groupDelta = computeIdArrayDelta(plan.baselineGroups, plan.writerGroups, countingEquals);
  // 3. Renderer: the draft-input delta (plain string comparison).
  const draftDelta = computeRecordDelta(plan.baselineDrafts, plan.writerDrafts);
  // 4. The IPC payload the switch actually serializes alongside the delta.
  const payloadBytes = JSON.stringify({
    terminals: plan.writerTerminals,
    tabGroups: plan.writerGroups,
    draftInputs: plan.writerDrafts,
    terminalDelta,
    tabGroupDelta: groupDelta,
  }).length;
  const captureMs = performance.now() - startedAt;

  const mergeStartedAt = performance.now();
  // 5. Main: merge panels with the field-level authority rule (#11461).
  const mergedTerminals = mergeIdArray(
    plan.onDiskTerminals,
    plan.writerTerminals,
    terminalDelta.changedIds,
    terminalDelta.removedIds,
    { fieldLevelMerge: TRACKED_FIELDS, fieldEdits: terminalDelta.fieldEdits }
  );
  // 6. Main: merge tab groups.
  const mergedGroups = mergeIdArray(
    plan.onDiskGroups,
    plan.writerGroups,
    groupDelta.changedIds,
    groupDelta.removedIds
  );
  // 7. Main: merge draft inputs.
  const mergedDrafts = mergeRecord(
    plan.onDiskDrafts,
    plan.writerDrafts,
    draftDelta.changedIds,
    draftDelta.removedIds
  );
  const mergeMs = performance.now() - mergeStartedAt;

  const probeStartedAt = performance.now();
  // 8. The null case: a re-save of a structurally identical array must claim
  //    nothing, and merging that empty claim must leave the on-disk array
  //    exactly as it was. Distinct objects on both sides, so the full
  //    canonicalize-and-stringify path runs rather than the identity shortcut.
  const identicalDelta = computeIdArrayDelta(
    plan.writerTerminals,
    plan.identicalTerminals,
    countingEquals,
    TRACKED_FIELDS
  );
  const identicalMerged = mergeIdArray(
    mergedTerminals,
    plan.identicalTerminals,
    identicalDelta.changedIds,
    identicalDelta.removedIds,
    { fieldLevelMerge: TRACKED_FIELDS, fieldEdits: identicalDelta.fieldEdits }
  );
  // 9. The unit case: exactly one field moved on exactly one entry.
  const singleChangeDelta = computeIdArrayDelta(
    plan.writerTerminals,
    plan.singleChangeTerminals,
    countingEquals,
    TRACKED_FIELDS
  );

  const probeMs = performance.now() - probeStartedAt;
  const elapsedMs = performance.now() - startedAt;

  return {
    elapsedMs,
    captureMs,
    mergeMs,
    probeMs,
    payloadBytes,
    deepEqualCalls,
    terminalDelta,
    groupDelta,
    draftDelta,
    mergedTerminals,
    mergedGroups,
    mergedDrafts,
    identicalDelta,
    identicalMerged,
    singleChangeDelta,
  };
}

/**
 * One miss accumulator per operation in the bracket.
 *
 * Deliberately not a single total. An aggregate cannot see a deleted term: drop
 * the tab-group merge and a summed predicate still reads 0 because the panel
 * terms carry it. Each field below covers exactly one call in
 * `runLayoutMergePass`, so removing any one of the nine steps moves exactly one
 * of these off zero.
 */
export interface LayoutMergeMisses {
  /** Step 1: the panel delta's changed/removed/fieldEdit id sets. */
  terminalDeltaMisses: number;
  /** Step 2: the tab-group delta's id sets. */
  tabGroupDeltaMisses: number;
  /** Step 3: the draft delta's id sets, tombstones included. */
  draftDeltaMisses: number;
  /** Step 4: the serialized outgoing payload. */
  payloadMisses: number;
  /** Step 5: merged panels, by id order and by value. */
  terminalMergeMisses: number;
  /** Step 6: merged tab groups, by id order and by value. */
  tabGroupMergeMisses: number;
  /** Step 7: merged drafts, by key and by value. */
  draftMergeMisses: number;
  /** Step 8: the identical-re-save null case, delta and merge. */
  identicalPassMisses: number;
  /** Step 9: the one-field unit case. */
  singleChangeMisses: number;
  /** The equality function was actually consulted per entry. */
  equalityProbeMisses: number;
}

function setDifferenceCount(observed: readonly string[], expected: readonly string[]): number {
  const observedSet = new Set(observed);
  const expectedSet = new Set(expected);
  let misses = 0;
  for (const id of observedSet) if (!expectedSet.has(id)) misses += 1;
  for (const id of expectedSet) if (!observedSet.has(id)) misses += 1;
  // A duplicated id is neither an extra nor a missing one; count the surplus.
  misses += Math.abs(observed.length - observedSet.size);
  return misses;
}

/**
 * Grade one pass against the plan's own arithmetic.
 *
 * Every expectation comes from `buildLayoutMergePlan`, which never calls the
 * subject. A merge that returned its input untouched, a delta that reported
 * everything changed, and a delta that reported nothing changed all score here
 * — the sets are compared by symmetric difference, so both directions are
 * caught rather than only the under-reporting one.
 */
export function layoutMergeMisses(
  plan: LayoutMergePlan,
  observed: LayoutMergeObservation
): LayoutMergeMisses {
  const terminalDeltaMisses =
    setDifferenceCount(observed.terminalDelta.changedIds, plan.expectedTerminalChangedIds) +
    setDifferenceCount(observed.terminalDelta.removedIds, plan.expectedTerminalRemovedIds) +
    setDifferenceCount(
      (observed.terminalDelta.fieldEdits ?? []).map((edit) => edit.id),
      plan.expectedFieldEditIds
    ) +
    // Every claim must name the tracked field and nothing else.
    (observed.terminalDelta.fieldEdits ?? []).filter(
      (edit) => edit.fields.length !== 1 || edit.fields[0] !== "agentSessionId"
    ).length;

  const tabGroupDeltaMisses =
    setDifferenceCount(observed.groupDelta.changedIds, plan.expectedGroupChangedIds) +
    setDifferenceCount(observed.groupDelta.removedIds, plan.expectedGroupRemovedIds);

  const draftDeltaMisses =
    setDifferenceCount(observed.draftDelta.changedIds, plan.expectedDraftChangedIds) +
    setDifferenceCount(observed.draftDelta.removedIds, plan.expectedDraftRemovedIds);

  // A floor derived from the plan, not from the payload: every writer entry
  // serializes to well over 100 bytes, so a capture that stopped serializing
  // most of the array cannot clear this.
  const payloadMisses = observed.payloadBytes >= plan.writerTerminals.length * 100 ? 0 : 1;

  let terminalMergeMisses = Math.abs(
    plan.expectedMergedTerminals.length - observed.mergedTerminals.length
  );
  const mergedLength = Math.min(
    plan.expectedMergedTerminals.length,
    observed.mergedTerminals.length
  );
  for (let i = 0; i < mergedLength; i += 1) {
    const expected = plan.expectedMergedTerminals[i];
    const actual = observed.mergedTerminals[i];
    if (actual.id !== expected.id) terminalMergeMisses += 1;
    if (actual.title !== expected.title) terminalMergeMisses += 1;
    if (actual.agentSessionId !== expected.agentSessionId) terminalMergeMisses += 1;
  }

  let tabGroupMergeMisses = Math.abs(
    plan.expectedMergedGroups.length - observed.mergedGroups.length
  );
  const groupLength = Math.min(plan.expectedMergedGroups.length, observed.mergedGroups.length);
  for (let i = 0; i < groupLength; i += 1) {
    const expected = plan.expectedMergedGroups[i];
    const actual = observed.mergedGroups[i];
    if (actual.id !== expected.id) tabGroupMergeMisses += 1;
    if (actual.activeTabId !== expected.activeTabId) tabGroupMergeMisses += 1;
    if (actual.tabIds.length !== expected.tabCount) tabGroupMergeMisses += 1;
  }

  let draftMergeMisses = 0;
  const observedDraftKeys = Object.keys(observed.mergedDrafts);
  const expectedDraftKeys = Object.keys(plan.expectedMergedDrafts);
  draftMergeMisses += setDifferenceCount(observedDraftKeys, expectedDraftKeys);
  for (const key of expectedDraftKeys) {
    if (observed.mergedDrafts[key] !== plan.expectedMergedDrafts[key]) draftMergeMisses += 1;
  }

  // Re-saving a structurally identical array must claim nothing, and applying
  // that empty claim must leave the on-disk array byte-for-byte where it was.
  let identicalPassMisses =
    observed.identicalDelta.changedIds.length +
    observed.identicalDelta.removedIds.length +
    (observed.identicalDelta.fieldEdits?.length ?? 0) +
    Math.abs(observed.mergedTerminals.length - observed.identicalMerged.length);
  const identicalLength = Math.min(
    observed.mergedTerminals.length,
    observed.identicalMerged.length
  );
  for (let i = 0; i < identicalLength; i += 1) {
    if (observed.identicalMerged[i].id !== observed.mergedTerminals[i].id) {
      identicalPassMisses += 1;
    }
  }

  const singleChangeMisses =
    Math.abs(1 - observed.singleChangeDelta.changedIds.length) +
    observed.singleChangeDelta.removedIds.length +
    (observed.singleChangeDelta.fieldEdits?.length ?? 0);

  // The three deltas that take an `equals` must have consulted it once per
  // entry that has a baseline. A delta that stopped comparing — returning every
  // id, or none — is already caught above, but this catches the narrower case
  // where the comparison is skipped for a subset and the remaining ids happen
  // to agree.
  const baselineTerminalIds = new Set(plan.baselineTerminals.map((entry) => entry.id));
  const baselineGroupIds = new Set(plan.baselineGroups.map((group) => group.id));
  const writerTerminalIds = new Set(plan.writerTerminals.map((entry) => entry.id));
  const expectedEqualityCalls =
    plan.writerTerminals.filter((entry) => baselineTerminalIds.has(entry.id)).length +
    plan.writerGroups.filter((group) => baselineGroupIds.has(group.id)).length +
    plan.identicalTerminals.filter((entry) => writerTerminalIds.has(entry.id)).length +
    plan.singleChangeTerminals.filter((entry) => writerTerminalIds.has(entry.id)).length;
  const equalityProbeMisses = Math.abs(expectedEqualityCalls - observed.deepEqualCalls);

  return {
    terminalDeltaMisses,
    tabGroupDeltaMisses,
    draftDeltaMisses,
    payloadMisses,
    terminalMergeMisses,
    tabGroupMergeMisses,
    draftMergeMisses,
    identicalPassMisses,
    singleChangeMisses,
    equalityProbeMisses,
  };
}

/** Sum two miss records field-by-field, for scenarios that run several passes. */
export function addLayoutMergeMisses(
  left: LayoutMergeMisses,
  right: LayoutMergeMisses
): LayoutMergeMisses {
  return {
    terminalDeltaMisses: left.terminalDeltaMisses + right.terminalDeltaMisses,
    tabGroupDeltaMisses: left.tabGroupDeltaMisses + right.tabGroupDeltaMisses,
    draftDeltaMisses: left.draftDeltaMisses + right.draftDeltaMisses,
    payloadMisses: left.payloadMisses + right.payloadMisses,
    terminalMergeMisses: left.terminalMergeMisses + right.terminalMergeMisses,
    tabGroupMergeMisses: left.tabGroupMergeMisses + right.tabGroupMergeMisses,
    draftMergeMisses: left.draftMergeMisses + right.draftMergeMisses,
    identicalPassMisses: left.identicalPassMisses + right.identicalPassMisses,
    singleChangeMisses: left.singleChangeMisses + right.singleChangeMisses,
    equalityProbeMisses: left.equalityProbeMisses + right.equalityProbeMisses,
  };
}

export function zeroLayoutMergeMisses(): LayoutMergeMisses {
  return {
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
  };
}
