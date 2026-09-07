import { performance } from "node:perf_hooks";
import {
  computeSearchActivityKey as realComputeSearchActivityKey,
  isFilterMatch as realIsFilterMatch,
  rankSwitcherMatches as realRankSwitcherMatches,
  scoreProjectQuery as realScoreProjectQuery,
  type SearchActivityKey,
} from "../../../src/lib/projectSwitcherSearch";
import type {
  SearchableProject,
  SearchableScratch,
} from "../../../src/hooks/useProjectSwitcherPalette";

/**
 * Fixture + oracle for the project-switcher ranking scenarios (PERF-403/404).
 *
 * ⌘P re-ranks the whole workspace list on every keystroke, which makes
 * `rankSwitcherMatches` one of the most frequently executed pure functions in
 * the app. PERF-170/171 cover `actionPaletteSearch` — a different scorer over a
 * different corpus (the action catalog), with no typo tier, no activity keys
 * and no two-kind row model — so nothing here duplicates it.
 *
 * Four subjects, five accumulators — one per OPERATION on the timed path, not
 * one per export, because `isFilterMatch` is called twice per row:
 *
 * - `rankSwitcherMatches` — the per-keystroke re-rank (`rankMisses`).
 * - `scoreProjectQuery` — its inner per-row scoring loop, priced directly
 *   (`scoreMisses`).
 * - `isFilterMatch` over each project's NAME — the same module's filter-only
 *   matcher, whose production caller is `filterPilotGroups` in the Pilot
 *   overview (`filterMatchMisses`).
 * - `isFilterMatch` over each project's `displayPath` — `filterPilotGroups`
 *   tests both fields per row, so the second call is a second operation with its
 *   own cost, and it gets its own term (`pathFilterMatchMisses`). It was priced
 *   and ungraded until #12093: deleting the whole per-project call was free.
 * - `computeSearchActivityKey` — the palette session's activity freeze, which
 *   `captureSearchActivity` runs over every row once per open (`activityMisses`).
 *
 * ## What the timed bracket contains
 *
 * {@link runSwitcherSession} is what the scenarios wrap in `performance.now()`,
 * and it calls the four subjects and appends what they returned. Corpus
 * construction ({@link getSwitcherFixture}), step construction
 * ({@link progressiveTypingSteps}, {@link correctionPathSteps}) and every oracle
 * ({@link gradeSwitcherSession}) run outside it. A keystroke observation holds
 * the ranker's own result array by REFERENCE — the id list the rank predicate
 * compares is projected out of it after the clock stops — while the filter and
 * score loops record an id at the call site, which is the only place a per-row
 * verdict can be observed at all.
 *
 * ## How the oracle avoids grading itself
 *
 * Nothing here calls a `projectSwitcherSearch` export to decide what the answer
 * should be. The corpus is planted so the answer is known from construction:
 * {@link SWITCHER_NEEDLE} starts with a character that appears NOWHERE else in
 * any generated name or path, so every prefix of it selects exactly the rows it
 * was planted into. Each row records where the needle went — name, path, or
 * neither — and the predicate reads those records.
 *
 * Both failure directions are covered. A ranker that returns nothing fails
 * "every planted match is present"; one that returns everything fails "no
 * planted non-match is present"; one that returns everything in an arbitrary
 * order fails "the exact-name match ranks first" and "name matches precede
 * path-only matches".
 */

/**
 * The planted query token.
 *
 * `z` is load-bearing: no generated name or path contains one except where this
 * needle was planted, so a prefix of it is an exact selector over the corpus.
 */
export const SWITCHER_NEEDLE = "zolvenq";

/**
 * The same word mistyped as an adjacent transposition — the edit
 * `hasNearMissNameMatch` was built for (#11924), and the one people actually
 * make. `e` and `n` swap.
 */
export const SWITCHER_TYPO = "zolvneq";

