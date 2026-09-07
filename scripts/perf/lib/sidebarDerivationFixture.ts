import { performance } from "node:perf_hooks";
import {
  computeChipCounts as realComputeChipCounts,
  groupByType as realGroupByType,
  matchesFilters as realMatchesFilters,
  sortWorktreesByRelevance as realSortWorktreesByRelevance,
  type ChipCounts,
  type DerivedWorktreeMeta,
  type FilterState,
  type GroupedSection,
  type WorktreeTypeId,
} from "../../../src/lib/worktreeFilters";
import type {
  ActivityFilter,
  DevServerFilter,
  OrderBy,
  PrIssueFilter,
  SessionFilter,
  StatusFilter,
  TypeFilter,
} from "../../../src/store/worktreeFilterStore";
import type {
  DevPreviewSessionState,
  DevPreviewSessionStatus,
} from "../../../shared/types/ipc/devPreview";
import type { NormalizedPRState } from "../../../shared/types/forge";
import type { WorktreeState } from "../../../shared/types/worktree";

/**
 * Fixture + oracle for the sidebar list-derivation scenarios (PERF-400..402).
 *
 * `SidebarContent` re-runs FOUR pure functions over the whole worktree set on
 * every render and every filter keystroke — `matchesFilters` (once per row),
 * `sortWorktreesByRelevance`, `groupByType`, and `computeChipCounts` (which is
 * itself six more full `matchesFilters` sweeps, one per facet group). PERF-140
 * and PERF-141 cover the STORE apply that feeds this; nothing covered the
 * derivation itself.
 *
 * All four are pure and import nothing renderer-only, so they load with a plain
 * import under tsx — no esbuild bundle, no stubs.
 *
 * ## How the oracle avoids grading itself
 *
 * Nothing here calls a `worktreeFilters` export to work out what the answer
 * should be. The generator DECIDES each row's facts — its branch type, whether
 * it is dirty, which activity windows it falls in, which dev-server chips it
 * owns, how well it answers the search query — and increments the expected
 * tallies at the point it plants them. The expectation is therefore fixture
 * arithmetic over plant records, and a subject reduced to a no-op cannot
 * satisfy it.
 *
 * The query is the mechanism that makes "which rows should survive" knowable
 * without scoring anything: {@link SIDEBAR_NEEDLE} starts with a character that
 * appears NOWHERE else in the generated corpus, so every prefix of it matches
 * exactly the rows the generator planted it into, and nothing else.
 *
 * ## What the timed bracket contains
 *
 * {@link runDerivationSweep} is what the scenarios wrap in `performance.now()`,
 * and it calls the four subjects and appends what they returned. Corpus
 * construction ({@link getSidebarDerivationFixture}), step construction
 * ({@link buildStepMatrix}, which resolves each step's query and `FilterState`)
 * and every oracle ({@link gradeDerivationSweep}) run outside it. The
 * observation a pass records holds REFERENCES to the arrays the subjects
 * returned, so recording is a pointer store rather than a copy, and the id lists
 * the predicates compare are projected out of them once the clock has stopped.
 *
 * ## Scope limits
 *
 * `SidebarContent` also applies a quick-state filter and two always-show
 * bypasses (active row, waiting agent) around `matchesFilters`. Those live in
 * the component, not in `worktreeFilters`, and are deliberately out of the
 * bracket — these scenarios price the four shared derivation functions, not the
 * component's own branching. `groupByType` is called only on the passes where
 * the component would call it (grouped mode is skipped while a query is
 * active), so a query step grades three operations and a browse step grades
 * four.
 */

/**
 * The planted search token.
 *
 * `z` is the load-bearing character: no other string this generator emits — no
 * name, branch, issue title or PR title — contains one, so EVERY prefix of this
 * needle selects exactly the rows it was planted into. That is what lets
 * `expectedKeptCount` be arithmetic over plant records instead of a second
 * implementation of the scorer.
 */
export const SIDEBAR_NEEDLE = "zqvkw";

/** Words used for names and titles. Chosen for containing no `z`. */
const WORDS = [
  "alpha",
  "beta",
  "gamma",
  "delta",
  "epsilon",
  "kappa",
  "lambda",
  "omicron",
  "sigma",
  "theta",
] as const;

/** Branch prefixes that `BRANCH_PREFIX_MAP` resolves, in plant order. */
const TYPED_PREFIXES: ReadonlyArray<{ prefix: string; typeId: WorktreeTypeId }> = [
  { prefix: "feature", typeId: "feature" },
  { prefix: "bugfix", typeId: "bugfix" },
  { prefix: "refactor", typeId: "refactor" },
  { prefix: "chore", typeId: "chore" },
  { prefix: "docs", typeId: "docs" },
  { prefix: "test", typeId: "test" },
  { prefix: "release", typeId: "release" },
  { prefix: "ci", typeId: "ci" },
  { prefix: "deps", typeId: "deps" },
  { prefix: "perf", typeId: "perf" },
  { prefix: "style", typeId: "style" },
  { prefix: "wip", typeId: "wip" },
];

