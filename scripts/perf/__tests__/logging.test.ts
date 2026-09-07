import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  findSecretInValue,
  PATTERNS,
  scrubSecrets,
  type SecretPattern,
} from "../../../shared/utils/secretScrubber";
import {
  activeStubMode,
  ARRAY_ROW_COUNT,
  arrayCapMarker,
  assertInsideTempRoot,
  buildCleanMessage,
  buildContext,
  buildProbeHitMessage,
  buildSecretMessage,
  cleanupLoggingTempDir,
  countOccurrences,
  DEEP_CHAIN_DEPTH,
  ENTRY_TOKEN,
  gradeCore,
  jsonEqual,
  loadLoggingHarness,
  MAX_REDACT_ARRAY_ITEMS,
  MAX_REDACT_DEPTH,
  MAX_REDACT_STRING_CHARS,
  ownedTempDirCount,
  PROBE_HIT_SIGILS,
  QUIET_MARKER,
  readTrailingContext,
  REDACTION_MARKER,
  SECRET_PLANTS,
  SURVIVOR_MARKER,
  SURVIVOR_MARKER_CONTEXT,
  structMessageFor,
} from "../lib/loggingFixture";
import { loggingScenarios } from "../scenarios/logging";
import { classifyMetric } from "../lib/comparability";

/**
 * Two things this suite exists for, neither of which the perf run covers.
 *
 * The perf run gates nothing and is not on pull requests, so the module graph
 * behind PERF-380..384 — the real `electron/utils/logger.ts` and everything it
 * reaches, loaded outside Electron — can break without breaking anything else.
 * Running each scenario once links that graph in ordinary CI.
 *
 * The rest is the ORACLES, and here they need more care than usual. Every
 * predicate in this family turns on whether a planted string is a secret the
 * shipped patterns actually recognise and whether a "clean" line actually
 * misses the pre-scan probe. Both are properties of `secretScrubber.ts`, not of
 * this fixture, so both are asserted here against the product's own pattern
 * table. A plant that stopped matching would make `secretSurvivalMisses` read
 * zero forever, and a "clean" corpus that started hitting the probe would make
 * PERF-382's headline ratio read 1.0 with nothing wrong.
 */

/**
 * The class every metric this family emits must classify as.
 *
 * Declared rather than derived, because the failure it guards is a metric named
 * so that `classifyMetric` reads a deterministic byte count as machine-dependent
 * (losing a comparison that travels) or a wall-clock reading as a count (which
 * the matrix test would then accept as a correctness predicate).
 */
const EXPECTED_METRIC_CLASSES: Record<string, string> = {
  entryCount: "count",
  messageBytesTotal: "size",
  logBytesWritten: "size",
  perEntryUs64B: "duration",
  perEntryUs512B: "duration",
  perEntryUs4KiB: "duration",
  perEntryUs32KiB: "duration",
  lengthScalingOverheadRatio: "derived-ratio",
  flushMs: "duration",
  flushToEmitOverheadRatio: "derived-ratio",
  corpusShortfallCount: "count",
  contextShapeCount: "count",
  flatContextKeyCount: "count",
  wideContextKeyCount: "count",
  deepContextDepthCount: "count",
  arrayContextRowCount: "count",
  serializedContextBytes: "size",
  compactContextBytes: "size",
  prettyToCompactByteRatio: "ratio",
  perEntryUsFlat: "duration",
  perEntryUsWide: "duration",
  perEntryUsDeep: "duration",
  perEntryUsArray: "duration",
  deepToFlatOverheadRatio: "derived-ratio",
  wideToFlatOverheadRatio: "derived-ratio",
  clampEvidenceMisses: "count",
  patternPlantCount: "count",
  plantedSecretCount: "count",
  perEntryUsClean: "duration",
  perEntryUsProbeHit: "duration",
  perEntryUsSingle: "duration",
  perEntryUsDense: "duration",
  probeHitToCleanOverheadRatio: "derived-ratio",
  denseToCleanOverheadRatio: "derived-ratio",
  redactionCountDelta: "count",
  rotationCount: "count",
  rotationRoundCount: "count",
  rotationLadderFileCount: "count",
  rotationBoundaryBytes: "size",
  steadyLogBytesWritten: "size",
  liveLogBytesAfterRotation: "size",
  perEntryUsSteadyError: "duration",
  perEntryUsRotatingError: "duration",
  rotationOverheadRatio: "derived-ratio",
  rotationMisses: "count",
  perEntryUsInfo: "duration",
  perEntryUsErrorBare: "duration",
  perEntryUsErrorRich: "duration",
  syncWriteOverheadRatio: "derived-ratio",
  errorFlattenOverheadRatio: "derived-ratio",
  errorDetailMisses: "count",
  syncDurabilityMisses: "count",
  levelGateMisses: "count",
  keyRedactionMisses: "count",
  clampMisses: "count",
  bufferMisses: "count",
  stringifyMisses: "count",
  secretSurvivalMisses: "count",
  markerSurvivalMisses: "count",
  lineCountMisses: "count",
  consoleMirrorMisses: "count",
};