/** Name and path words. Chosen for containing no `z`. */
const WORDS = [
  "atlas",
  "beacon",
  "harbour",
  "kestrel",
  "parchment",
  "tundra",
  "meridian",
  "quarry",
  "thicket",
  "vellum",
] as const;

/** Where the needle was planted in a row, decided by the generator. */
type NeedlePlacement = "exact" | "name-prefix" | "name-substring" | "path-only" | "none";

/**
 * The demand tier a row was planted with, named rather than numbered.
 *
 * The module's own class constants are private, and copying them here would
 * make the predicate a restatement of the subject. These labels are graded by
 * ORDER instead: whatever numbers `computeSearchActivityKey` returns, blocked
 * must sort ahead of waiting, waiting ahead of review, review ahead of working,
 * and working ahead of quiet.
 */
export type DemandTier = "blocked" | "waiting" | "review" | "working" | "quiet";

/** Expected-demand order, most demanding first. */
export const DEMAND_ORDER: readonly DemandTier[] = [
  "blocked",
  "waiting",
  "review",
  "working",
  "quiet",
];

export interface PlantedRow {
  readonly id: string;
  readonly kind: "project" | "scratch";
  readonly name: string;
  readonly placement: NeedlePlacement;
  readonly needleInName: boolean;
  readonly needleInPath: boolean;
  readonly demand: DemandTier;
  /** The volume `computeSearchActivityKey` must report for this row. */
  readonly demandVolume: number;
}

export interface SwitcherFixture {
  readonly projects: SearchableProject[];
  readonly scratches: SearchableScratch[];
  readonly planted: readonly PlantedRow[];
  readonly plantedById: Map<string, PlantedRow>;
  readonly exactProjectId: string;
  readonly rowCount: number;
  readonly needleInNameCount: number;
  readonly needleInPathOnlyCount: number;
  /** A project whose needle is in the NAME only, for the name-weight probe. */
  readonly weightProbeName: string;
  /** A project whose needle is in the PATH only, for the same probe. */
  readonly weightProbePath: string;
  readonly plainName: string;
  readonly plainPath: string;
}

const BASE_LAST_OPENED = 1_760_000_000_000;

interface DemandPlant {
  readonly tier: DemandTier;
  readonly volume: number;
  readonly fields: {
    activeAgentCount: number;
    waitingAgentCount: number;
    blockedAgentCount: number;
    completedAgentCount: number;
    unacknowledgedCompletedAgentCount: number;
    snoozedAgentCount: number;
    processCount: number;
    assistantState?: "working" | "waiting";
    assistantWaitingReason?: "error";
    assistantStateSince?: number;
  };
}

const ZERO_COUNTS = {
  activeAgentCount: 0,
  waitingAgentCount: 0,
  blockedAgentCount: 0,
  completedAgentCount: 0,
  unacknowledgedCompletedAgentCount: 0,
  snoozedAgentCount: 0,
  processCount: 0,
};

/**
 * One row's planted demand, in the seven shapes the classifier distinguishes.
 *
 * Two of them route through the assistant rather than through a worker tally,
 * and they are the pair that catches a classifier that reads only the counts:
 * an errored assistant must land in the SAME class as a blocked worker, and a
 * working assistant in the same class as a working one, each worth exactly one
 * unit (#11806).
 */