/** A prefix `BRANCH_PREFIX_MAP` does NOT resolve, so the row lands in "other". */
const UNTYPED_PREFIX = "sandbox";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Activity ages, deliberately far from every window edge. The subject reads
 * `Date.now()` at call time and the fixture stamps timestamps at build time, so
 * a few seconds of drift must not be able to move a row between buckets.
 */
const ACTIVITY_AGES_MS = [5 * MINUTE_MS, 45 * MINUTE_MS, 6 * HOUR_MS, 3 * DAY_MS, 20 * DAY_MS];

const ACTIVITY_WINDOWS: ReadonlyArray<{ key: ActivityFilter; windowMs: number }> = [
  { key: "last15m", windowMs: 15 * MINUTE_MS },
  { key: "last1h", windowMs: HOUR_MS },
  { key: "last24h", windowMs: DAY_MS },
  { key: "last7d", windowMs: 7 * DAY_MS },
];

const PR_STATES: readonly NormalizedPRState[] = ["open", "merged", "closed", "declined"];

const DEV_STATUSES: readonly DevPreviewSessionStatus[] = [
  "running",
  "starting",
  "error",
  "stopped",
];

/** How well a row answers a needle prefix, planted rather than scored. */
const RELEVANCE_NAME_PREFIX = 4;
const RELEVANCE_NAME_SUBSTRING = 3;
const RELEVANCE_BRANCH_ONLY = 1;
const RELEVANCE_NONE = 0;

/**
 * One generated row plus every fact the oracle needs about it.
 *
 * Each chip-key array is filled by the generator at the moment it decides the
 * underlying fact, so a tally is never a literal — it is a sum over decisions
 * that were actually made.
 */
export interface PlantedWorktree {
  readonly worktree: WorktreeState;
  readonly meta: DerivedWorktreeMeta;
  readonly session: DevPreviewSessionState | null;
  readonly typeId: WorktreeTypeId;
  readonly isExternal: boolean;
  readonly pinIndex: number;
  readonly createdAt: number;
  /** 0 when the needle was not planted in this row at all. */
  readonly relevance: number;
  readonly statusKeys: readonly StatusFilter[];
  readonly prIssueKeys: readonly PrIssueFilter[];
  readonly sessionKeys: readonly SessionFilter[];
  readonly activityKeys: readonly ActivityFilter[];
  readonly devServerKeys: readonly DevServerFilter[];
  /** Facet facts the declared filter levels below are written against. */
  readonly isDirty: boolean;
  readonly isIdle: boolean;
  readonly hasIssue: boolean;
  readonly hasPr: boolean;
  readonly hasTerminals: boolean;
  readonly isWithin7d: boolean;
}

export const CHIP_GROUPS = [
  "statusFilters",
  "typeFilters",
  "prIssueFilters",
  "sessionFilters",
  "activityFilters",
  "devServerFilters",
] as const;

export type ChipGroup = (typeof CHIP_GROUPS)[number];

type GroupPredicate = (planted: PlantedWorktree) => boolean;

const ADMITS_EVERYTHING: GroupPredicate = () => true;

/**
 * A facet selection paired with the fixture's own answer to "does this row pass
 * that group".
 *
 * The predicates are written against plant records, never against
 * `matchesFilters` — which is what makes them an oracle rather than a
 * restatement. They are small enough to check by eye, and each is exactly the
 * fact the generator planted.
 */
export interface FacetLevel {
  /** How many filter groups this level activates. Also the reported axis value. */
  readonly activeGroups: number;
  readonly selection: Pick<FilterState, ChipGroup>;
  readonly passes: Readonly<Record<ChipGroup, GroupPredicate>>;
}

function emptySelection(): Pick<FilterState, ChipGroup> {
  return {
    statusFilters: new Set<StatusFilter>(),
    typeFilters: new Set<TypeFilter>(),
    prIssueFilters: new Set<PrIssueFilter>(),
    sessionFilters: new Set<SessionFilter>(),
    activityFilters: new Set<ActivityFilter>(),
    devServerFilters: new Set<DevServerFilter>(),
  };
}

const FACETS_NONE: FacetLevel = {
  activeGroups: 0,
  selection: emptySelection(),
  passes: {
    statusFilters: ADMITS_EVERYTHING,
    typeFilters: ADMITS_EVERYTHING,
    prIssueFilters: ADMITS_EVERYTHING,
    sessionFilters: ADMITS_EVERYTHING,
    activityFilters: ADMITS_EVERYTHING,
    devServerFilters: ADMITS_EVERYTHING,
  },
};

const STATUS_SELECTION: readonly StatusFilter[] = ["dirty", "idle"];
const TYPE_SELECTION: readonly TypeFilter[] = [
  "feature",
  "bugfix",
  "refactor",
  "chore",
  "docs",
  "test",
];
const TYPE_SELECTION_SET: ReadonlySet<string> = new Set<string>(TYPE_SELECTION);

