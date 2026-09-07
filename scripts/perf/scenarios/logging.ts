import { performance } from "node:perf_hooks";

import type { PerfScenario, ScenarioSample } from "../types";
import {
  ARRAY_ROW_COUNT,
  arrayCapMarker,
  assertInsideTempRoot,
  buildCleanMessage,
  buildContext,
  buildProbeHitMessage,
  buildSecretMessage,
  buildSmallContext,
  coreMisses,
  countAcrossFiles,
  countOccurrences,
  DEEP_CHAIN_DEPTH,
  DEPTH_CAP_MARKER,
  emptyCoreGrade,
  gradeCore,
  loadLoggingHarness,
  readTrailingContext,
  readTrailingContextRaw,
  REDACTION_MARKER,
  SECRET_PLANTS,
  SURVIVOR_MARKER,
  SURVIVOR_MARKER_CONTEXT,
  WIDE_KEY_COUNT,
  type ContextShape,
  type CoreGrade,
  type LogFile,
  type LoggingHarness,
} from "../lib/loggingFixture";

/**
 * The main-process log emit path — `electron/utils/logger.ts` — which the file's
 * own comment describes as the dominant event-loop stall under multi-agent load
 * before #10769, and which had no coverage at all.
 *
 * Every line a busy session writes walks the same chain: `redactSensitiveData`
 * over the context (key gate, depth clamp, array cap), `clampLogString` on every
 * string it finds, `scrubSecrets` — roughly sixty regex passes once its pre-scan
 * probe hits — `safe-stable-stringify` at indent 2, a second `scrubSecrets` over
 * the whole serialized context, then the batched append (or, for an ERROR line,
 * a synchronous one). At hundreds of lines per second all of it is on the main
 * thread.
 *
 * `lib/loggingFixture.ts` states what is real and what is not. The two limits to
 * carry into every reading here: **the renderer broadcast is not in the frame**
 * (no transport is registered, so `sendLogToRenderer` returns immediately), and
 * **the console transport is a counting sink**, so its `util.format` and stream
 * write are outside the numbers while its argument construction is inside.
 *
 * Every scenario declares the same nine core predicates plus its own — one
 * accumulator per operation the path performs on every line, because a single
 * aggregate cannot see one of them deleted. The pair that matters most is
 * two-sided by construction: ZERO planted synthetic secrets may survive to disk,
 * AND every planted non-secret marker must. A scrubber stubbed to redact
 * everything clears the first alone; one stubbed to redact nothing clears the
 * second alone.
 */

/** Warmup passes before any measured iteration; the regex path is JIT-sensitive. */
const WARMUPS = 2;

/**
 * Bytes a single batch may buffer before `writeToLogFile`'s own safety valve
 * (`ASYNC_FLUSH_MAX_PENDING_BYTES`, 256 KiB) drains it with a SYNCHRONOUS append
 * mid-bracket. Every arm below is batched under this and flushed between
 * batches, off the clock, so the emit numbers are the emit path and not one
 * arm's luck with where the valve happened to fire.
 */
const BATCH_BYTE_BUDGET = 192 * 1024;

const CORE_CORRECTNESS = [
  "levelGateMisses",
  "keyRedactionMisses",
  "clampMisses",
  "bufferMisses",
  "stringifyMisses",
  "secretSurvivalMisses",
  "markerSurvivalMisses",
  "lineCountMisses",
  "consoleMirrorMisses",
] as const;

// --- Arms --------------------------------------------------------------------

type EmitKind = "info" | "errorBare" | "errorRich";

/**
 * One pre-built entry, with everything the predicates need to expect from it
 * computed here rather than inside a timed loop.
 */
interface CorpusEntry {
  message: string;
  context: Record<string, unknown>;
  /** Occurrences of the survivor marker in this entry's own inputs. */
  markers: number;
  contextMarkers: number;
  /** Synthetic secrets planted in this entry, each of which must be redacted. */
  plants: number;
  error?: unknown;
}

interface ArmTiming {
  ms: number;
  /** Time spent draining the batched buffer to disk, measured outside `ms`. */
  flushMs: number;
  entries: number;
  markers: number;
  contextMarkers: number;
  plants: number;
}

function emptyArm(): ArmTiming {
  return { ms: 0, flushMs: 0, entries: 0, markers: 0, contextMarkers: 0, plants: 0 };
}

/**
 * Build one entry and count what it plants, from this fixture's own inputs.
 *
 * Counted here and added up at the call site inside the loop — never asserted
 * as a literal, and never read back out of the subject.
 */
function makeEntry(
  message: string,
  context: Record<string, unknown>,
  plants: number,
  error?: unknown
): CorpusEntry {
  const contextJson = JSON.stringify(context);
  return {
    message,
    context,
    markers:
      countOccurrences(message, SURVIVOR_MARKER) + countOccurrences(contextJson, SURVIVOR_MARKER),
    contextMarkers:
      countOccurrences(message, SURVIVOR_MARKER_CONTEXT) +
      countOccurrences(contextJson, SURVIVOR_MARKER_CONTEXT),
    plants,
    ...(error === undefined ? {} : { error }),
  };
}