function plantDemand(slot: number, index: number): DemandPlant {
  switch (slot) {
    case 0: {
      const blocked = 1 + (index % 3);
      return {
        tier: "blocked",
        volume: blocked,
        fields: {
          ...ZERO_COUNTS,
          blockedAgentCount: blocked,
          waitingAgentCount: blocked + 1,
          processCount: 2,
        },
      };
    }
    case 1: {
      const waiting = 2 + (index % 4);
      return {
        tier: "waiting",
        volume: waiting,
        fields: { ...ZERO_COUNTS, waitingAgentCount: waiting, processCount: 1 },
      };
    }
    case 2:
      return {
        tier: "blocked",
        volume: 1,
        fields: {
          ...ZERO_COUNTS,
          assistantState: "waiting",
          assistantWaitingReason: "error",
          assistantStateSince: BASE_LAST_OPENED - 5_000,
        },
      };
    case 3: {
      const unacknowledged = 1 + (index % 2);
      return {
        tier: "review",
        volume: unacknowledged,
        fields: {
          ...ZERO_COUNTS,
          completedAgentCount: unacknowledged + 1,
          unacknowledgedCompletedAgentCount: unacknowledged,
        },
      };
    }
    case 4: {
      const active = 1 + (index % 5);
      return {
        tier: "working",
        volume: active,
        fields: { ...ZERO_COUNTS, activeAgentCount: active, processCount: active },
      };
    }
    case 5:
      return {
        tier: "working",
        volume: 1,
        fields: { ...ZERO_COUNTS, assistantState: "working" },
      };
    default:
      return { tier: "quiet", volume: 0, fields: { ...ZERO_COUNTS } };
  }
}

function placementFor(index: number): NeedlePlacement {
  if (index === 0) return "exact";
  switch (index % 5) {
    case 0:
      return "name-prefix";
    case 1:
      return "name-substring";
    case 2:
      return "path-only";
    default:
      return "none";
  }
}

export function buildSwitcherFixture(projectCount: number, scratchCount: number): SwitcherFixture {
  const projects: SearchableProject[] = [];
  const scratches: SearchableScratch[] = [];
  const planted: PlantedRow[] = [];
  const plantedById = new Map<string, PlantedRow>();
  let needleInNameCount = 0;
  let needleInPathOnlyCount = 0;

  for (let i = 0; i < projectCount; i += 1) {
    const id = `project-${i}`;
    const word = WORDS[i % WORDS.length];
    const otherWord = WORDS[(i + 3) % WORDS.length];
    const placement = placementFor(i);

    const name =
      placement === "exact"
        ? SWITCHER_NEEDLE
        : placement === "name-prefix"
          ? `${SWITCHER_NEEDLE}-${word}-${i}`
          : placement === "name-substring"
            ? `${word}-${SWITCHER_NEEDLE}-${i}`
            : `${word}-${i}`;
    const path =
      placement === "path-only"
        ? `/home/dev/${SWITCHER_NEEDLE}/${word}-${i}`
        : `/home/dev/${otherWord}/${name}`;

    const needleInName = placement !== "path-only" && placement !== "none";
    const needleInPath = placement === "path-only" || needleInName;
    if (needleInName) needleInNameCount += 1;
    if (!needleInName && needleInPath) needleInPathOnlyCount += 1;

    const demand = plantDemand(i % 7, i);
    projects.push({
      id,
      name,
      path,
      displayPath: path.replace("/home/dev/", "~/"),
      emoji: "📁",
      status: "closed",
      isBackground: false,
      isMissing: false,
      isPinned: i % 13 === 0,
      frecencyScore: projectCount - i,
      section: "other",
      lastOpened: BASE_LAST_OPENED - i * 60_000,
      isActive: false,
      ...demand.fields,
    });

    const record: PlantedRow = {
      id,
      kind: "project",
      name,
      placement,
      needleInName,
      needleInPath,
      demand: demand.tier,
      demandVolume: demand.volume,
    };
    planted.push(record);
    plantedById.set(id, record);
  }

  for (let j = 0; j < scratchCount; j += 1) {
    const id = `scratch-${j}`;
    const word = WORDS[j % WORDS.length];
    // Scratches score on NAME ONLY, so a path placement would be unmeasurable.
    const needleInName = j % 4 === 0;
    const name = needleInName ? `${SWITCHER_NEEDLE}-notes-${j}` : `${word}-notes-${j}`;
    if (needleInName) needleInNameCount += 1;

    const demand = plantDemand((j + 2) % 7, j);
    scratches.push({
      id,
      name,
      path: `/userdata/scratch/${id}`,
      createdAt: BASE_LAST_OPENED - j * 3_600_000,
      lastOpened: BASE_LAST_OPENED - j * 120_000,
      isActive: false,
      ...demand.fields,
    });

    const record: PlantedRow = {
      id,
      kind: "scratch",
      name,
      placement: needleInName ? "name-prefix" : "none",
      needleInName,
      needleInPath: needleInName,
      demand: demand.tier,
      demandVolume: demand.volume,
    };
    planted.push(record);
    plantedById.set(id, record);
  }

  return {
    projects,
    scratches,
    planted,
    plantedById,
    exactProjectId: "project-0",
    rowCount: projects.length + scratches.length,
    needleInNameCount,
    needleInPathOnlyCount,
    weightProbeName: SWITCHER_NEEDLE,
    weightProbePath: `/home/dev/${SWITCHER_NEEDLE}/atlas-probe`,
    plainName: "atlas-probe",
    plainPath: "/home/dev/tundra/atlas-probe",
  };
}