const FACETS_TWO: FacetLevel = {
  activeGroups: 2,
  selection: {
    ...emptySelection(),
    statusFilters: new Set<StatusFilter>(STATUS_SELECTION),
    sessionFilters: new Set<SessionFilter>(["hasTerminals"]),
  },
  passes: {
    statusFilters: (p) => p.isDirty || p.isIdle,
    typeFilters: ADMITS_EVERYTHING,
    prIssueFilters: ADMITS_EVERYTHING,
    sessionFilters: (p) => p.hasTerminals,
    activityFilters: ADMITS_EVERYTHING,
    devServerFilters: ADMITS_EVERYTHING,
  },
};

const FACETS_FIVE: FacetLevel = {
  activeGroups: 5,
  selection: {
    ...emptySelection(),
    statusFilters: new Set<StatusFilter>(STATUS_SELECTION),
    typeFilters: new Set<TypeFilter>(TYPE_SELECTION),
    prIssueFilters: new Set<PrIssueFilter>(["hasIssue", "hasPR"]),
    sessionFilters: new Set<SessionFilter>(["hasTerminals"]),
    activityFilters: new Set<ActivityFilter>(["last7d"]),
  },
  passes: {
    statusFilters: (p) => p.isDirty || p.isIdle,
    typeFilters: (p) => TYPE_SELECTION_SET.has(p.typeId),
    prIssueFilters: (p) => p.hasIssue || p.hasPr,
    sessionFilters: (p) => p.hasTerminals,
    activityFilters: (p) => p.isWithin7d,
    devServerFilters: ADMITS_EVERYTHING,
  },
};

export const FACET_LEVELS: readonly FacetLevel[] = [FACETS_NONE, FACETS_TWO, FACETS_FIVE];

/**
 * `created` rather than `alpha` or `recent`: the generator stamps a distinct,
 * strictly descending `createdAt` per row, so the expected browse order is a
 * plant record instead of a collator's verdict the oracle would have to
 * reproduce.
 */
export const SIDEBAR_ORDER_BY: OrderBy = "created";

export interface SidebarDerivationFixture {
  readonly size: number;
  readonly planted: readonly PlantedWorktree[];
  readonly worktrees: readonly WorktreeState[];
  readonly metaById: Map<string, DerivedWorktreeMeta>;
  readonly sessionsByWorktreeId: Record<string, DevPreviewSessionState>;
  readonly activeWorktreeId: string;
  readonly pinnedWorktreeIds: string[];
  readonly plantedById: Map<string, PlantedWorktree>;
  /** Rows the needle was planted into, at any relevance tier. */
  readonly needleCount: number;
}

const CREATED_AT_BASE = 1_760_000_000_000;

/**
 * Build a corpus of `size` non-main worktrees.
 *
 * Every branch is taken modulo a prime that is coprime with the corpus sizes in
 * use, so the planted distributions stay mixed at 50 and at 200 rather than
 * lining up on one row.
 */