/**
 * Drive one arm.
 *
 * The only bookkeeping inside the bracket is four integer adds per entry. The
 * flush between batches is awaited OUTSIDE the bracket: the INFO path defers its
 * write to a `setImmediate` by design, and folding that wait into a per-entry
 * emit cost would report the deferral as though it had not happened.
 */
async function driveArm(
  harness: LoggingHarness,
  corpus: readonly CorpusEntry[],
  count: number,
  batch: number,
  kind: EmitKind
): Promise<ArmTiming> {
  const arm = emptyArm();
  let index = 0;
  while (arm.entries < count) {
    const chunk = Math.min(batch, count - arm.entries);
    const started = performance.now();
    for (let step = 0; step < chunk; step += 1) {
      const entry = corpus[index % corpus.length]!;
      index += 1;
      if (kind === "info") harness.emit("info", entry.message, entry.context);
      else if (kind === "errorBare") harness.emitError(entry.message, undefined, entry.context);
      else harness.emitError(entry.message, entry.error, entry.context);
      arm.entries += 1;
      arm.markers += entry.markers;
      arm.contextMarkers += entry.contextMarkers;
      arm.plants += entry.plants;
    }
    arm.ms += performance.now() - started;
    const flushStarted = performance.now();
    await harness.flush();
    arm.flushMs += performance.now() - flushStarted;
  }
  return arm;
}