// --- Subjects ----------------------------------------------------------------

/**
 * The four subjects, injectable at the module boundary.
 *
 * The scenarios never pass an override; the seam exists so a stub experiment
 * can break one function without editing a product file, and so the predicate
 * tests can watch each accumulator go non-zero.
 */
export interface SwitcherSubjects {
  rankSwitcherMatches: typeof realRankSwitcherMatches;
  scoreProjectQuery: typeof realScoreProjectQuery;
  isFilterMatch: typeof realIsFilterMatch;
  computeSearchActivityKey: typeof realComputeSearchActivityKey;
}

/** One row of `rankSwitcherMatches`'s own return type, named so an observation can hold it. */
export type SwitcherResultRow = ReturnType<typeof realRankSwitcherMatches>[number];

export const REAL_SWITCHER_SUBJECTS: SwitcherSubjects = {
  rankSwitcherMatches: realRankSwitcherMatches,
  scoreProjectQuery: realScoreProjectQuery,
  isFilterMatch: realIsFilterMatch,
  computeSearchActivityKey: realComputeSearchActivityKey,
};

// --- The activity freeze -----------------------------------------------------

export interface FreezeObservation {
  readonly keys: Map<string, SearchActivityKey>;
  readonly freezeMs: number;
}

/** `captureSearchActivity`: one key per row, taken once when the palette opens. */
export function runActivityFreeze(
  fixture: SwitcherFixture,
  subjects: SwitcherSubjects = REAL_SWITCHER_SUBJECTS
): FreezeObservation {
  const keys = new Map<string, SearchActivityKey>();
  const start = performance.now();
  for (const project of fixture.projects) {
    keys.set(project.id, subjects.computeSearchActivityKey(project));
  }
  for (const scratch of fixture.scratches) {
    keys.set(scratch.id, subjects.computeSearchActivityKey(scratch));
  }
  const freezeMs = performance.now() - start;
  return { keys, freezeMs };
}

/**
 * Grade the freeze against the planted demand ladder.
 *
 * Two independent claims, neither of which reads a constant out of the subject:
 * every row planted at one tier must come back in one class, and those classes
 * must be strictly ordered blocked → waiting → review → working → quiet; and
 * each row's volume must equal the count the generator planted. A classifier
 * returning a constant fails the first; one returning zeros fails the second.
 */