export function buildSidebarDerivationFixture(size: number): SidebarDerivationFixture {
  const now = Date.now();
  const planted: PlantedWorktree[] = [];
  const worktrees: WorktreeState[] = [];
  const metaById = new Map<string, DerivedWorktreeMeta>();
  const sessionsByWorktreeId: Record<string, DevPreviewSessionState> = {};
  const pinnedWorktreeIds: string[] = [];
  const plantedById = new Map<string, PlantedWorktree>();
  let needleCount = 0;

  const activeIndex = 1;
  const activeWorktreeId = `/bench/wt-${activeIndex}`;

  for (let i = 0; i < size; i += 1) {
    const id = `/bench/wt-${i}`;
    const word = WORDS[i % WORDS.length];

    // --- branch type -------------------------------------------------------
    const typeSlot = i % (TYPED_PREFIXES.length + 2);
    const isDetached = typeSlot === TYPED_PREFIXES.length + 1;
    const isUntyped = typeSlot === TYPED_PREFIXES.length;
    const prefixEntry = TYPED_PREFIXES[typeSlot % TYPED_PREFIXES.length];
    const branchPrefix = isUntyped ? UNTYPED_PREFIX : prefixEntry.prefix;
    const typeId: WorktreeTypeId = isDetached
      ? "detached"
      : isUntyped
        ? "other"
        : prefixEntry.typeId;

    // --- needle tier -------------------------------------------------------
    const needleSlot = i % 11;
    const relevance =
      needleSlot === 0
        ? RELEVANCE_NAME_PREFIX
        : needleSlot === 4
          ? RELEVANCE_NAME_SUBSTRING
          : needleSlot === 8
            ? RELEVANCE_BRANCH_ONLY
            : RELEVANCE_NONE;
    if (relevance > RELEVANCE_NONE) needleCount += 1;

    const name =
      relevance === RELEVANCE_NAME_PREFIX
        ? `${SIDEBAR_NEEDLE}-${word}-${i}`
        : relevance === RELEVANCE_NAME_SUBSTRING
          ? `wt-${SIDEBAR_NEEDLE}-${i}`
          : `wt-${word}-${i}`;
    const branchTail = relevance === RELEVANCE_BRANCH_ONLY ? `${SIDEBAR_NEEDLE}-${i}` : name;
    const branch = `${branchPrefix}/${branchTail}`;

    // --- status ------------------------------------------------------------
    const isActive = i === activeIndex;
    const isDirty = i % 3 === 0;
    const isStale = i % 7 === 4;
    const statusKeys: StatusFilter[] = [];
    if (isActive) statusKeys.push("active");
    if (isDirty) statusKeys.push("dirty");
    if (isStale) statusKeys.push("stale");
    if (statusKeys.length === 0 || (statusKeys.length === 1 && statusKeys[0] === "active")) {
      statusKeys.push("idle");
    }

    // --- forge links -------------------------------------------------------
    const hasIssue = i % 4 === 0;
    const hasPr = i % 5 === 1;
    const prState = PR_STATES[i % PR_STATES.length];
    const prIssueKeys: PrIssueFilter[] = [];
    if (hasIssue) prIssueKeys.push("hasIssue");
    if (hasPr) {
      prIssueKeys.push("hasPR");
      if (prState === "open") prIssueKeys.push("prOpen");
      if (prState === "merged") prIssueKeys.push("prMerged");
      if (prState === "closed" || prState === "declined") prIssueKeys.push("prClosed");
    }

    // --- sessions ----------------------------------------------------------
    const terminalCount = i % 2 === 0 ? 1 + (i % 3) : 0;
    const hasWorkingAgent = i % 6 === 0;
    const hasWaitingAgent = i % 6 === 2;
    const hasCompletedAgent = i % 6 === 3;
    const hasExitedAgent = i % 6 === 5;
    const sessionKeys: SessionFilter[] = [];
    if (terminalCount > 0) sessionKeys.push("hasTerminals");
    if (hasWorkingAgent) sessionKeys.push("working");
    if (hasWaitingAgent) sessionKeys.push("waiting");
    if (hasCompletedAgent) sessionKeys.push("completed");
    if (hasExitedAgent) sessionKeys.push("exited");

    // --- activity ----------------------------------------------------------
    const hasValidActivity = i % 23 !== 7;
    const ageMs = ACTIVITY_AGES_MS[i % ACTIVITY_AGES_MS.length];
    const lastActivityTimestamp = hasValidActivity ? now - ageMs : null;
    const activityKeys: ActivityFilter[] = [];
    if (hasValidActivity) {
      for (const window of ACTIVITY_WINDOWS) {
        if (ageMs < window.windowMs) activityKeys.push(window.key);
      }
    }
    const isWithin7d = hasValidActivity && ageMs < 7 * DAY_MS;

    // --- dev server --------------------------------------------------------
    const hasSession = i % 2 === 0;
    const devStatus = DEV_STATUSES[i % DEV_STATUSES.length];
    const devServerKeys: DevServerFilter[] = [];
    let session: DevPreviewSessionState | null = null;
    if (hasSession) {
      session = {
        panelId: `panel-${i}`,
        projectId: "bench-project",
        worktreeId: id,
        status: devStatus,
        url: null,
        predictedUrl: null,
        error: null,
        terminalId: null,
        isRestarting: false,
        generation: 1,
        updatedAt: now,
      };
      sessionsByWorktreeId[id] = session;
      if (devStatus === "running") devServerKeys.push("running", "hasDevServer");
      else if (devStatus === "starting" || devStatus === "installing")
        devServerKeys.push("starting", "hasDevServer");
      else if (devStatus === "error") devServerKeys.push("error", "hasDevServer");
    }

    // --- location and ordering --------------------------------------------
    const isExternal = i % 17 === 6;
    const isPinnedRow = i % 19 === 2;
    let pinIndex = -1;
    if (isPinnedRow) {
      pinIndex = pinnedWorktreeIds.length;
      pinnedWorktreeIds.push(id);
    }
    const createdAt = CREATED_AT_BASE - i * 1000;

    const changedFileCount = isDirty ? 1 + (i % 5) : 0;
    const worktree: WorktreeState = {
      id,
      worktreeId: id,
      path: id,
      name,
      branch,
      isDetached,
      isCurrent: isActive,
      isMainWorktree: false,
      isExternal,
      mood: isStale ? "stale" : "stable",
      modifiedCount: changedFileCount,
      createdAt,
      lastActivityTimestamp,
      worktreeChanges: {
        worktreeId: id,
        rootPath: id,
        changes: [],
        changedFileCount,
        lastUpdated: now,
      },
      ...(hasIssue
        ? { issueNumber: 1000 + i, issueTitle: `${word} handling for ${branchPrefix}` }
        : {}),
      ...(hasPr
        ? {
            linked: {
              providerId: "bench",
              pr: {
                ref: {
                  providerId: "bench",
                  owner: "bench",
                  repo: "bench",
                  number: 5000 + i,
                  rawData: null,
                },
                title: `update ${word} in ${branchPrefix}`,
                url: `https://bench.invalid/pr/${5000 + i}`,
                state: prState,
              },
            },
          }
        : {}),
    };

    const meta: DerivedWorktreeMeta = {
      terminalCount,
      hasWorkingAgent,
      hasWaitingAgent,
      hasCompletedAgent,
      hasExitedAgent,
      hasMergeConflict: false,
      chipState: hasWaitingAgent ? "waiting" : hasCompletedAgent ? "complete" : null,
    };

    const record: PlantedWorktree = {
      worktree,
      meta,
      session,
      typeId,
      isExternal,
      pinIndex,
      createdAt,
      relevance,
      statusKeys,
      prIssueKeys,
      sessionKeys,
      activityKeys,
      devServerKeys,
      isDirty,
      isIdle: statusKeys.includes("idle"),
      hasIssue,
      hasPr,
      hasTerminals: terminalCount > 0,
      isWithin7d,
    };

    planted.push(record);
    plantedById.set(id, record);
    worktrees.push(worktree);
    metaById.set(id, meta);
  }

  return {
    size,
    planted,
    worktrees,
    metaById,
    sessionsByWorktreeId,
    activeWorktreeId,
    pinnedWorktreeIds,
    plantedById,
    needleCount,
  };
}