const SCENARIO_TIMEOUT_MS = 120_000;

/**
 * Rebuild the scrubber's two pre-scan probes from the shipped pattern table.
 *
 * The probes are module-private, and the distinction PERF-382 is built on —
 * probe miss against probe hit — cannot be asserted through `scrubSecrets`
 * alone, because both answer the input unchanged. Reconstructing them from
 * `PATTERNS` reads the product's own declaration rather than a copy.
 */
function buildProbe(patterns: readonly SecretPattern[], flags: string): RegExp {
  return new RegExp(patterns.map((p) => p.probe ?? p.regex.source).join("|"), flags);
}

const CASE_SENSITIVE_PROBE = buildProbe(
  PATTERNS.filter((p) => !p.regex.flags.includes("i")),
  "m"
);
const CASE_INSENSITIVE_PROBE = buildProbe(
  PATTERNS.filter((p) => p.regex.flags.includes("i")),
  "im"
);

function hitsProbe(value: string): boolean {
  return CASE_SENSITIVE_PROBE.test(value) || CASE_INSENSITIVE_PROBE.test(value);
}

describe("synthetic secret plants", () => {
  it("every plant is a secret the shipped patterns recognise", () => {
    for (const plant of SECRET_PLANTS) {
      expect(findSecretInValue(plant.literal)?.name, plant.name).toBe(plant.name);
      // Redacted to EXACTLY the marker the density predicate counts: a plant
      // whose replacement carried a prefix (`Bearer [REDACTED]`) would make the
      // per-line redaction tally wrong in a way no other assertion would show.
      expect(scrubSecrets(`before ${plant.literal} after`)).toBe(
        `before ${REDACTION_MARKER} after`
      );
    }
  });

  it("plants are synthetic, not credentials", () => {
    // Every one is a recognised sigil followed by a run of the literal string
    // `PERFFAKE0`. This is the assertion that keeps a real token out of the
    // fixture, and out of the temp file the two-sided predicate writes.
    for (const plant of SECRET_PLANTS) {
      expect(plant.literal, plant.name).toContain("PERFFAKE0");
    }
  });

  it("plants use distinct patterns, so the corpus is not eight copies of one", () => {
    const names = SECRET_PLANTS.map((plant) => findSecretInValue(plant.literal)?.name);
    expect(new Set(names).size).toBe(SECRET_PLANTS.length);
  });

  it("eight plants on one line produce eight redactions", () => {
    const line = buildSecretMessage(ENTRY_TOKEN, 0, 1024, SECRET_PLANTS.length);
    expect(countOccurrences(scrubSecrets(line), REDACTION_MARKER)).toBe(SECRET_PLANTS.length);
  });
});

describe("probe miss and probe hit", () => {
  it("a clean line misses BOTH pre-scan probes", () => {
    // The fast path PERF-382 prices. If the filler or a marker ever grows a
    // sigil, this arm quietly becomes a second probe-hit arm.
    for (const bytes of [64, 512, 1024, 4096, 32768]) {
      const line = buildCleanMessage(ENTRY_TOKEN, 0, bytes);
      expect(hitsProbe(line), `${bytes}B`).toBe(false);
      expect(scrubSecrets(line)).toBe(line);
    }
  });

  it("a probe-hit line hits the probe and still redacts nothing", () => {
    // Both halves matter: hitting is what makes the ~60 replace passes run, and
    // redacting nothing is what isolates the pre-scan from the scan.
    const line = buildProbeHitMessage(ENTRY_TOKEN, 0, 1024);
    expect(hitsProbe(line)).toBe(true);
    expect(scrubSecrets(line)).toBe(line);
    expect(findSecretInValue(line)).toBeUndefined();
    expect(line).toContain(PROBE_HIT_SIGILS);
  });

  it("every marker survives the real scrubber untouched", () => {
    for (const marker of [SURVIVOR_MARKER, SURVIVOR_MARKER_CONTEXT, QUIET_MARKER, ENTRY_TOKEN]) {
      expect(scrubSecrets(marker), marker).toBe(marker);
      expect(hitsProbe(marker), marker).toBe(false);
    }
  });
});