export function gradeActivityFreeze(fixture: SwitcherFixture, freeze: FreezeObservation): number {
  let misses = 0;
  const classByTier = new Map<DemandTier, number>();

  for (const row of fixture.planted) {
    const key = freeze.keys.get(row.id);
    if (key === undefined) {
      misses += 1;
      continue;
    }
    if (key.activityVolume !== row.demandVolume) misses += 1;
    const known = classByTier.get(row.demand);
    if (known === undefined) classByTier.set(row.demand, key.activityClass);
    else if (known !== key.activityClass) misses += 1;
  }

  for (let i = 1; i < DEMAND_ORDER.length; i += 1) {
    const stronger = classByTier.get(DEMAND_ORDER[i - 1]);
    const weaker = classByTier.get(DEMAND_ORDER[i]);
    if (stronger === undefined || weaker === undefined) {
      misses += 1;
      continue;
    }
    if (!(stronger < weaker)) misses += 1;
  }

  return misses;
}

// --- The per-keystroke pass --------------------------------------------------

/**
 * How a query relates to the planted corpus.
 *
 * `clean` — the query is a prefix of the needle, so every planted match is a
 * literal substring of the field it was planted in and must survive scoring.
 *
 * `typo` — the query is one edit away from the needle and is NOT an ordered
 * subsequence of it, so `scoreField` returns 0 and the name rows reach the
 * results only through the terminal typo tier. Path placements are left
 * ungraded on these steps: a path match has no typo tier by design, so whether
 * one survives depends on characters elsewhere in the path rather than on
 * anything the generator planted.
 */
export type QueryKind = "clean" | "typo";

export interface KeystrokeStep {
  readonly query: string;
  readonly kind: QueryKind;
  /** True on the step where the query is the needle in full. */
  readonly isExactQuery: boolean;
}

function step(query: string, kind: QueryKind): KeystrokeStep {
  return { query, kind, isExactQuery: query === SWITCHER_NEEDLE };
}

/** Typing the needle one character at a time. Every prefix is a re-rank. */
export function progressiveTypingSteps(): KeystrokeStep[] {
  const steps: KeystrokeStep[] = [];
  for (let end = 1; end <= SWITCHER_NEEDLE.length; end += 1) {
    steps.push(step(SWITCHER_NEEDLE.slice(0, end), "clean"));
  }
  return steps;
}

/**
 * The one-edit correction path: type the transposed spelling, notice, backspace
 * to the last good prefix, and type the rest correctly.
 *
 * `zolvn` still matches cleanly — it is an ordered subsequence of the needle —
 * so the divergence only becomes a typo once the swapped pair is complete at
 * `zolvne`. That is the shape the tier exists for: the list does not empty, it
 * degrades into the terminal tier and then recovers.
 */
export function correctionPathSteps(): KeystrokeStep[] {
  return [
    step("z", "clean"),
    step("zo", "clean"),
    step("zol", "clean"),
    step("zolv", "clean"),
    step("zolvn", "clean"),
    step("zolvne", "typo"),
    step("zolvneq", "typo"),
    // Backspacing back to the last good prefix.
    step("zolvne", "typo"),
    step("zolvn", "clean"),
    step("zolv", "clean"),
    // And typing it correctly.
    step("zolve", "clean"),
    step("zolven", "clean"),
    step("zolvenq", "clean"),
  ];
}

export interface KeystrokeObservation {
  readonly step: KeystrokeStep;
  /**
   * The ranker's own return value, held by REFERENCE. The id list
   * {@link gradeSwitcherSession} compares is projected out of it once the clock
   * has stopped, so recording a keystroke never copies the result set.
   */
  readonly results: readonly SwitcherResultRow[];
  /** Project ids whose NAME `isFilterMatch` admitted. */
  readonly nameFilterMatchedIds: string[];
  /** Project ids whose `displayPath` `isFilterMatch` admitted. */
  readonly displayPathFilterMatchedIds: string[];
  /** Whether a blank query was (wrongly) admitted. */
  readonly blankQueryAdmitted: boolean;
  /** Project ids `scoreProjectQuery` scored above zero. */
  readonly scoredPositiveIds: string[];
  readonly nameWeightScore: number;
  readonly pathWeightScore: number;
  readonly rankMs: number;
  readonly filterMs: number;
  readonly scoreMs: number;
}