// --- The derivation pass -----------------------------------------------------

/**
 * The four subjects, injectable at the module boundary.
 *
 * The scenarios never pass an override; it exists so a stub experiment can
 * break one function without touching a product file, and so the predicate
 * tests can prove each accumulator goes non-zero against a subject that stopped
 * doing its job.
 */
export interface SidebarDerivationSubjects {
  matchesFilters: typeof realMatchesFilters;
  sortWorktreesByRelevance: typeof realSortWorktreesByRelevance;
  groupByType: typeof realGroupByType;
  computeChipCounts: typeof realComputeChipCounts;
}

export const REAL_SIDEBAR_SUBJECTS: SidebarDerivationSubjects = {
  matchesFilters: realMatchesFilters,
  sortWorktreesByRelevance: realSortWorktreesByRelevance,
  groupByType: realGroupByType,
  computeChipCounts: realComputeChipCounts,
};

export interface DerivationStep {
  /** Characters of {@link SIDEBAR_NEEDLE} typed so far. 0 is the browse pass. */
  readonly queryLength: number;
  readonly facets: FacetLevel;
  /** The typed prefix, sliced once at matrix-build time. */
  readonly query: string;
  /**
   * The exact `FilterState` the component would hand the subjects on this step,
   * assembled here rather than per pass so that building a subject's argument is
   * never priced as the subject.
   */
  readonly filters: FilterState;
}

/**
 * The full sweep: every facet level crossed with progressive typing.
 *
 * The scenarios call this BEFORE the clock starts. Each step carries its own
 * resolved query and `FilterState`, so a timed pass allocates nothing of its own
 * before it begins measuring.
 */
export function buildStepMatrix(): DerivationStep[] {
  const steps: DerivationStep[] = [];
  for (const facets of FACET_LEVELS) {
    for (let queryLength = 0; queryLength <= SIDEBAR_NEEDLE.length; queryLength += 1) {
      const query = SIDEBAR_NEEDLE.slice(0, queryLength);
      steps.push({ queryLength, facets, query, filters: { query, ...facets.selection } });
    }
  }
  return steps;
}

export interface PassObservation {
  readonly step: DerivationStep;
  /**
   * What the pass produced, held by REFERENCE.
   *
   * `kept` is the array the filter loop built — the component builds the same
   * one — while `sorted`, `sections` and `chipCounts` are the subjects' own
   * return values. Recording a pass is therefore a handful of pointer stores;
   * the id lists the oracle compares are projected out of these afterwards, in
   * {@link gradeDerivationSweep}, so no copy is made inside the bracket.
   */
  readonly kept: readonly WorktreeState[];
  readonly sorted: readonly WorktreeState[];
  readonly sections: GroupedSection<WorktreeState>[] | null;
  readonly chipCounts: ChipCounts;
  /** Per-operation brackets, in the order the component runs them. */
  readonly matchesFiltersMs: number;
  readonly sortMs: number;
  readonly groupMs: number;
  readonly chipCountsMs: number;
}

/**
 * One render's worth of derivation, exactly as `SidebarContent` orders it:
 * filter every row, sort the survivors, group them when grouped mode applies,
 * and recompute the chip counts over the whole set.
 *
 * Each bracket holds a subject call and the append its result goes into. The
 * step's query and `FilterState` were built by {@link buildStepMatrix}, and
 * nothing on this path is graded, tallied or copied — {@link
 * gradeDerivationSweep} is where the oracle runs.
 */