describe("corpus arithmetic", () => {
  it("pads every message to exactly the requested byte count", () => {
    for (const bytes of [64, 512, 1024, 4096, 32768]) {
      expect(Buffer.byteLength(buildCleanMessage(ENTRY_TOKEN, 0, bytes), "utf8")).toBe(bytes);
    }
    // The probe-hit head carries the sigils, so its own floor is higher than
    // the sweep's 64 B step; PERF-382 runs it at 1 KiB.
    for (const bytes of [512, 1024, 4096]) {
      expect(Buffer.byteLength(buildProbeHitMessage(ENTRY_TOKEN, 0, bytes), "utf8")).toBe(bytes);
    }
    expect(Buffer.byteLength(buildSecretMessage(ENTRY_TOKEN, 0, 1024, 8), "utf8")).toBe(1024);
  });

  it("refuses a target below a message's own floor rather than undershooting", () => {
    // A silent undershoot is how a corpus stops describing what it claims to.
    expect(() => buildCleanMessage(ENTRY_TOKEN, 0, 8)).toThrow(/floor/);
  });

  it("carries the entry token exactly once per message", () => {
    expect(countOccurrences(buildCleanMessage(ENTRY_TOKEN, 3, 512), ENTRY_TOKEN)).toBe(1);
    expect(countOccurrences(buildSecretMessage(ENTRY_TOKEN, 3, 1024, 8), ENTRY_TOKEN)).toBe(1);
    expect(countOccurrences(structMessageFor(ENTRY_TOKEN), ENTRY_TOKEN)).toBe(1);
  });

  it("the deep and array contexts really cross the clamps they are built for", () => {
    // A corpus that stopped crossing a clamp would make PERF-381's evidence
    // predicate pass on zero against zero.
    expect(DEEP_CHAIN_DEPTH).toBeGreaterThan(MAX_REDACT_DEPTH);
    expect(ARRAY_ROW_COUNT).toBeGreaterThan(MAX_REDACT_ARRAY_ITEMS);
    expect(arrayCapMarker(ARRAY_ROW_COUNT)).toBe(
      `[...${ARRAY_ROW_COUNT - MAX_REDACT_ARRAY_ITEMS} more]`
    );
    const deep = buildContext("deep");
    // The leaf sits past the clamp and is dropped, so it must carry no marker.
    expect(JSON.stringify(deep)).toContain("deep-leaf");
    expect(countOccurrences(JSON.stringify(deep), SURVIVOR_MARKER_CONTEXT)).toBe(1);
  });

  it("jsonEqual separates a mutated payload from an intact one", () => {
    expect(jsonEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(jsonEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it("countOccurrences counts non-overlapping hits", () => {
    expect(countOccurrences("aXbXc", "X")).toBe(2);
    expect(countOccurrences("aaaa", "aa")).toBe(2);
    expect(countOccurrences("abc", "")).toBe(0);
  });
});

describe("the stub seam", () => {
  it("is off by default and rejects a name it does not implement", () => {
    const prior = process.env.DAINTREE_PERF_LOGGER_STUB;
    delete process.env.DAINTREE_PERF_LOGGER_STUB;
    try {
      expect(activeStubMode()).toBeNull();
      process.env.DAINTREE_PERF_LOGGER_STUB = "not-a-mode";
      expect(() => activeStubMode()).toThrow(/unknown DAINTREE_PERF_LOGGER_STUB/);
      process.env.DAINTREE_PERF_LOGGER_STUB = "scrub-nothing";
      expect(activeStubMode()).toBe("scrub-nothing");
    } finally {
      if (prior === undefined) delete process.env.DAINTREE_PERF_LOGGER_STUB;
      else process.env.DAINTREE_PERF_LOGGER_STUB = prior;
    }
  });
});

describe("the real emit path", () => {
  it(
    "clears every core predicate",
    async () => {
      const harness = await loadLoggingHarness();
      expect(await gradeCore(harness)).toEqual({
        levelGateMisses: 0,
        keyRedactionMisses: 0,
        clampMisses: 0,
        bufferMisses: 0,
        stringifyMisses: 0,
        secretSurvivalMisses: 0,
        markerSurvivalMisses: 0,
        lineCountMisses: 0,
        consoleMirrorMisses: 0,
      });
    },
    SCENARIO_TIMEOUT_MS
  );

  it(
    "writes into a temp directory and never near the developer's own logs",
    async () => {
      const harness = await loadLoggingHarness();
      expect(harness.logDir()).toContain("daintree-perf-logging-");
      expect(harness.logDir().startsWith(realpathSync(tmpdir()))).toBe(true);
      // The guard is the thing that keeps a rotation round off a real profile,
      // so it must actually refuse rather than warn.
      expect(() => assertInsideTempRoot("/Users/someone/Library/Daintree/logs")).toThrow(
        /outside the temp root/
      );
    },
    SCENARIO_TIMEOUT_MS
  );

  it(
    "applies both clamps and both redaction gates to one context",
    async () => {
      const harness = await loadLoggingHarness();
      await gradeCore(harness);
      const text = harness
        .readLogFiles()
        .map((file) => file.text)
        .join("");
      const parsed = readTrailingContext(text, structMessageFor(harness.token())) as Record<
        string,
        unknown
      >;
      expect(parsed).toBeDefined();
      // Key gate and content scrubber are different gates on the same object:
      // `token` never reaches the scrubber, `stdout` reaches nothing else.
      expect(parsed.token).toBe("[redacted]");
      expect(parsed.stdout).toBe(REDACTION_MARKER);
      // …and a benign value must be there beside them, unchanged.
      expect(parsed.sessionId).toBe(SURVIVOR_MARKER_CONTEXT);
      expect(String(parsed.longNote)).toHaveLength(
        MAX_REDACT_STRING_CHARS + `[…+${5000 - MAX_REDACT_STRING_CHARS}]`.length
      );
      expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
    },
    SCENARIO_TIMEOUT_MS
  );
});

describe("scenario execution", () => {
  const context = { mode: "smoke" as const, now: () => performance.now() };

  for (const scenario of loggingScenarios) {
    it(
      `${scenario.id} runs clean and emits every declared predicate`,
      async () => {
        const sample = await scenario.run(context);
        const metrics = sample.metrics ?? {};

        for (const name of scenario.correctness ?? []) {
          expect(metrics[name], `${scenario.id}:${name}`).toBe(0);
        }
        expect(sample.durationMs).toBeGreaterThan(0);

        for (const [name, value] of Object.entries(metrics)) {
          expect(Number.isFinite(value), `${scenario.id}:${name} is ${value}`).toBe(true);
          expect(EXPECTED_METRIC_CLASSES[name], `${scenario.id}:${name} is undeclared`).toBe(
            classifyMetric(name)
          );
        }
      },
      SCENARIO_TIMEOUT_MS
    );
  }

  it(
    "PERF-382 actually plants secrets, so a zero delta means something",
    async () => {
      const scenario = loggingScenarios.find((s) => s.id === "PERF-382");
      expect(scenario).toBeDefined();
      const sample = await scenario!.run(context);
      const metrics = sample.metrics ?? {};
      expect(metrics.patternPlantCount).toBe(SECRET_PLANTS.length);
      // 200 entries on the single arm plus 200 × 8 on the dense arm.
      expect(metrics.plantedSecretCount).toBe(200 + 200 * SECRET_PLANTS.length);
      expect(metrics.redactionCountDelta).toBe(0);
    },
    SCENARIO_TIMEOUT_MS
  );

  it(
    "PERF-383 really crosses the boundary on every round",
    async () => {
      const scenario = loggingScenarios.find((s) => s.id === "PERF-383");
      expect(scenario).toBeDefined();
      const sample = await scenario!.run(context);
      const metrics = sample.metrics ?? {};
      // Acceptance is the proof: `.1` came back at exactly the boundary size on
      // every round, so every round really did rotate rather than append.
      expect(metrics.rotationCount).toBe(metrics.rotationRoundCount);
      expect(metrics.rotationBoundaryBytes).toBe(5 * 1024 * 1024);
      expect(metrics.liveLogBytesAfterRotation).toBeGreaterThan(0);
      expect(metrics.liveLogBytesAfterRotation).toBeLessThan(metrics.rotationBoundaryBytes!);
    },
    SCENARIO_TIMEOUT_MS
  );
});

describe("temp-directory hygiene", () => {
  // Last in the file on purpose: it tears the root down, and vitest runs tests
  // in declaration order. A fixture that minted a directory per iteration is
  // how 488 of them once ended up in $TMPDIR.
  it("owns exactly one temp root and removes it on cleanup", async () => {
    await loadLoggingHarness();
    expect(ownedTempDirCount()).toBe(1);
    cleanupLoggingTempDir();
    expect(ownedTempDirCount()).toBe(0);
  });
});