export function runKeystroke(
  fixture: SwitcherFixture,
  keystroke: KeystrokeStep,
  activityKeys: ReadonlyMap<string, SearchActivityKey>,
  subjects: SwitcherSubjects = REAL_SWITCHER_SUBJECTS
): KeystrokeObservation {
  const rankStart = performance.now();
  const results = subjects.rankSwitcherMatches(
    keystroke.query,
    fixture.projects,
    fixture.scratches,
    activityKeys
  );
  const rankMs = performance.now() - rankStart;

  // The Pilot overview's filter-only pass over the same labels. Both fields are
  // tested per row, as `filterPilotGroups` does, and both verdicts are recorded
  // at the call site — a per-row boolean cannot be recovered anywhere else — so
  // each has its own predicate rather than the path call being priced and
  // ignored.
  const filterStart = performance.now();
  const nameFilterMatchedIds: string[] = [];
  const displayPathFilterMatchedIds: string[] = [];
  for (const project of fixture.projects) {
    if (subjects.isFilterMatch(keystroke.query, project.name)) {
      nameFilterMatchedIds.push(project.id);
    }
    if (subjects.isFilterMatch(keystroke.query, project.displayPath)) {
      displayPathFilterMatchedIds.push(project.id);
    }
  }
  const blankQueryAdmitted = subjects.isFilterMatch("   ", fixture.projects[0].name);
  const filterMs = performance.now() - filterStart;

  const scoreStart = performance.now();
  const scoredPositiveIds: string[] = [];
  for (const project of fixture.projects) {
    if (subjects.scoreProjectQuery(keystroke.query, project.name, project.path) > 0) {
      scoredPositiveIds.push(project.id);
    }
  }
  const nameWeightScore = subjects.scoreProjectQuery(
    keystroke.query,
    fixture.weightProbeName,
    fixture.plainPath
  );
  const pathWeightScore = subjects.scoreProjectQuery(
    keystroke.query,
    fixture.plainName,
    fixture.weightProbePath
  );
  const scoreMs = performance.now() - scoreStart;

  return {
    step: keystroke,
    results,
    nameFilterMatchedIds,
    displayPathFilterMatchedIds,
    blankQueryAdmitted,
    scoredPositiveIds,
    nameWeightScore,
    pathWeightScore,
    rankMs,
    filterMs,
    scoreMs,
  };
}

export interface KeystrokeMisses {
  rankMisses: number;
  scoreMisses: number;
  filterMatchMisses: number;
  pathFilterMatchMisses: number;
}

function setOf(ids: readonly string[]): Set<string> {
  return new Set(ids);
}

/**
 * Grade one keystroke against the plant.
 *
 * Four accumulators here plus `activityMisses` from the freeze — one per
 * operation on the timed path, because a single aggregate cannot see one of them
 * stop working.
 *
 * **Nothing here is inside a timed bracket.** The ranker's result ids are
 * projected out of the recorded reference at this point, not while the keystroke
 * was being measured.
 */