export function runDerivationPass(
  fixture: SidebarDerivationFixture,
  step: DerivationStep,
  subjects: SidebarDerivationSubjects = REAL_SIDEBAR_SUBJECTS
): PassObservation {
  const filters = step.filters;

  const filterStart = performance.now();
  const kept: WorktreeState[] = [];
  for (const worktree of fixture.worktrees) {
    const meta = fixture.metaById.get(worktree.id)!;
    if (
      subjects.matchesFilters(
        worktree,
        filters,
        meta,
        worktree.id === fixture.activeWorktreeId,
        fixture.sessionsByWorktreeId
      )
    ) {
      kept.push(worktree);
    }
  }
  const matchesFiltersMs = performance.now() - filterStart;

  const sortStart = performance.now();
  const sorted = subjects.sortWorktreesByRelevance(
    kept,
    step.query,
    SIDEBAR_ORDER_BY,
    fixture.pinnedWorktreeIds,
    []
  );
  const sortMs = performance.now() - sortStart;

  // Grouped mode is skipped while a query is active — mirrored here so the
  // bracket prices what the component actually runs on that pass.
  let sections: GroupedSection<WorktreeState>[] | null = null;
  const groupStart = performance.now();
  if (step.queryLength === 0) {
    sections = subjects.groupByType(sorted, SIDEBAR_ORDER_BY, fixture.pinnedWorktreeIds);
  }
  const groupMs = performance.now() - groupStart;

  const chipStart = performance.now();
  const chipCounts = subjects.computeChipCounts(
    fixture.worktrees,
    fixture.metaById,
    fixture.activeWorktreeId,
    filters,
    fixture.sessionsByWorktreeId
  );
  const chipCountsMs = performance.now() - chipStart;

  return {
    step,
    kept,
    sorted,
    sections,
    chipCounts,
    matchesFiltersMs,
    sortMs,
    groupMs,
    chipCountsMs,
  };
}

// --- Oracles -----------------------------------------------------------------

function queryAdmits(planted: PlantedWorktree, queryLength: number): boolean {
  return queryLength === 0 || planted.relevance > RELEVANCE_NONE;
}

/** Rows that must survive `matchesFilters` on this step. */
export function expectedKeptIds(
  fixture: SidebarDerivationFixture,
  step: DerivationStep
): Set<string> {
  const kept = new Set<string>();
  for (const planted of fixture.planted) {
    if (!queryAdmits(planted, step.queryLength)) continue;
    const passesEvery = CHIP_GROUPS.every((group) => step.facets.passes[group](planted));
    if (passesEvery) kept.add(planted.worktree.id);
  }
  return kept;
}

function emptyCounts<K extends string>(keys: readonly K[]): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const key of keys) out[key] = 0;
  return out;
}

const STATUS_KEYS: readonly StatusFilter[] = ["active", "dirty", "stale", "idle"];
const TYPE_KEYS: readonly TypeFilter[] = [
  "feature",
  "bugfix",
  "refactor",
  "chore",
  "docs",
  "test",
  "release",
  "ci",
  "deps",
  "perf",
  "style",
  "wip",
  "main",
  "detached",
  "other",
];
const PR_ISSUE_KEYS: readonly PrIssueFilter[] = [
  "hasIssue",
  "hasPR",
  "prOpen",
  "prMerged",
  "prClosed",
];
const SESSION_KEYS: readonly SessionFilter[] = [
  "hasTerminals",
  "working",
  "waiting",
  "completed",
  "exited",
];
const ACTIVITY_KEYS: readonly ActivityFilter[] = ["last15m", "last1h", "last24h", "last7d"];
const DEV_SERVER_KEYS: readonly DevServerFilter[] = [
  "running",
  "starting",
  "hasDevServer",
  "error",
];

/**
 * The chip counts this step must produce.
 *
 * `computeChipCounts` builds a DIFFERENT base set per group — every other
 * group's filters plus the query, with the group's own filters lifted — so the
 * expectation does the same, over plant records. Summing one base set for all
 * six would agree with a subject that had stopped excluding groups.
 */
export function expectedChipCounts(
  fixture: SidebarDerivationFixture,
  step: DerivationStep
): ChipCounts {
  const counts: ChipCounts = {
    status: emptyCounts(STATUS_KEYS),
    branchType: emptyCounts(TYPE_KEYS),
    prIssue: emptyCounts(PR_ISSUE_KEYS),
    sessions: emptyCounts(SESSION_KEYS),
    activity: emptyCounts(ACTIVITY_KEYS),
    devServer: emptyCounts(DEV_SERVER_KEYS),
  };

  const inBaseFor = (planted: PlantedWorktree, exclude: ChipGroup): boolean => {
    if (!queryAdmits(planted, step.queryLength)) return false;
    return CHIP_GROUPS.every((group) => group === exclude || step.facets.passes[group](planted));
  };

  for (const planted of fixture.planted) {
    if (inBaseFor(planted, "statusFilters")) {
      for (const key of planted.statusKeys) counts.status[key] += 1;
    }
    if (inBaseFor(planted, "typeFilters")) counts.branchType[planted.typeId] += 1;
    if (inBaseFor(planted, "prIssueFilters")) {
      for (const key of planted.prIssueKeys) counts.prIssue[key] += 1;
    }
    if (inBaseFor(planted, "sessionFilters")) {
      for (const key of planted.sessionKeys) counts.sessions[key] += 1;
    }
    if (inBaseFor(planted, "activityFilters")) {
      for (const key of planted.activityKeys) counts.activity[key] += 1;
    }
    if (inBaseFor(planted, "devServerFilters")) {
      for (const key of planted.devServerKeys) counts.devServer[key] += 1;
    }
  }

  return counts;
}

