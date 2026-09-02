import type { RunEnvironment } from "../types";

/**
 * How safely a measurement can be compared between two runs.
 *
 * This is the distinction the harness previously did not make, and it is the one
 * that matters most for a workflow spanning a Mac and a Windows laptop. Reading
 * a machine-dependent number as machine-independent is how "Windows is 80%
 * slower" gets reported when what was actually measured is two laptops.
 */
export type ComparabilityClass =
  /** Deterministic event tally. Machine-independent — compare raw. */
  | "count"
  /** Deterministic byte size of a payload. Machine-independent. */
  | "size"
  /**
   * A proportion between two deterministic quantities — bytes against bytes,
   * spawns against worktrees. Normalising two machine-independent numbers
   * leaves a machine-independent number.
   */
  | "ratio"
  /**
   * A proportion whose numerator or denominator is itself machine-dependent:
   * CPU occupancy, event-loop utilization, retained-heap growth percentages.
   *
   * Dividing by a run's own duration or its own starting heap does NOT remove
   * the machine from the figure — it changes the units it is wrong in. A slower
   * CPU raises event-loop utilization for identical work, and a different
   * allocator moves `memoryGrowthPct` with no code change at all. An earlier
   * version of this module classified every `Pct` and `Utilization` as `ratio`
   * and would have licensed exactly the cross-laptop claim the module exists to
   * prevent.
   */
  | "derived-ratio"
  /** Wall-clock or CPU time. Only meaningful against itself on ONE machine. */
  | "duration"
  /**
   * Runtime heap/RSS measurement. Deliberately NOT grouped with `size`: a
   * payload's byte length is arithmetic, whereas retained heap depends on GC
   * timing, allocator behaviour and pointer width, none of which survive a
   * platform change. Comparable run-to-run on one machine; indicative only
   * across machines.
   */
  | "memory"
  /** Unrecognised — treated as machine-dependent, the safe default. */
  | "unknown";

/**
 * Whether a class may be compared across machines.
 *
 * `unknown` is deliberately excluded: an unclassified metric gets the
 * conservative answer, so adding a metric with a novel name loses a comparison
 * rather than inventing a false one.
 */
export function isMachineIndependent(cls: ComparabilityClass): boolean {
  return cls === "count" || cls === "size" || cls === "ratio";
}

/**
 * Ordered classification rules. Order is load-bearing and the sequence is
 * chosen so the *unsafe* direction of every ambiguity is impossible:
 *
 * 1. Time units win over everything. `msPerKFile` and `cpuMsPerMb30` are rates
 *    whose numerator is time, so they move with the machine. An earlier
 *    suffix-only version classified `msPerKAction` as a count purely because it
 *    ended in "n", which would have granted a latency figure cross-machine
 *    comparison — the exact error this module exists to prevent.
 * 2. Memory before size, so `heapDeltaMb` is not read as a deterministic byte
 *    count.
 * 3. Runtime-derived ratio before structural ratio AND before memory, so
 *    `memoryGrowthPct` is machine-dependent rather than either a free
 *    comparison or a raw heap reading.
 * 4. Ratio before count, so `spawnsPerWorktreeN50` and `detectionToIntervalRatio`
 *    are not read as tallies.
 *
 * Unit tokens are matched anywhere in the name (with a word boundary), not just
 * as a suffix, because this codebase names metrics `applyMsN50` and `worstMs380`
 * as often as it names them `latencyMs`.
 */