export function gradeKeystroke(
  fixture: SwitcherFixture,
  observation: KeystrokeObservation
): KeystrokeMisses {
  const kind = observation.step.kind;
  const orderedResultIds = observation.results.map((row) => row.id);
  const resultIds = setOf(orderedResultIds);
  let rankMisses = 0;

  // Never more rows out than in, and never the same row twice.
  if (orderedResultIds.length > fixture.rowCount) rankMisses += 1;
  if (resultIds.size !== orderedResultIds.length) rankMisses += 1;

  const nameNeedlePositions = new Map<string, number>();
  for (let i = 0; i < orderedResultIds.length; i += 1) {
    const planted = fixture.plantedById.get(orderedResultIds[i]);
    if (planted === undefined) {
      rankMisses += 1;
      continue;
    }
    if (planted.needleInName) nameNeedlePositions.set(planted.id, i);
    // A row the needle never reached must not surface, on either kind of step:
    // its name is nowhere near one edit of any prefix used here.
    if (!planted.needleInName && !planted.needleInPath) rankMisses += 1;
  }

  let lastNameNeedleIndex = -1;
  for (const planted of fixture.planted) {
    if (planted.needleInName) {
      const position = nameNeedlePositions.get(planted.id);
      if (position === undefined) rankMisses += 1;
      else lastNameNeedleIndex = Math.max(lastNameNeedleIndex, position);
      continue;
    }
    if (planted.needleInPath && kind === "clean") {
      // A path-only project is still a real match of what was typed.
      if (!resultIds.has(planted.id)) rankMisses += 1;
    }
  }

  if (kind === "clean") {
    // Name relevance outranks path relevance for every pair, so no path-only
    // row may sit above a name row.
    for (let i = 0; i < orderedResultIds.length; i += 1) {
      const planted = fixture.plantedById.get(orderedResultIds[i]);
      if (planted && !planted.needleInName && planted.needleInPath) {
        if (i < lastNameNeedleIndex) rankMisses += 1;
      }
    }
    // Typing a workspace's whole name has to land on that workspace.
    if (observation.step.isExactQuery && orderedResultIds[0] !== fixture.exactProjectId) {
      rankMisses += 1;
    }
  }

  // scoreProjectQuery: positive exactly where the needle was planted, in the
  // name or in the path, and zero everywhere else.
  let scoreMisses = 0;
  const scored = setOf(observation.scoredPositiveIds);
  for (const planted of fixture.planted) {
    if (planted.kind !== "project") continue;
    if (kind === "typo") continue;
    const expected = planted.needleInName || planted.needleInPath;
    if (scored.has(planted.id) !== expected) scoreMisses += 1;
  }
  if (kind === "clean") {
    // The name term carries NAME_WEIGHT and the path term does not, so an equal
    // hit in the name must beat one in the path.
    if (!(observation.nameWeightScore > observation.pathWeightScore)) scoreMisses += 1;
  }

  // isFilterMatch over NAME: admits exactly the names the needle was planted in,
  // and never a blank query (whitespace is a substring of every field).
  let filterMatchMisses = 0;
  const filtered = setOf(observation.nameFilterMatchedIds);
  if (kind === "clean") {
    for (const planted of fixture.planted) {
      if (planted.kind !== "project") continue;
      if (filtered.has(planted.id) !== planted.needleInName) filterMatchMisses += 1;
    }
  }
  if (observation.blankQueryAdmitted) filterMatchMisses += 1;

  // isFilterMatch over DISPLAY PATH: the second field `filterPilotGroups` tests
  // per row, and its own term. `displayPath` is the row's path with the home
  // prefix swapped for `~`, so the needle survives that rewrite intact and
  // `needleInPath` — planted by the generator — is exactly the expected verdict:
  // a path-only row carries it in the directory, every name row carries it in
  // the leaf, and nothing else in the corpus contains the needle's first
  // character at all. Two-sided by construction: a matcher stuck open admits the
  // rows the needle never reached, one stuck shut loses the ones it did, and
  // DELETING the call leaves an empty list that loses all of them.
  //
  // Graded on clean steps only, for the same reason the name term is. A typo
  // query is not a subsequence of the needle, but it can still be a subsequence
  // of a longer planted string once the trailing word is counted, so "no row may
  // match" is not a claim the plant supports on those steps.
  let pathFilterMatchMisses = 0;
  const pathFiltered = setOf(observation.displayPathFilterMatchedIds);
  if (kind === "clean") {
    for (const planted of fixture.planted) {
      if (planted.kind !== "project") continue;
      if (pathFiltered.has(planted.id) !== planted.needleInPath) pathFilterMatchMisses += 1;
    }
  }

  return { rankMisses, scoreMisses, filterMatchMisses, pathFilterMatchMisses };
}