export interface PassMisses {
  keptMisses: number;
  chipCountMisses: number;
  sortMisses: number;
  groupMisses: number;
}

function multisetMisses(actual: readonly string[], expected: ReadonlySet<string>): number {
  let misses = 0;
  const seen = new Set<string>();
  for (const id of actual) {
    if (!expected.has(id) || seen.has(id)) misses += 1;
    seen.add(id);
  }
  for (const id of expected) {
    if (!seen.has(id)) misses += 1;
  }
  return misses;
}

const PIN_RANK_UNPINNED = Number.MAX_SAFE_INTEGER;

/**
 * The lexicographic key the planted corpus says the sort must be monotone in.
 *
 * With a query the product re-sorts the whole list on the external partition
 * and the relevance score alone (pins do not survive that pass), so the key is
 * two-term. Without one, `sortWorktrees` runs: external last, then pin order,
 * then `createdAt` descending — and the generator stamps a distinct `createdAt`
 * per row so no tiebreak is ever reached.
 */
function plantedSortKey(planted: PlantedWorktree, queryLength: number): number[] {
  const externalRank = planted.isExternal ? 1 : 0;
  if (queryLength > 0) return [externalRank, -planted.relevance];
  const pinRank =
    planted.pinIndex >= 0 && !planted.isExternal ? planted.pinIndex : PIN_RANK_UNPINNED;
  return [externalRank, pinRank, -planted.createdAt];
}