// Unit tokens are matched CASE-SENSITIVELY as camelCase segments (`Ms`, `Us`,
// `Mb`), or lowercase only at the very start of a name (`msPerKFile`). A
// case-insensitive version of these rules is actively dangerous, and every one
// of these was a real misfire caught by the table test below:
//   "items"        → `ms` at the end → duration
//   "statusPasses" → `us` in "status" → duration
//   "decorations"  → "ratio" inside "decorations" → ratio
// Word-ish anchoring plus case sensitivity removes all three without needing an
// explicit per-metric registry, which would classify every newly added metric
// as `unknown` and quietly lose its comparison.
const RULES: ReadonlyArray<{ cls: ComparabilityClass; pattern: RegExp }> = [
  // Time. `Ms`/`Us`/`Sec` as camelCase segments, or leading `ms`/`us`.
  {
    cls: "duration",
    pattern:
      /(^(ms|us)[A-Z0-9])|([a-z0-9](Ms|Us|Sec|Secs)([A-Z0-9]|$))|[Ll]atency|[Dd]uration|[Ee]lapsed|(^|[a-z])[Tt]ime([A-Z]|$)/,
  },
  // Runtime-derived proportions, ahead of both `ratio` and `memory`. A
  // percentage over a machine-dependent base stays machine-dependent, so
  // `memoryGrowthPct`, `cpuPct` and `eventLoopUtilization` are caught here
  // BEFORE the structural-ratio rule can grant them cross-machine comparison.
  //
  // The test is a CONJUNCTION on purpose — a runtime base AND a proportional
  // form. A base alone is not a ratio (`heapDeltaMb` is a memory reading and
  // must stay one), and a proportional form alone is not machine-dependent
  // (`spawnsPerWorktree` divides two tallies and compares freely). Utilization
  // is the one word that carries both halves by itself: there is no such thing
  // as a machine-independent event-loop utilization.
  //
  // `Load` is anchored the way the unit tokens are, for the same reason: a bare
  // `[Ll]oad` finds "load" inside "payload", which would read a deterministic
  // `payloadBytesPerMessage` as a machine-dependent figure and lose its
  // cross-machine comparison.
  //
  // `Elu` is in the base group because the scenarios spell event-loop
  // utilization both ways: `eluUtilization` matches the word and `idleEluPct`
  // does not, so without the abbreviation the same quantity was machine-
  // independent under one name and machine-dependent under the other. That is
  // how "Windows idle ELU 12%, macOS 3%" gets reported as a finding.
  //
  // `Blocked` and `Stall` are in the base group for the same reason as `Elu`,
  // and were added when the bystander probe (`lib/bystander.ts`) started
  // emitting `loadBlockedPct` and `workerBlockedPct`. Those divide time the main
  // thread was unavailable by the length of the window — two runtime durations —
  // yet without a base token they fell through to structural `ratio` and were
  // marked "compare freely". A slower CPU raises blocked-time percentage for
  // identical work, so "Windows 60% blocked, macOS 12%" would have been
  // presented as a portable finding about the code.
  //
  // Speedups, overheads and cold/warm comparisons are here for the same reason
  // one rule up: their operands are two measured DURATIONS. `coldToWarmRatio`
  // divides two `p99SearchMs` readings and `batchSpeedupRatio` divides two
  // transaction times. A speedup is more portable than either duration alone —
  // that is exactly why it is tempting — but "more portable" is not the class
  // boundary. Cache hierarchy, core count and IO make a 3.2x on one machine a
  // different number on another, and the contract for `ratio` is that BOTH
  // operands are machine-independent. These fail it, so they are reported as
  // what they are rather than granted a comparison the harness cannot back.
  {
    cls: "derived-ratio",
    pattern:
      /[Uu]tili[sz]ation|[Dd]egradationX?$|[Ss]peedup|[Oo]verhead|[Cc]oldToWarm|[Bb]locking[Rr]atio|[Dd]etectionToInterval|((?=.*([Cc]pu|[Hh]eap|[Rr]ss|[Mm]emory|[Ff]ootprint|[Ll]oadAvg|[a-z0-9]Load([A-Z0-9]|$)|^elu|[a-z0-9]Elu([A-Z0-9]|$)|[Bb]locked|[Ss]tall))(?=.*([Pp]ct$|[Pp]ercent|[Ff]raction|[a-z0-9]Ratio|[a-z0-9]Per[A-Z])).*)/,
  },
  // Structural proportions and per-unit rates over deterministic quantities.
  // `Ratio` is capitalised or leading, never the substring inside "decorations".
  {
    cls: "ratio",
    pattern: /(^ratio|[a-z0-9]Ratio)|[Pp]ct$|[Pp]ercent|[Ff]raction|([a-z0-9]Per[A-Z])/,
  },
  // Runtime memory, ahead of deterministic size.
  { cls: "memory", pattern: /[Hh]eap|[Rr]ss|[Mm]emory|[Ff]ootprint|([a-z0-9](Mb|Gb)([A-Z0-9]|$))/ },
  // Deterministic payload size.
  {
    cls: "size",
    pattern: /[Bb]ytes|([a-z0-9](KB|Kb|KiB|MiB)([A-Z0-9]|$))|[Ss]ize$|^size/,
  },
  // Tallies. Plain word matching is safe here: it runs last, so anything a
  // stronger rule wanted has already been claimed.
  {
    cls: "count",
    pattern:
      /[Cc]ount|[Ss]pawns|[Ss]tarts|[Ii]nvocations|[Rr]etries|[Cc]alls|[Hh]its|[Mm]isses|[Ee]vents|[Ff]lushes|[Rr]enders|[Mm]essages|[Tt]asks|[Hh]andles|[Dd]escriptors|[Ww]rites|[Rr]eads|[Pp]asses|[Aa]ttempts|[Cc]allbacks|[Kk]eystrokes|[Rr]oundTrips|[Ll]ines|[Pp]anels|[Gg]roups|[Hh]unks|[Tt]argets|[Ff]rames|[Ff]iles|[Tt]okens|[Dd]ecorations|[Cc]hanges|[Bb]atches|[Ii]tems|[Rr]esolved/,
  },
];

/** Classify a metric by its name. */
export function classifyMetric(metricName: string): ComparabilityClass {
  for (const rule of RULES) {
    if (rule.pattern.test(metricName)) return rule.cls;
  }
  return "unknown";
}

/**
 * Short marker for report tables. `≡` reads as "compare freely", `~` as
 * "compare only against itself".
 *
 * Deliberately two markers and not three, now that `derived-ratio` gives a
 * second reason for `~`. The marker answers one question — may this number be
 * carried to another machine? — and that question is binary. A third glyph for
 * "machine-dependent, but it looks portable" invites a partly-comparable
 * reading, which is the exact mistake this module exists to prevent. The class
 * name is rendered beside the marker in both renderers and is where the reason
 * belongs.
 */
export function comparabilityMarker(cls: ComparabilityClass): string {
  return isMachineIndependent(cls) ? "≡" : "~";
}

/**
 * Whether two runs' machine-dependent figures may be compared at all.
 *
 * Machine label is the whole test. Two runs on the same host at different times
 * still differ in thermal state and background load, but that is noise around a
 * real comparison; two runs on different hosts are not a comparison.
 */
export function durationsComparable(a: RunEnvironment, b: RunEnvironment): boolean {
  return a.machineLabel === b.machineLabel && a.platform === b.platform && a.arch === b.arch;
}

/** Human-readable reason a machine-dependent comparison was refused. */
export function describeIncomparability(a: RunEnvironment, b: RunEnvironment): string {
  if (a.machineLabel !== b.machineLabel) {
    return `different machines (${a.machineLabel} vs ${b.machineLabel})`;
  }
  if (a.platform !== b.platform) return `different platforms (${a.platform} vs ${b.platform})`;
  return `different architectures (${a.arch} vs ${b.arch})`;
}