export interface SwitcherSessionRun {
  readonly freeze: FreezeObservation;
  readonly keystrokes: KeystrokeObservation[];
}

export interface SwitcherSessionSummary {
  readonly misses: KeystrokeMisses & { activityMisses: number };
  readonly keystrokeCount: number;
  readonly resultRowCount: number;
  readonly perKeystrokeMs: number[];
  readonly rankMs: number;
  readonly filterMs: number;
  readonly scoreMs: number;
  readonly freezeMs: number;
}

/**
 * One palette session: freeze the activity snapshot once, then run the typed
 * sequence against it — the order `useProjectSwitcherPalette` does it in.
 *
 * **This is the timed bracket, and it contains the subjects and nothing else.**
 * The loop calls {@link runKeystroke} and appends the observation it returns; no
 * oracle runs here, nothing is compared and no tally is kept. Grading and the
 * per-keystroke sums are {@link gradeSwitcherSession}, which the scenarios call
 * after they have read `performance.now()` a second time.
 *
 * The recording cost that could not be moved out is the per-row id append inside
 * the filter and score loops, which is where a per-row verdict is observable at
 * all, plus one array push per keystroke.
 */
export function runSwitcherSession(
  fixture: SwitcherFixture,
  steps: readonly KeystrokeStep[],
  subjects: SwitcherSubjects = REAL_SWITCHER_SUBJECTS
): SwitcherSessionRun {
  const freeze = runActivityFreeze(fixture, subjects);
  const keystrokes: KeystrokeObservation[] = [];
  for (const keystroke of steps) {
    keystrokes.push(runKeystroke(fixture, keystroke, freeze.keys, subjects));
  }
  return { freeze, keystrokes };
}

/**
 * Tally and grade a finished session — **after the clock has stopped**.
 *
 * The activity freeze is graded here too: `captureSearchActivity` runs once per
 * open, but reading its map back against the planted demand ladder is oracle
 * work either way.
 */
export function gradeSwitcherSession(
  fixture: SwitcherFixture,
  run: SwitcherSessionRun
): SwitcherSessionSummary {
  const activityMisses = gradeActivityFreeze(fixture, run.freeze);

  const perKeystrokeMs: number[] = [];
  let rankMisses = 0;
  let scoreMisses = 0;
  let filterMatchMisses = 0;
  let pathFilterMatchMisses = 0;
  let resultRowCount = 0;
  let rankMs = 0;
  let filterMs = 0;
  let scoreMs = 0;

  for (const observation of run.keystrokes) {
    perKeystrokeMs.push(observation.rankMs + observation.filterMs + observation.scoreMs);
    resultRowCount += observation.results.length;
    rankMs += observation.rankMs;
    filterMs += observation.filterMs;
    scoreMs += observation.scoreMs;

    const graded = gradeKeystroke(fixture, observation);
    rankMisses += graded.rankMisses;
    scoreMisses += graded.scoreMisses;
    filterMatchMisses += graded.filterMatchMisses;
    pathFilterMatchMisses += graded.pathFilterMatchMisses;
  }

  return {
    misses: {
      rankMisses,
      scoreMisses,
      filterMatchMisses,
      pathFilterMatchMisses,
      activityMisses,
    },
    keystrokeCount: run.keystrokes.length,
    resultRowCount,
    perKeystrokeMs,
    rankMs,
    filterMs,
    scoreMs,
    freezeMs: run.freeze.freezeMs,
  };
}

const fixtureCache = new Map<string, SwitcherFixture>();

/** Built once per shape and reused: corpus construction is not the subject. */
export function getSwitcherFixture(projectCount: number, scratchCount: number): SwitcherFixture {
  const key = `${projectCount}:${scratchCount}`;
  let fixture = fixtureCache.get(key);
  if (!fixture) {
    fixture = buildSwitcherFixture(projectCount, scratchCount);
    fixtureCache.set(key, fixture);
  }
  return fixture;
}