function keyBefore(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Grade one pass against the plant.
 *
 * Four accumulators, one per operation the component ran — a single aggregate
 * cannot notice one of the four going missing, and three of the four are
 * cheaper to skip than to perform.
 *
 * **Nothing here is inside a timed bracket.** The id lists it compares are
 * projected out of the recorded references at this point, not while the pass was
 * being measured.
 */
export function gradeDerivationPass(
  fixture: SidebarDerivationFixture,
  observation: PassObservation
): PassMisses {
  const step = observation.step;
  const expectedKept = expectedKeptIds(fixture, step);
  const keptIds = observation.kept.map((worktree) => worktree.id);
  const sortedIds = observation.sorted.map((worktree) => worktree.id);

  // matchesFilters: the survivor set, by identity and not merely by size.
  const keptMisses = multisetMisses(keptIds, expectedKept);

  // computeChipCounts: every one of the 39 chip keys, against the planted
  // distribution for this step's six group-excluded base sets.
  const expectedChips = expectedChipCounts(fixture, step);
  let chipCountMisses = 0;
  const compareGroup = <K extends string>(
    actual: Record<K, number>,
    expected: Record<K, number>,
    keys: readonly K[]
  ): void => {
    for (const key of keys) {
      if (actual[key] !== expected[key]) chipCountMisses += 1;
    }
  };
  compareGroup(observation.chipCounts.status, expectedChips.status, STATUS_KEYS);
  compareGroup(observation.chipCounts.branchType, expectedChips.branchType, TYPE_KEYS);
  compareGroup(observation.chipCounts.prIssue, expectedChips.prIssue, PR_ISSUE_KEYS);
  compareGroup(observation.chipCounts.sessions, expectedChips.sessions, SESSION_KEYS);
  compareGroup(observation.chipCounts.activity, expectedChips.activity, ACTIVITY_KEYS);
  compareGroup(observation.chipCounts.devServer, expectedChips.devServer, DEV_SERVER_KEYS);

  // sortWorktreesByRelevance: a multiset permutation of ITS OWN input (nothing
  // invented, nothing dropped), monotone in the planted key.
  let sortMisses = multisetMisses(sortedIds, new Set(keptIds));
  for (let i = 1; i < sortedIds.length; i += 1) {
    const previous = fixture.plantedById.get(sortedIds[i - 1]);
    const current = fixture.plantedById.get(sortedIds[i]);
    if (!previous || !current) {
      sortMisses += 1;
      continue;
    }
    if (
      keyBefore(
        plantedSortKey(previous, step.queryLength),
        plantedSortKey(current, step.queryLength)
      ) > 0
    ) {
      sortMisses += 1;
    }
  }

  // groupByType: only graded on the passes the component would group on.
  let groupMisses = 0;
  if (step.queryLength === 0) {
    if (observation.sections === null) {
      groupMisses += 1;
    } else {
      const sections = observation.sections;
      const seenTypes = new Set<string>();
      const memberIds: string[] = [];
      for (let s = 0; s < sections.length; s += 1) {
        const section = sections[s];
        if (seenTypes.has(section.type)) groupMisses += 1;
        seenTypes.add(section.type);
        if (section.worktrees.length === 0) groupMisses += 1;
        // "Outside the project" is a location bucket and must be last (#11434).
        if (section.type === "external" && s !== sections.length - 1) groupMisses += 1;
        for (const worktree of section.worktrees) {
          memberIds.push(worktree.id);
          const planted = fixture.plantedById.get(worktree.id);
          if (!planted) {
            groupMisses += 1;
            continue;
          }
          if (section.type === "external") {
            if (!planted.isExternal) groupMisses += 1;
          } else if (planted.isExternal || planted.typeId !== section.type) {
            groupMisses += 1;
          }
        }
      }
      groupMisses += multisetMisses(memberIds, new Set(sortedIds));
    }
  } else if (observation.sections !== null) {
    // Grouping a query pass is work the component never asks for.
    groupMisses += 1;
  }

  return { keptMisses, chipCountMisses, sortMisses, groupMisses };
}

export interface SweepSummary {
  readonly misses: PassMisses;
  readonly passCount: number;
  readonly keptRowCount: number;
  readonly perPassMs: number[];
  readonly matchesFiltersMs: number;
  readonly sortMs: number;
  readonly groupMs: number;
  readonly chipCountsMs: number;
}

/**
 * Run the whole step matrix. **This is the timed bracket, and it contains the
 * four subjects and nothing else.**
 *
 * The loop calls {@link runDerivationPass} and appends the observation it
 * returns. No oracle runs here, nothing is compared, no id list is projected and
 * no tally is kept — an observation is a few references to arrays the subjects
 * had already produced. Everything else is {@link gradeDerivationSweep}, which
 * the scenarios call after they have read `performance.now()` a second time.
 *
 * The recording cost that could not be moved out is one array push per pass —
 * 18 of them per iteration, beside a 200-worktree pass that costs milliseconds.
 */
export function runDerivationSweep(
  fixture: SidebarDerivationFixture,
  steps: readonly DerivationStep[],
  subjects: SidebarDerivationSubjects = REAL_SIDEBAR_SUBJECTS
): PassObservation[] {
  const passes: PassObservation[] = [];
  for (const step of steps) {
    passes.push(runDerivationPass(fixture, step, subjects));
  }
  return passes;
}

/**
 * Tally and grade a finished sweep — **after the clock has stopped**.
 *
 * Both halves live here for the same reason. The per-operation totals and the
 * per-pass sums are arithmetic over what the passes recorded, and the four
 * predicates are oracle work; neither is the subject, so neither belongs in
 * `durationMs`.
 */
export function gradeDerivationSweep(
  fixture: SidebarDerivationFixture,
  passes: readonly PassObservation[]
): SweepSummary {
  const perPassMs: number[] = [];
  const misses: PassMisses = {
    keptMisses: 0,
    chipCountMisses: 0,
    sortMisses: 0,
    groupMisses: 0,
  };
  let keptRowCount = 0;
  let matchesFiltersMs = 0;
  let sortMs = 0;
  let groupMs = 0;
  let chipCountsMs = 0;

  for (const observation of passes) {
    perPassMs.push(
      observation.matchesFiltersMs +
        observation.sortMs +
        observation.groupMs +
        observation.chipCountsMs
    );
    keptRowCount += observation.kept.length;
    matchesFiltersMs += observation.matchesFiltersMs;
    sortMs += observation.sortMs;
    groupMs += observation.groupMs;
    chipCountsMs += observation.chipCountsMs;

    const graded = gradeDerivationPass(fixture, observation);
    misses.keptMisses += graded.keptMisses;
    misses.chipCountMisses += graded.chipCountMisses;
    misses.sortMisses += graded.sortMisses;
    misses.groupMisses += graded.groupMisses;
  }

  return {
    misses,
    passCount: passes.length,
    keptRowCount,
    perPassMs,
    matchesFiltersMs,
    sortMs,
    groupMs,
    chipCountsMs,
  };
}

/**
 * What each step of the matrix is expected to keep.
 *
 * A step whose expected survivor set is empty still grades — a subject that
 * stopped excluding rows posts N misses against it — but it prices nothing, so
 * the unit test reads this to assert the sweep is not mostly empty passes.
 */
export function describeFixtureCoverage(
  fixture: SidebarDerivationFixture
): Array<{ queryLength: number; activeGroups: number; expectedKept: number }> {
  return buildStepMatrix().map((step) => ({
    queryLength: step.queryLength,
    activeGroups: step.facets.activeGroups,
    expectedKept: expectedKeptIds(fixture, step).size,
  }));
}

const fixtureCache = new Map<number, SidebarDerivationFixture>();

/** Built once per size and reused: corpus construction is not the subject. */
export function getSidebarDerivationFixture(size: number): SidebarDerivationFixture {
  let fixture = fixtureCache.get(size);
  if (!fixture) {
    fixture = buildSidebarDerivationFixture(size);
    fixtureCache.set(size, fixture);
  }
  return fixture;
}
