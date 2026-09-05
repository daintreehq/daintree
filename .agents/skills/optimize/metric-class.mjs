/**
 * Which metrics survive a cross-machine comparison.
 *
 * This is a MIRROR of `scripts/perf/lib/comparability.ts`. The harness is the
 * authority; this copy exists because `check-pair.mjs` is plain Node run by an
 * agent with no build step, and the authority is TypeScript inside the app's
 * project graph. `scripts/perf/__tests__/optimizeMetricClass.test.ts` asserts
 * the two agree on every metric name the matrix emits plus a trap corpus, so a
 * rule added there and not here fails the suite rather than silently granting a
 * duration a comparison it cannot support.
 *
 * Rule order is load-bearing and identical to the authority's: time beats
 * everything, runtime-derived proportion beats structural ratio and memory,
 * memory beats size, ratio beats count. Read that file for why each ordering
 * exists — the reasoning is not duplicated here, only the behaviour.
 */

/** @typedef {"count"|"size"|"ratio"|"memory"|"duration"|"derived-ratio"|"unknown"} ComparabilityClass */

/** @type {ReadonlyArray<{cls: ComparabilityClass, pattern: RegExp}>} */
const RULES = [
  {
    cls: "duration",
    pattern:
      /(^(ms|us)[A-Z0-9])|([a-z0-9](Ms|Us|Sec|Secs)([A-Z0-9]|$))|[Ll]atency|[Dd]uration|[Ee]lapsed|(^|[a-z])[Tt]ime([A-Z]|$)/,
  },
  {
    cls: "derived-ratio",
    pattern:
      /[Uu]tili[sz]ation|[Dd]egradationX?$|[Ss]peedup|[Oo]verhead|[Cc]oldToWarm|[Bb]locking[Rr]atio|[Dd]etectionToInterval|((?=.*([Cc]pu|[Hh]eap|[Rr]ss|[Mm]emory|[Ff]ootprint|[Ll]oadAvg|[a-z0-9]Load([A-Z0-9]|$)|^elu|[a-z0-9]Elu([A-Z0-9]|$)))(?=.*([Pp]ct$|[Pp]ercent|[Ff]raction|[a-z0-9]Ratio|[a-z0-9]Per[A-Z])).*)/,
  },
  {
    cls: "ratio",
    pattern: /(^ratio|[a-z0-9]Ratio)|[Pp]ct$|[Pp]ercent|[Ff]raction|([a-z0-9]Per[A-Z])/,
  },
  { cls: "memory", pattern: /[Hh]eap|[Rr]ss|[Mm]emory|[Ff]ootprint|([a-z0-9](Mb|Gb)([A-Z0-9]|$))/ },
  {
    cls: "size",
    pattern: /[Bb]ytes|([a-z0-9](KB|Kb|KiB|MiB)([A-Z0-9]|$))|[Ss]ize$|^size/,
  },
  {
    cls: "count",
    pattern:
      /[Cc]ount|[Rr]ows|[Ss]pawns|[Ss]tarts|[Ll]aunches|[Ii]nvocations|[Rr]etries|[Cc]alls|[Hh]its|[Mm]isses|[Ee]vents|[Ff]lushes|[Rr]enders|[Mm]essages|[Tt]asks|[Hh]andles|[Dd]escriptors|[Ww]rites|[Rr]eads|[Pp]asses|[Aa]ttempts|[Cc]allbacks|[Kk]eystrokes|[Rr]oundTrips|[Ll]ines|[Pp]anels|[Gg]roups|[Hh]unks|[Tt]argets|[Ff]rames|[Ff]iles|[Tt]okens|[Dd]ecorations|[Cc]hanges|[Bb]atches|[Ii]tems|[Rr]esolved|[Rr]eloads|[Jj]obs|[Pp]osted|[Rr]equests|[Cc]opies/,
  },
];

/**
 * Classify a metric by its name.
 *
 * @param {string} metricName
 * @returns {ComparabilityClass}
 */
export function classifyMetric(metricName) {
  for (const rule of RULES) {
    if (rule.pattern.test(metricName)) return rule.cls;
  }
  return "unknown";
}

/**
 * Whether two runs on DIFFERENT machines can be compared on this class.
 *
 * `unknown` is machine-dependent on purpose: a metric nothing recognised is the
 * one most likely to be a duration under an unfamiliar name.
 *
 * @param {ComparabilityClass} cls
 */
export function isMachineIndependent(cls) {
  return cls === "count" || cls === "size" || cls === "ratio";
}

/**
 * The metric name inside a target path, or the path itself when it is not a
 * `metricStats.<name>.<stat>` reference.
 *
 * `p50Ms`, `p95Ms` and `meanMs` are aggregate-level fields rather than metrics,
 * and they classify correctly as durations by their own names.
 *
 * @param {string} targetPath
 */
export function metricNameOf(targetPath) {
  return targetPath.startsWith("metricStats.")
    ? (targetPath.split(".")[1] ?? targetPath)
    : targetPath;
}

/**
 * Classify a `check-pair` target path.
 *
 * @param {string} targetPath
 * @returns {ComparabilityClass}
 */
export function classifyTarget(targetPath) {
  return classifyMetric(metricNameOf(targetPath));
}