function perEntryUs(arm: ArmTiming): number {
  return arm.entries > 0 ? (arm.ms * 1000) / arm.entries : 0;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function totalMs(arms: readonly ArmTiming[]): number {
  return arms.reduce((sum, arm) => sum + arm.ms, 0);
}

function totalEntries(arms: readonly ArmTiming[]): number {
  return arms.reduce((sum, arm) => sum + arm.entries, 0);
}

/**
 * Grade the timed corpus against the tallies the arms accumulated at the call
 * site, and fold the result into the core terms.
 */
function gradeCorpus(
  harness: LoggingHarness,
  core: CoreGrade,
  arms: readonly ArmTiming[],
  consoleCount: number
): LogFile[] {
  const files = harness.readLogFiles();
  const emitted = harness.emittedEntryCount();

  core.lineCountMisses += Math.abs(countAcrossFiles(files, harness.token()) - emitted);
  core.consoleMirrorMisses += Math.abs(consoleCount - emitted);

  for (const plant of SECRET_PLANTS) {
    core.secretSurvivalMisses += countAcrossFiles(files, plant.literal);
  }

  const markers = arms.reduce((sum, arm) => sum + arm.markers, 0);
  const contextMarkers = arms.reduce((sum, arm) => sum + arm.contextMarkers, 0);
  core.markerSurvivalMisses +=
    Math.abs(countAcrossFiles(files, SURVIVOR_MARKER) - markers) +
    Math.abs(countAcrossFiles(files, SURVIVOR_MARKER_CONTEXT) - contextMarkers);

  return files;
}

function fileBytes(files: readonly LogFile[]): number {
  return files.reduce((sum, file) => sum + file.bytes, 0);
}

/** A measurement that did not happen, reported as misses rather than thrown. */
function failClosed(notes: string, metrics: Record<string, number>): ScenarioSample {
  return { durationMs: 0, metrics, notes };
}

// --- Corpora -----------------------------------------------------------------

/**
 * Built once per process and reused across iterations. Nothing is built at
 * module import — the lazy-fixture rule — so importing this module allocates
 * nothing, and a 32 KiB corpus rebuilt sixteen times is not in the duration.
 *
 * Reuse is safe because the entry token is process-stable while every iteration
 * writes into a freshly minted, empty log directory.
 */
const CORPUS_VARIANTS = 16;

interface SizeClass {
  label: string;
  bytes: number;
  entries: number;
  batch: number;
  corpus: CorpusEntry[];
}

/**
 * A log-spaced sweep across the line lengths real agent logging produces: a
 * status line, a git summary, a command tail, and the kind of stdout excerpt a
 * failing agent turn drops into a context field.
 */
const SIZE_SWEEP_SPEC: ReadonlyArray<{ label: string; bytes: number; entries: number }> = [
  { label: "64B", bytes: 64, entries: 400 },
  { label: "512B", bytes: 512, entries: 300 },
  { label: "4KiB", bytes: 4 * 1024, entries: 120 },
  { label: "32KiB", bytes: 32 * 1024, entries: 40 },
];

let sizeSweep: SizeClass[] | null = null;

function getSizeSweep(harness: LoggingHarness): SizeClass[] {
  sizeSweep ??= SIZE_SWEEP_SPEC.map((spec) => ({
    ...spec,
    batch: Math.max(1, Math.floor(BATCH_BYTE_BUDGET / spec.bytes)),
    corpus: Array.from({ length: CORPUS_VARIANTS }, (_, seq) =>
      makeEntry(buildCleanMessage(harness.token(), seq, spec.bytes), buildSmallContext(), 0)
    ),
  }));
  return sizeSweep;
}

/** Arms in emission order; `wide` runs LAST so its context is parseable at EOF. */
const CONTEXT_SHAPES: readonly ContextShape[] = ["flat", "deep", "array", "wide"];
const CONTEXT_MESSAGE_BYTES = 128;
const CONTEXT_ENTRIES = 200;

let contextCorpus: Map<ContextShape, CorpusEntry[]> | null = null;

function getContextCorpus(harness: LoggingHarness): Map<ContextShape, CorpusEntry[]> {
  if (contextCorpus === null) {
    contextCorpus = new Map();
    for (const shape of CONTEXT_SHAPES) {
      contextCorpus.set(
        shape,
        Array.from({ length: CORPUS_VARIANTS }, (_, seq) =>
          makeEntry(
            `${harness.token()} ${SURVIVOR_MARKER} ${shape} ${seq} `.padEnd(
              CONTEXT_MESSAGE_BYTES,
              "."
            ),
            buildContext(shape),
            0
          )
        )
      );
    }
  }
  return contextCorpus;
}

/** Every density arm carries the same message bytes, so only the content differs. */
const DENSITY_MESSAGE_BYTES = 1024;
const DENSITY_ENTRIES = 200;
const DENSITY_BATCH = Math.floor(BATCH_BYTE_BUDGET / DENSITY_MESSAGE_BYTES);

type DensityArm = "clean" | "probeHit" | "single" | "dense";

const DENSITY_PLANTS: Readonly<Record<DensityArm, number>> = {
  clean: 0,
  probeHit: 0,
  single: 1,
  dense: SECRET_PLANTS.length,
};

let densityCorpus: Map<DensityArm, CorpusEntry[]> | null = null;

function getDensityCorpus(harness: LoggingHarness): Map<DensityArm, CorpusEntry[]> {
  if (densityCorpus === null) {
    densityCorpus = new Map();
    const token = harness.token();
    const build = (arm: DensityArm, seq: number): string => {
      if (arm === "clean") return buildCleanMessage(token, seq, DENSITY_MESSAGE_BYTES);
      if (arm === "probeHit") return buildProbeHitMessage(token, seq, DENSITY_MESSAGE_BYTES);
      return buildSecretMessage(token, seq, DENSITY_MESSAGE_BYTES, DENSITY_PLANTS[arm]);
    };
    for (const arm of ["clean", "probeHit", "single", "dense"] as const) {
      densityCorpus.set(
        arm,
        Array.from({ length: CORPUS_VARIANTS }, (_, seq) =>
          makeEntry(build(arm, seq), buildSmallContext(), DENSITY_PLANTS[arm])
        )
      );
    }
  }
  return densityCorpus;
}

/** The rotation and error arms share one 512 B line shape. */
const LINE_BYTES = 512;
const LINE_BATCH = Math.floor(BATCH_BYTE_BUDGET / LINE_BYTES);
const LINE_ENTRIES = 300;

/** PERF-383: the no-rotation control, and how many boundary crossings to price. */
const STEADY_ERROR_ENTRIES = 200;
const ROTATION_ROUNDS = 3;

/**
 * Seeded into `daintree.log.1` … `.4` before each rotation round.
 *
 * Distinct and sigil-free, so the ladder's movement is readable from the files
 * alone: after one rotation each of the first three must sit exactly one slot
 * lower, and the fourth must be gone rather than shifted off the end.
 */
const LADDER_MARKERS: readonly string[] = [
  "zz-rot-one-zz",
  "zz-rot-two-zz",
  "zz-rot-three-zz",
  "zz-rot-four-zz",
];

/** PERF-384 probe markers. Sigil-free, so the scrubber must leave them alone. */
const TOP_ERROR_MARKER = "zz-toperror-zz";
const NESTED_ERROR_MARKER = "zz-nestederror-zz";
const DEFERRED_PROBE_MARKER = "zz-deferred-probe-zz";
const DURABLE_PROBE_MARKER = "zz-durable-probe-zz";

let lineCorpus: CorpusEntry[] | null = null;

function getLineCorpus(harness: LoggingHarness): CorpusEntry[] {
  lineCorpus ??= Array.from({ length: CORPUS_VARIANTS }, (_, seq) =>
    makeEntry(
      buildCleanMessage(harness.token(), seq, LINE_BYTES),
      buildSmallContext(),
      0,
      new Error(`perf logging benchmark failure ${seq}`)
    )
  );
  return lineCorpus;
}

// --- Scenarios ---------------------------------------------------------------

export const loggingScenarios: PerfScenario[] = [
  {
    id: "PERF-380",
    name: "Log Emit Cost by Line Length",
    description:
      "Per-entry cost of the real main-process emit path across a 64 B → 32 KiB message sweep on secret-free lines, driving electron/utils/logger.ts unmodified: the real redactSensitiveData walk, the real clampLogString, the real scrubSecrets pre-scan, the real safe-stable-stringify and the real batched append. Every log line the app writes pays this, so the slope against line length is the tax a busy multi-agent session carries hundreds of times a second. The batched write is flushed between batches OUTSIDE the bracket, so these are emit-path durations and the deferred write is reported separately as flushMs — the number that says how much of the cost #10769 moved rather than removed.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    warmups: WARMUPS,
    correctness: [...CORE_CORRECTNESS, "corpusShortfallCount"],
    async run() {
      const harness = await loadLoggingHarness();
      const core = await gradeCore(harness);

      await harness.resetCorpus();
      assertInsideTempRoot(harness.logDir());
      const sweep = getSizeSweep(harness);

      // The corpus is checked against this fixture's own byte arithmetic, not
      // against anything the subject reports — PERF-340's lesson, where a
      // registry shrank by 120 rows and the run got 1.45x faster in silence.
      let corpusShortfall = Math.max(0, SIZE_SWEEP_SPEC.length - sweep.length);
      for (const sizeClass of sweep) {
        for (const entry of sizeClass.corpus) {
          if (Buffer.byteLength(entry.message, "utf8") !== sizeClass.bytes) corpusShortfall += 1;
          if (countOccurrences(entry.message, harness.token()) !== 1) corpusShortfall += 1;
        }
      }

      const timings = new Map<string, ArmTiming>();
      const restoreConsole = harness.captureConsole();
      let consoleCount: number;
      try {
        for (const sizeClass of sweep) {
          const arm = await driveArm(
            harness,
            sizeClass.corpus,
            sizeClass.entries,
            sizeClass.batch,
            "info"
          );
          timings.set(sizeClass.label, arm);
        }
      } finally {
        consoleCount = restoreConsole();
      }

      const arms = [...timings.values()];
      const flushMs = arms.reduce((sum, arm) => sum + arm.flushMs, 0);
      const files = gradeCorpus(harness, core, arms, consoleCount);

      const small = timings.get("64B");
      const large = timings.get("32KiB");
      if (!small || !large) {
        return failClosed("a size class never ran", {
          ...coreMisses({ ...emptyCoreGrade(), lineCountMisses: SIZE_SWEEP_SPEC.length }),
          corpusShortfallCount: SIZE_SWEEP_SPEC.length,
        });
      }

      const smallUs = perEntryUs(small);
      const largeUs = perEntryUs(large);
      const entries = totalEntries(arms);
      const emitMs = totalMs(arms);

      return {
        durationMs: emitMs,
        metrics: {
          entryCount: entries,
          messageBytesTotal: sweep.reduce((sum, cls) => sum + cls.bytes * cls.entries, 0),
          logBytesWritten: fileBytes(files),
          perEntryUs64B: smallUs,
          perEntryUs512B: perEntryUs(timings.get("512B") ?? small),
          perEntryUs4KiB: perEntryUs(timings.get("4KiB") ?? small),
          perEntryUs32KiB: largeUs,
          lengthScalingOverheadRatio: ratio(largeUs, smallUs),
          flushMs,
          flushToEmitOverheadRatio: ratio(flushMs, emitMs),
          corpusShortfallCount: corpusShortfall,
          ...coreMisses(core),
        },
        notes: `a 32 KiB line costs ${ratio(largeUs, smallUs).toFixed(1)}x a 64 B one; the deferred write adds ${ratio(flushMs, emitMs).toFixed(2)}x on top`,
      };
    },
  },
  {
    id: "PERF-381",
    name: "Log Emit Cost by Context Shape",
    description:
      "The same short message with four context objects through the real redactSensitiveData walk: 12 flat keys, a 6-level chain that runs past MAX_REDACT_DEPTH, a 200-row array that runs past MAX_REDACT_ARRAY_ITEMS, and 200 shallow keys. This prices the walk itself plus the safe-stable-stringify pass over what survives it, and reports what the log actually costs on disk — the serializer runs at indent 2, so prettyToCompactByteRatio is the multiplier every context field pays in log volume. Graded in both directions on the two clamps: the depth marker and the array-cap marker must appear exactly once per entry of their own shape and not at all for the other two, so a walk that stopped clamping and a walk that clamped everything are separately caught.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    warmups: WARMUPS,
    correctness: [...CORE_CORRECTNESS, "clampEvidenceMisses"],
    async run() {
      const harness = await loadLoggingHarness();
      const core = await gradeCore(harness);

      await harness.resetCorpus();
      assertInsideTempRoot(harness.logDir());
      const corpus = getContextCorpus(harness);
      const batch = 24;

      const timings = new Map<ContextShape, ArmTiming>();
      const restoreConsole = harness.captureConsole();
      let consoleCount: number;
      try {
        for (const shape of CONTEXT_SHAPES) {
          const entries = corpus.get(shape);
          if (entries === undefined) continue;
          timings.set(shape, await driveArm(harness, entries, CONTEXT_ENTRIES, batch, "info"));
        }
        await harness.flush();
      } finally {
        consoleCount = restoreConsole();
      }

      const arms = [...timings.values()];
      const files = gradeCorpus(harness, core, arms, consoleCount);
      const text = files.map((file) => file.text).join("");

      // Both clamps, both directions. Expected counts come from the arms'
      // own entry tallies, so a shape that silently stopped running is a
      // shortfall rather than a faster number.
      const deepEntries = timings.get("deep")?.entries ?? 0;
      const arrayEntries = timings.get("array")?.entries ?? 0;
      const clampEvidenceMisses =
        Math.abs(countOccurrences(text, DEPTH_CAP_MARKER) - deepEntries) +
        Math.abs(countOccurrences(text, arrayCapMarker(ARRAY_ROW_COUNT)) - arrayEntries);

      const flat = timings.get("flat");
      if (!flat) {
        return failClosed("the flat control arm never ran", {
          ...coreMisses(emptyCoreGrade()),
          clampEvidenceMisses: CONTEXT_SHAPES.length,
        });
      }

      // The `wide` arm ran last, so its serialized context runs to end of file
      // and both its pretty and compact forms are readable without guessing
      // where the entry ends.
      const wideMessage = corpus.get("wide")?.[(CONTEXT_ENTRIES - 1) % CORPUS_VARIANTS]?.message;
      const rawContext =
        wideMessage === undefined ? null : readTrailingContextRaw(text, wideMessage);
      const parsedContext =
        wideMessage === undefined ? undefined : readTrailingContext(text, wideMessage);
      const prettyBytes = rawContext === null ? 0 : Buffer.byteLength(rawContext, "utf8");
      const compactBytes =
        parsedContext === undefined ? 0 : Buffer.byteLength(JSON.stringify(parsedContext), "utf8");

      const flatUs = perEntryUs(flat);
      const deepUs = perEntryUs(timings.get("deep") ?? flat);
      const wideUs = perEntryUs(timings.get("wide") ?? flat);

      return {
        durationMs: totalMs(arms),
        metrics: {
          entryCount: totalEntries(arms),
          contextShapeCount: timings.size,
          flatContextKeyCount: 12,
          wideContextKeyCount: WIDE_KEY_COUNT,
          deepContextDepthCount: DEEP_CHAIN_DEPTH,
          arrayContextRowCount: ARRAY_ROW_COUNT,
          logBytesWritten: fileBytes(files),
          serializedContextBytes: prettyBytes,
          compactContextBytes: compactBytes,
          prettyToCompactByteRatio: ratio(prettyBytes, compactBytes),
          perEntryUsFlat: flatUs,
          perEntryUsWide: wideUs,
          perEntryUsDeep: deepUs,
          perEntryUsArray: perEntryUs(timings.get("array") ?? flat),
          deepToFlatOverheadRatio: ratio(deepUs, flatUs),
          wideToFlatOverheadRatio: ratio(wideUs, flatUs),
          clampEvidenceMisses,
          ...coreMisses(core),
        },
        notes: `a ${WIDE_KEY_COUNT}-key context costs ${ratio(wideUs, flatUs).toFixed(2)}x a ${12}-key one, and indent-2 serialization writes ${ratio(prettyBytes, compactBytes).toFixed(2)}x the compact bytes`,
      };
    },
  },
  {
    id: "PERF-382",
    name: "Secret Scrubber Probe Miss vs Full Scan",
    description:
      "The dimension the emit path is actually shaped by. Four arms at byte-identical 1 KiB messages through the real shared/utils/secretScrubber.ts: a line with no sigil at all (the pre-scan probe MISS, which returns after one alternation pass), a line carrying probe sigils that complete no pattern (a probe HIT, so all ~60 replace passes run and redact nothing), a line with one synthetic secret, and a line with eight. The probe-hit arm is what separates the pre-scan from the scan — without it the clean/dense delta would report both as one number. Graded with a SIGNED redaction count: the number of [REDACTED] markers on disk must equal the number of synthetic secrets planted, so under-redaction and over-redaction are distinguishable, and the survivor marker must still be there beside them.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    warmups: WARMUPS,
    correctness: [...CORE_CORRECTNESS, "redactionCountDelta", "corpusShortfallCount"],
    async run() {
      const harness = await loadLoggingHarness();
      const core = await gradeCore(harness);

      await harness.resetCorpus();
      assertInsideTempRoot(harness.logDir());
      const corpus = getDensityCorpus(harness);

      let corpusShortfall = 0;
      for (const arm of ["clean", "probeHit", "single", "dense"] as const) {
        const entries = corpus.get(arm);
        if (entries === undefined) {
          corpusShortfall += 1;
          continue;
        }
        for (const entry of entries) {
          if (Buffer.byteLength(entry.message, "utf8") !== DENSITY_MESSAGE_BYTES) {
            corpusShortfall += 1;
          }
          if (entry.plants !== DENSITY_PLANTS[arm]) corpusShortfall += 1;
        }
      }

      const timings = new Map<DensityArm, ArmTiming>();
      const restoreConsole = harness.captureConsole();
      let consoleCount: number;
      try {
        for (const arm of ["clean", "probeHit", "single", "dense"] as const) {
          const entries = corpus.get(arm);
          if (entries === undefined) continue;
          timings.set(
            arm,
            await driveArm(harness, entries, DENSITY_ENTRIES, DENSITY_BATCH, "info")
          );
        }
        await harness.flush();
      } finally {
        consoleCount = restoreConsole();
      }

      const arms = [...timings.values()];
      const files = gradeCorpus(harness, core, arms, consoleCount);

      // Signed on purpose: positive means secrets reached disk unredacted,
      // negative means the scrubber redacted more than was planted. A single
      // absolute miss count could not tell those apart, and the report reads
      // both `min` and `max` for exactly this shape.
      const plantedSecretCount = arms.reduce((sum, arm) => sum + arm.plants, 0);
      const redactionCountDelta = plantedSecretCount - countAcrossFiles(files, REDACTION_MARKER);

      const clean = timings.get("clean");
      if (!clean) {
        return failClosed("the clean control arm never ran", {
          ...coreMisses(emptyCoreGrade()),
          redactionCountDelta: 0,
          corpusShortfallCount: 4,
        });
      }

      const cleanUs = perEntryUs(clean);
      const probeHitUs = perEntryUs(timings.get("probeHit") ?? clean);
      const denseUs = perEntryUs(timings.get("dense") ?? clean);

      return {
        durationMs: totalMs(arms),
        metrics: {
          entryCount: totalEntries(arms),
          messageBytesTotal: DENSITY_MESSAGE_BYTES * totalEntries(arms),
          logBytesWritten: fileBytes(files),
          patternPlantCount: SECRET_PLANTS.length,
          plantedSecretCount,
          perEntryUsClean: cleanUs,
          perEntryUsProbeHit: probeHitUs,
          perEntryUsSingle: perEntryUs(timings.get("single") ?? clean),
          perEntryUsDense: denseUs,
          probeHitToCleanOverheadRatio: ratio(probeHitUs, cleanUs),
          denseToCleanOverheadRatio: ratio(denseUs, cleanUs),
          redactionCountDelta,
          corpusShortfallCount: corpusShortfall,
          ...coreMisses(core),
        },
        notes: `a probe hit that redacts nothing costs ${ratio(probeHitUs, cleanUs).toFixed(2)}x a sigil-free line; eight secrets cost ${ratio(denseUs, cleanUs).toFixed(2)}x`,
      };
    },
  },
  {
    id: "PERF-383",
    name: "Log Rotation at the 5 MB Boundary",
    description:
      "What the entry that crosses ROTATION_MAX_SIZE costs, against an identical entry that does not. Each round seeds a real 5 MB daintree.log and a real four-deep rotation ladder in a fresh temp directory, then emits ONE line on the synchronous ERROR path so the rotation lands inside the timed bracket rather than inside a deferred flush. Graded structurally in both directions against the ladder the product documents: the live file must be fresh and under the boundary, daintree.log.1 must be exactly the 5 MB file that was there, each seeded marker must have moved down exactly one slot, the oldest must be GONE, and daintree.log.5 must never exist. A logger that never rotates and one that rotates the whole ladder away both score.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    warmups: WARMUPS,
    correctness: [...CORE_CORRECTNESS, "rotationMisses"],
    async run() {
      const harness = await loadLoggingHarness();
      const core = await gradeCore(harness);
      const corpus = getLineCorpus(harness);
      const boundaryBytes = harness.modules.ROTATION_MAX_SIZE;

      // Steady control: the same synchronous ERROR append with no rotation in
      // sight, so the ratio below is the rotation and not the write.
      await harness.resetCorpus();
      assertInsideTempRoot(harness.logDir());
      const restoreSteady = harness.captureConsole();
      let steady: ArmTiming;
      let steadyConsole: number;
      try {
        steady = await driveArm(harness, corpus, STEADY_ERROR_ENTRIES, LINE_BATCH, "errorBare");
      } finally {
        steadyConsole = restoreSteady();
      }
      await harness.flush();
      const steadyFiles = gradeCorpus(harness, core, [steady], steadyConsole);

      const rotating = emptyArm();
      let rotationMisses = 0;
      let rotationCount = 0;
      let liveBytesAfter = 0;

      for (let round = 0; round < ROTATION_ROUNDS; round += 1) {
        await harness.resetCorpus();
        assertInsideTempRoot(harness.logDir());
        harness.seedRotationLadder(boundaryBytes, LADDER_MARKERS);

        const restore = harness.captureConsole();
        let arm: ArmTiming;
        let roundConsole: number;
        try {
          arm = await driveArm(harness, corpus, 1, 1, "errorBare");
        } finally {
          roundConsole = restore();
        }
        await harness.flush();

        const files = gradeCorpus(harness, core, [arm], roundConsole);
        rotating.ms += arm.ms;
        rotating.entries += arm.entries;
        rotating.markers += arm.markers;
        rotating.contextMarkers += arm.contextMarkers;

        const byName = new Map(files.map((file) => [file.name, file]));
        const rotated = byName.get("daintree.log.1");
        const live = byName.get("daintree.log");

        // The 5 MB file that WAS `daintree.log` must now be `.1`, byte-exact.
        if (rotated === undefined || rotated.bytes !== boundaryBytes) rotationMisses += 1;
        else rotationCount += 1;
        // …and the live file must be a fresh one holding the new entry.
        if (live === undefined || live.bytes === 0 || live.bytes >= boundaryBytes) {
          rotationMisses += 1;
        }
        if (live === undefined || !live.text.includes(harness.token())) rotationMisses += 1;
        liveBytesAfter = live?.bytes ?? 0;

        // Each surviving marker moved down exactly one slot…
        for (let index = 0; index < LADDER_MARKERS.length - 1; index += 1) {
          const moved = byName.get(`daintree.log.${index + 2}`);
          if (moved === undefined || moved.text.trim() !== LADDER_MARKERS[index]) {
            rotationMisses += 1;
          }
        }
        // …and the oldest was deleted rather than shifted off the end.
        const oldest = LADDER_MARKERS[LADDER_MARKERS.length - 1]!;
        if (countAcrossFiles(files, oldest) !== 0) rotationMisses += 1;
        if (byName.has(`daintree.log.${harness.modules.ROTATION_MAX_FILES}`)) rotationMisses += 1;
      }

      if (rotating.entries === 0) {
        return failClosed("no rotation round ran", {
          ...coreMisses(emptyCoreGrade()),
          rotationMisses: ROTATION_ROUNDS,
        });
      }

      const steadyUs = perEntryUs(steady);
      const rotatingUs = perEntryUs(rotating);

      return {
        durationMs: steady.ms + rotating.ms,
        metrics: {
          entryCount: steady.entries + rotating.entries,
          rotationCount,
          rotationRoundCount: ROTATION_ROUNDS,
          rotationLadderFileCount: LADDER_MARKERS.length,
          rotationBoundaryBytes: boundaryBytes,
          steadyLogBytesWritten: fileBytes(steadyFiles),
          liveLogBytesAfterRotation: liveBytesAfter,
          perEntryUsSteadyError: steadyUs,
          perEntryUsRotatingError: rotatingUs,
          rotationOverheadRatio: ratio(rotatingUs, steadyUs),
          rotationMisses,
          ...coreMisses(core),
        },
        notes: `the entry that crosses ${boundaryBytes} bytes costs ${ratio(rotatingUs, steadyUs).toFixed(1)}x a steady one on the same synchronous path`,
      };
    },
  },
  {
    id: "PERF-384",
    name: "Batched Info Append vs Synchronous Error Append",
    description:
      "What #10769 actually bought, and what an ERROR line still pays. Three arms over the same 512 B line: a batched INFO entry (buffered, one async appendFile per event-loop turn), an ERROR entry with no error object (the same emit work plus a per-line appendFileSync), and an ERROR entry carrying a real Error (adding getErrorDetails and the serializeErrorForLog flattening that #11777 was about). Graded two ways off the clock. Durability is checked in both directions on one pass: an INFO entry must NOT be on disk before a flush, an ERROR entry must be there without one, and the buffered INFO entry must have been drained ahead of it — so a logger that made errors async and one that made info sync are separately caught. And a nested Error in a context object must reach the file with its message, name and stack, beside a benign value that survived unchanged.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    warmups: WARMUPS,
    correctness: [...CORE_CORRECTNESS, "errorDetailMisses", "syncDurabilityMisses"],
    async run() {
      const harness = await loadLoggingHarness();
      const core = await gradeCore(harness);
      const corpus = getLineCorpus(harness);
      const token = harness.token();

      await harness.resetCorpus();
      assertInsideTempRoot(harness.logDir());

      const detailProbe = makeEntry(
        `${token} ${SURVIVOR_MARKER} error detail probe`,
        { detail: SURVIVOR_MARKER_CONTEXT, nestedFailure: new Error(NESTED_ERROR_MARKER) },
        0,
        new Error(TOP_ERROR_MARKER)
      );

      const restoreMain = harness.captureConsole();
      let info: ArmTiming;
      let errorBare: ArmTiming;
      let errorRich: ArmTiming;
      let mainConsole: number;
      try {
        info = await driveArm(harness, corpus, LINE_ENTRIES, LINE_BATCH, "info");
        errorBare = await driveArm(harness, corpus, LINE_ENTRIES, LINE_BATCH, "errorBare");
        errorRich = await driveArm(harness, corpus, LINE_ENTRIES, LINE_BATCH, "errorRich");
        // LAST, so its pretty-printed context runs to end of file.
        harness.emitError(detailProbe.message, detailProbe.error, detailProbe.context);
      } finally {
        mainConsole = restoreMain();
      }
      await harness.flush();

      const probeArm: ArmTiming = {
        ms: 0,
        flushMs: 0,
        entries: 1,
        markers: detailProbe.markers,
        contextMarkers: detailProbe.contextMarkers,
        plants: 0,
      };
      const files = gradeCorpus(harness, core, [info, errorBare, errorRich, probeArm], mainConsole);
      const text = files.map((file) => file.text).join("");

      let errorDetailMisses = 0;
      const parsed = readTrailingContext(text, detailProbe.message);
      if (parsed === null || typeof parsed !== "object") errorDetailMisses += 3;
      else {
        const record = parsed as Record<string, unknown>;
        const topError = record.error as Record<string, unknown> | undefined;
        const nested = record.nestedFailure as Record<string, unknown> | undefined;
        if (typeof topError?.message !== "string" || !topError.message.includes(TOP_ERROR_MARKER)) {
          errorDetailMisses += 1;
        }
        if (typeof topError?.stack !== "string" || topError.stack.length === 0) {
          errorDetailMisses += 1;
        }
        // The #11777 shape: an Error nested inside a context object was written
        // as `{}` because `Object.entries` cannot see its non-enumerable fields.
        if (typeof nested?.message !== "string" || !nested.message.includes(NESTED_ERROR_MARKER)) {
          errorDetailMisses += 1;
        }
        // …beside a benign value that must have survived untouched.
        if (record.detail !== SURVIVOR_MARKER_CONTEXT) errorDetailMisses += 1;
      }

      // Durability, both directions, in ONE synchronous block: nothing may be
      // awaited between the INFO emit and the read, because the deferral being
      // measured is exactly one `setImmediate` long.
      await harness.resetCorpus();
      assertInsideTempRoot(harness.logDir());
      const infoProbe = makeEntry(
        `${token} ${SURVIVOR_MARKER} ${DEFERRED_PROBE_MARKER}`,
        buildSmallContext(),
        0
      );
      const errorProbe = makeEntry(
        `${token} ${SURVIVOR_MARKER} ${DURABLE_PROBE_MARKER}`,
        buildSmallContext(),
        0
      );

      let syncDurabilityMisses = 0;
      const restoreProbe = harness.captureConsole();
      let probeConsole: number;
      try {
        harness.emit("info", infoProbe.message, infoProbe.context);
        if (countAcrossFiles(harness.readLogFiles(), DEFERRED_PROBE_MARKER) !== 0) {
          syncDurabilityMisses += 1;
        }
        harness.emitError(errorProbe.message, undefined, errorProbe.context);
        const after = harness.readLogFiles();
        if (countAcrossFiles(after, DURABLE_PROBE_MARKER) !== 1) syncDurabilityMisses += 1;
        if (countAcrossFiles(after, DEFERRED_PROBE_MARKER) !== 1) syncDurabilityMisses += 1;
      } finally {
        probeConsole = restoreProbe();
      }
      await harness.flush();
      gradeCorpus(
        harness,
        core,
        [
          {
            ms: 0,
            flushMs: 0,
            entries: 2,
            markers: infoProbe.markers + errorProbe.markers,
            contextMarkers: infoProbe.contextMarkers + errorProbe.contextMarkers,
            plants: 0,
          },
        ],
        probeConsole
      );

      const infoUs = perEntryUs(info);
      const bareUs = perEntryUs(errorBare);
      const richUs = perEntryUs(errorRich);

      return {
        durationMs: info.ms + errorBare.ms + errorRich.ms,
        metrics: {
          entryCount: info.entries + errorBare.entries + errorRich.entries,
          logBytesWritten: fileBytes(files),
          perEntryUsInfo: infoUs,
          perEntryUsErrorBare: bareUs,
          perEntryUsErrorRich: richUs,
          flushMs: info.flushMs,
          syncWriteOverheadRatio: ratio(bareUs, infoUs),
          errorFlattenOverheadRatio: ratio(richUs, bareUs),
          flushToEmitOverheadRatio: ratio(info.flushMs, info.ms),
          errorDetailMisses,
          syncDurabilityMisses,
          ...coreMisses(core),
        },
        notes: `a synchronous ERROR append costs ${ratio(bareUs, infoUs).toFixed(1)}x a batched INFO entry; flattening an Error adds ${ratio(richUs, bareUs).toFixed(2)}x on top`,
      };
    },
  },
];
