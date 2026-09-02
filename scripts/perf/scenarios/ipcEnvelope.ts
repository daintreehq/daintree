import { performance } from "node:perf_hooks";

import type { PerfScenario, ScenarioSample } from "../types";
import {
  ARRAY_ROW_COUNT,
  buildDeepChainArgs,
  buildShapedArgs,
  buildSizedArgs,
  CATEGORY_CHANNEL,
  coreMisses,
  DEEP_CHAIN_DEPTH,
  deepChainArgBytes,
  deepChainOverflowsStringify,
  echoedInput,
  emptyCoreGrade,
  gradeCore,
  invalidPayloadForSchema,
  jsonArgBytes,
  jsonEqual,
  loadEnvelopeHarness,
  padToExactBytes,
  PLAIN_CHANNEL,
  PLANTED_PATH,
  PLANTED_SECRET,
  SHAPE_TARGET_BYTES,
  THROWING_CHANNEL,
  TRUSTED_SENDER_URL,
  VALIDATED_CHANNEL,
  VALIDATED_SCHEMA_FIELD_COUNT,
  validPayloadForSchema,
  WIDE_KEY_COUNT,
  type Envelope,
  type EnvelopeHarness,
  type PayloadShape,
} from "../lib/ipcEnvelopeFixture";

/**
 * The main-process IPC invoke wrapper — the one piece of code every
 * `ipcMain.invoke` in Daintree crosses, and the last significant gap in the
 * matrix.
 *
 * `enforceIpcSenderValidation()` monkeypatches `ipcMain.handle` before any
 * handler registers, so all ~600 invoke channels pay the same envelope tax:
 * a sender-frame trust check, an argument-count cap, and a full
 * `JSON.stringify(args, sizeGuardReplacer)` whose ONLY purpose is to learn the
 * payload's size. Roughly sixty channels add a zod `safeParse` on top. PERF-042
 * through PERF-046 measure the utility-host fork boundary and say so; this layer
 * sits upstream of all of them and had no coverage at all.
 *
 * `lib/ipcEnvelopeFixture.ts` states what is real and what is not. The headline
 * limit to carry into every reading here: **these are wrapper durations, not IPC
 * latency.** Electron's structured clone across the process boundary happens
 * before the wrapper is entered and is not in the frame.
 *
 * Every scenario declares the same five core predicates plus its own. The core
 * five are one accumulator per operation the wrapper performs on every invoke —
 * the monkeypatch itself, the frame check, the arg cap, the byte measurement,
 * and the handler round trip — because a single aggregate cannot see one of
 * them deleted. Each is graded in BOTH directions, so a wrapper stubbed to
 * return immediately scores on the rejecting terms and one stubbed to throw
 * scores on the accepting terms.
 */

/** Warmup passes before any measured iteration; the byte gate is JIT-sensitive. */
const WARMUPS = 2;

interface ArmTiming {
  ms: number;
  invokes: number;
  misses: number;
}

/**
 * Drive one arm and return its wall time.
 *
 * The only bookkeeping inside the bracket is one O(1) envelope check per invoke
 * — `ok` plus a reference comparison against the object that was sent. Every
 * structural comparison happens after the measurement is taken.
 */
async function driveArm(
  harness: EnvelopeHarness,
  channel: string,
  args: unknown[],
  invokes: number,
  expectEcho: boolean
): Promise<ArmTiming> {
  let misses = 0;
  const started = performance.now();
  for (let index = 0; index < invokes; index += 1) {
    const envelope = await harness.invokeAs(TRUSTED_SENDER_URL, channel, args);
    if (expectEcho) {
      if (!echoedInput(envelope, args[0])) misses += 1;
    } else if (envelope.ok !== true) {
      misses += 1;
    }
  }
  return { ms: performance.now() - started, invokes, misses };
}

/** Same shape, for arms whose invokes must be REJECTED rather than served. */
async function driveRejectingArm(
  harness: EnvelopeHarness,
  channel: string,
  args: unknown[],
  invokes: number
): Promise<ArmTiming> {
  let misses = 0;
  const started = performance.now();
  for (let index = 0; index < invokes; index += 1) {
    const envelope = await harness.invokeAs(TRUSTED_SENDER_URL, channel, args);
    if (envelope.ok !== false) misses += 1;
  }
  return { ms: performance.now() - started, invokes, misses };
}

function perInvokeUs(arm: ArmTiming): number {
  return arm.invokes > 0 ? (arm.ms * 1000) / arm.invokes : 0;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

/** A measurement that did not happen, reported as misses rather than thrown. */
function failClosed(notes: string, metrics: Record<string, number>): ScenarioSample {
  return { durationMs: 0, metrics, notes };
}

// --- Corpora -----------------------------------------------------------------

/**
 * Payload corpora are built once per process and reused across iterations.
 *
 * Construction is not the subject and a 512 KiB pad rebuilt sixteen times would
 * be pure noise in the duration. Nothing is built at module import — the
 * lazy-fixture rule — so importing this module allocates nothing.
 */

interface SizeClass {
  label: string;
  bytes: number;
  invokes: number;
  args: unknown[];
}

/**
 * A log-spaced sweep across the payload sizes real channels carry: a terminal
 * resize, a settings write, a file diff, and a scrollback or patch payload.
 * The floor is 128 B because the flat shape's own unpadded form is ~62 B.
 */
const SIZE_SWEEP_SPEC: ReadonlyArray<{ label: string; bytes: number; invokes: number }> = [
  { label: "128B", bytes: 128, invokes: 400 },
  { label: "4KiB", bytes: 4 * 1024, invokes: 200 },
  { label: "64KiB", bytes: 64 * 1024, invokes: 60 },
  { label: "512KiB", bytes: 512 * 1024, invokes: 20 },
];

let sizeSweep: SizeClass[] | null = null;

function getSizeSweep(): SizeClass[] {
  sizeSweep ??= SIZE_SWEEP_SPEC.map((spec) => ({ ...spec, args: buildSizedArgs(spec.bytes) }));
  return sizeSweep;
}

const SHAPES: readonly PayloadShape[] = ["flat", "wide", "deep", "array"];

let shapeCorpus: Map<PayloadShape, unknown[]> | null = null;

function getShapeCorpus(): Map<PayloadShape, unknown[]> {
  if (shapeCorpus === null) {
    shapeCorpus = new Map();
    for (const shape of SHAPES) {
      shapeCorpus.set(shape, buildShapedArgs(shape, SHAPE_TARGET_BYTES));
    }
  }
  return shapeCorpus;
}

/** Representative of a validated channel's real payload: ~2 KiB of settings. */
const VALIDATED_PAYLOAD_BYTES = 2 * 1024;

let validatedArgs: unknown[] | null = null;
let validatedInvalidArgs: unknown[] | null = null;

function getValidatedArgs(): unknown[] {
  validatedArgs ??= padToExactBytes((pad) => [validPayloadForSchema(pad)], VALIDATED_PAYLOAD_BYTES);
  return validatedArgs;
}

function getValidatedInvalidArgs(): unknown[] {
  validatedInvalidArgs ??= padToExactBytes(
    (pad) => [invalidPayloadForSchema(pad)],
    VALIDATED_PAYLOAD_BYTES
  );
  return validatedInvalidArgs;
}

/** Small enough that the error machinery, not the byte gate, dominates. */
const ERROR_PAYLOAD_BYTES = 512;

let errorArgs: unknown[] | null = null;

function getErrorArgs(): unknown[] {
  errorArgs ??= buildSizedArgs(ERROR_PAYLOAD_BYTES);
  return errorArgs;
}

// --- PERF-364 corpus ---------------------------------------------------------

/**
 * How far over the category channel's own budget every fail-open probe sits.
 *
 * The observable for "the byte gate was skipped" is that an OVER-BUDGET payload
 * came back accepted: a measured payload of this size must be rejected, and a
 * payload the guard bails on is waved through. Nothing here reads a counter the
 * subject keeps about itself.
 */
const OVERSIZE_MARGIN_BYTES = 4096;

/**
 * Deep enough that `JSON.stringify` overflows the stack when a replacer is
 * supplied. A replacer — any replacer — moves V8 off its iterative serializer
 * onto the recursive one, and `sizeGuardReplacer` is a replacer, so the ceiling
 * is a few thousand levels rather than the hundreds of thousands a plain
 * `JSON.stringify` handles. The scenario re-checks this with its own identity
 * replacer rather than assuming a stack size.
 */
const OVERFLOW_CHAIN_DEPTH = 60_000;

/** Declared separately so a class silently dropped from the corpus is a shortfall. */
const EXPECTED_BAIL_CLASSES = 8;

type BailKey =
  "plain" | "earlyBail" | "lateBail" | "map" | "set" | "circular" | "bigint" | "overDeep";

interface BailCase {
  key: BailKey;
  reason: string;
  /** True when the size guard is documented to abort and skip the byte check. */
  expectBail: boolean;
  args: unknown[];
  invokes: number;
}

let bailCorpus: BailCase[] | null = null;

function getBailCorpus(oversizeBytes: number): BailCase[] {
  if (bailCorpus !== null) return bailCorpus;

  const base = buildSizedArgs(oversizeBytes)[0] as Record<string, unknown>;

  bailCorpus = [
    {
      key: "plain",
      reason: "a plain payload over budget is the control: it must be measured and rejected",
      expectBail: false,
      args: [base],
      invokes: 60,
    },
    {
      key: "earlyBail",
      reason: "a Uint8Array on the FIRST key aborts the measuring pass immediately",
      expectBail: true,
      args: [{ blob: new Uint8Array(8), ...base }],
      invokes: 60,
    },
    {
      key: "lateBail",
      reason: "the same buffer on the LAST key aborts only after the whole payload is written",
      expectBail: true,
      args: [{ ...base, blob: new Uint8Array(8) }],
      invokes: 60,
    },
    {
      key: "map",
      reason: "a Map serialises to {} so its size is unknowable; the guard bails",
      expectBail: true,
      args: [{ ...base, entries: new Map([["a", 1]]) }],
      invokes: 60,
    },
    {
      key: "set",
      reason: "a Set is the same case as a Map and must be caught by the same branch",
      expectBail: true,
      args: [{ ...base, tags: new Set(["a", "b"]) }],
      invokes: 60,
    },
    {
      key: "circular",
      reason: "stringify's own throw on a cycle lands in the same catch and fails open",
      expectBail: true,
      args: [buildCircular(base)],
      invokes: 60,
    },
    {
      key: "bigint",
      reason:
        "bigintSafeReplacer coerces rather than bailing, so a BigInt payload IS measured — " +
        "the second control, and the one a bail-on-everything guard fails",
      expectBail: false,
      args: [{ ...base, big: BigInt(1) }],
      invokes: 60,
    },
    {
      key: "overDeep",
      reason:
        "past V8's recursion limit stringify throws and security.ts fails open by design — " +
        "so a deeply nested payload of any size reaches the handler unmeasured",
      expectBail: deepChainOverflowsStringify(OVERFLOW_CHAIN_DEPTH),
      args: buildDeepChainArgs(OVERFLOW_CHAIN_DEPTH),
      invokes: 20,
    },
  ];
  return bailCorpus;
}

function buildCircular(base: Record<string, unknown>): Record<string, unknown> {
  // Planted LAST, so the whole payload is serialised before the cycle is hit —
  // the expensive shape, and the one a real object graph produces.
  const node: Record<string, unknown> = { ...base };
  node.self = node;
  return node;
}

// --- Scenarios ---------------------------------------------------------------

const CORE_CORRECTNESS = [
  "wrapperInstallMisses",
  "senderTrustMisses",
  "argCountMisses",
  "byteMeasurementMisses",
  "roundTripMisses",
] as const;

export const ipcEnvelopeScenarios: PerfScenario[] = [
  {
    id: "PERF-360",
    name: "IPC Invoke Envelope Cost by Payload Size",
    description:
      "Per-invoke cost of the global ipcMain.handle wrapper across a 128 B → 512 KiB payload sweep on an uncategorised channel, driving the real enforceIpcSenderValidation wrapper: the real sender-frame trust check, the real MAX_IPC_ARG_COUNT cap, and the real JSON.stringify(args, sizeGuardReplacer) whose only product is a byte count. Every invoke channel in the app pays this, so the slope against payload size is the tax the whole IPC surface carries. Graded two-sidedly against arithmetic this fixture did itself: a payload of exactly the real terminalSpawn budget must be accepted and one byte more must be rejected with the wrapper's own measured byte count equal to Buffer.byteLength(JSON.stringify(args)).",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    warmups: WARMUPS,
    correctness: [...CORE_CORRECTNESS],
    async run() {
      const harness = await loadEnvelopeHarness();
      const sweep = getSizeSweep();

      const timings = new Map<string, ArmTiming>();
      let totalMs = 0;
      let invokeCount = 0;
      let measuredBytesTotal = 0;
      let roundTripMisses = 0;

      for (const sizeClass of sweep) {
        const arm = await driveArm(harness, PLAIN_CHANNEL, sizeClass.args, sizeClass.invokes, true);
        timings.set(sizeClass.label, arm);
        totalMs += arm.ms;
        invokeCount += arm.invokes;
        measuredBytesTotal += sizeClass.bytes * arm.invokes;
        roundTripMisses += arm.misses;
      }

      const core = await gradeCore(harness);
      core.roundTripMisses += roundTripMisses;

      const small = timings.get("128B");
      const large = timings.get("512KiB");
      if (!small || !large) {
        return failClosed("a size class never ran", {
          ...coreMisses({ ...emptyCoreGrade(), roundTripMisses: sweep.length }),
        });
      }

      const smallUs = perInvokeUs(small);
      const largeUs = perInvokeUs(large);

      return {
        durationMs: totalMs,
        metrics: {
          invokeCount,
          measuredBytesTotal,
          perInvokeUs128B: smallUs,
          perInvokeUs4KiB: perInvokeUs(timings.get("4KiB") ?? small),
          perInvokeUs64KiB: perInvokeUs(timings.get("64KiB") ?? small),
          perInvokeUs512KiB: largeUs,
          sizeScalingOverheadRatio: ratio(largeUs, smallUs),
          ...coreMisses(core),
        },
        notes: `512 KiB costs ${ratio(largeUs, smallUs).toFixed(1)}x a 128 B invoke through the same wrapper`,
      };
    },
  },
  {
    id: "PERF-361",
    name: "IPC Invoke Envelope Cost by Payload Shape",
    description:
      "The same 64 KiB of payload through the real wrapper in four structures — one flat string, 1,500 shallow keys, a 1,000-level plain-object chain, and a 900-row array — padded to byte-identical size so the only variable is shape. This is the reading the comment at security.ts:115-125 asks for: the old containsBinary pre-walk bailed out past depth 32 and SKIPPED the byte gate, so deep plain objects were never measured, and folding detection into sizeGuardReplacer means they now are. Each shape's byte count is reasserted against this fixture's own arithmetic every iteration, so a corpus that quietly shrank is a miss rather than a faster number.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    warmups: WARMUPS,
    correctness: [...CORE_CORRECTNESS, "shapeShortfallCount"],
    async run() {
      const harness = await loadEnvelopeHarness();
      const corpus = getShapeCorpus();
      const invokesPerShape = 60;

      const timings = new Map<PayloadShape, ArmTiming>();
      let totalMs = 0;
      let roundTripMisses = 0;
      let shapeShortfall = 0;

      for (const shape of SHAPES) {
        const args = corpus.get(shape);
        if (args === undefined) {
          shapeShortfall += 1;
          continue;
        }
        // The corpus is checked against this fixture's own byte arithmetic, not
        // against anything the subject reports — PERF-340's lesson, where a
        // registry shrank by 120 rows and the run got 1.45x faster in silence.
        if (jsonArgBytes(args) !== SHAPE_TARGET_BYTES) shapeShortfall += 1;
        const arm = await driveArm(harness, PLAIN_CHANNEL, args, invokesPerShape, true);
        timings.set(shape, arm);
        totalMs += arm.ms;
        roundTripMisses += arm.misses;
      }

      const core = await gradeCore(harness);
      core.roundTripMisses += roundTripMisses;

      const flat = timings.get("flat");
      if (!flat) {
        return failClosed("the flat control arm never ran", {
          ...coreMisses(emptyCoreGrade()),
          shapeShortfallCount: SHAPES.length,
        });
      }

      const flatUs = perInvokeUs(flat);
      const deepUs = perInvokeUs(timings.get("deep") ?? flat);
      const wideUs = perInvokeUs(timings.get("wide") ?? flat);

      return {
        durationMs: totalMs,
        metrics: {
          shapeCount: SHAPES.length,
          invokeCount: invokesPerShape * timings.size,
          shapePayloadBytes: SHAPE_TARGET_BYTES,
          widePayloadKeyCount: WIDE_KEY_COUNT,
          deepPayloadDepthCount: DEEP_CHAIN_DEPTH,
          arrayPayloadRowCount: ARRAY_ROW_COUNT,
          perInvokeUsFlat: flatUs,
          perInvokeUsWide: wideUs,
          perInvokeUsDeep: deepUs,
          perInvokeUsArray: perInvokeUs(timings.get("array") ?? flat),
          deepToFlatOverheadRatio: ratio(deepUs, flatUs),
          wideToFlatOverheadRatio: ratio(wideUs, flatUs),
          shapeShortfallCount: shapeShortfall,
          ...coreMisses(core),
        },
        notes: `at equal bytes a ${DEEP_CHAIN_DEPTH}-level payload costs ${ratio(deepUs, flatUs).toFixed(2)}x a flat one`,
      };
    },
  },
  {
    id: "PERF-362",
    name: "Validated vs Unvalidated Invoke Channel",
    description:
      "The same 2 KiB payload through an unvalidated channel and through one registered with the real typedHandleValidated, so the delta is exactly parseIpcPayload's zod safeParse over a 12-field schema — the tax roughly sixty of the app's channels pay on top of the envelope tax every channel already pays. Graded in both directions on the same pass: a planted-invalid payload must be REJECTED with a sanitized ValidationError on the validated channel, the same payload must be ACCEPTED on the unvalidated one (so the difference is the schema and not the wrapper), and a planted-valid payload must reach the handler with its post-parse value intact. A handler stubbed to return immediately fails the reject term; one stubbed to throw fails both accept terms.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    warmups: WARMUPS,
    correctness: [
      ...CORE_CORRECTNESS,
      "schemaAcceptMisses",
      "schemaRejectMisses",
      "unvalidatedGateMisses",
    ],
    async run() {
      const harness = await loadEnvelopeHarness();
      const args = getValidatedArgs();
      const invalidArgs = getValidatedInvalidArgs();
      const invokes = 300;

      const unvalidated = await driveArm(harness, PLAIN_CHANNEL, args, invokes, true);
      const validated = await driveArm(harness, VALIDATED_CHANNEL, args, invokes, false);

      // Both directions of the schema gate, plus the unvalidated control.
      // `parseIpcPayload` dumps the zod issue list through console.error on
      // every rejection, so the sink is installed for the graded probes.
      const restoreConsole = harness.captureConsoleErrors();
      let acceptEnvelope: Envelope;
      let acceptedPayload: unknown;
      let rejectEnvelope: Envelope;
      let controlEnvelope: Envelope;
      let validationLogCount: number;
      try {
        acceptEnvelope = await harness.invokeAs(TRUSTED_SENDER_URL, VALIDATED_CHANNEL, args);
        // Read before the reject probe runs: a schema that accepts everything
        // would otherwise leave the INVALID payload here and be graded on it.
        acceptedPayload = harness.lastValidatedPayload();
        rejectEnvelope = await harness.invokeAs(TRUSTED_SENDER_URL, VALIDATED_CHANNEL, invalidArgs);
        controlEnvelope = await harness.invokeAs(TRUSTED_SENDER_URL, PLAIN_CHANNEL, invalidArgs);
      } finally {
        validationLogCount = restoreConsole();
      }

      let schemaAcceptMisses = 0;
      if (acceptEnvelope.ok !== true) schemaAcceptMisses += 1;
      // Read the payload the handler was actually handed, not the envelope: the
      // point of the accept term is that a valid payload REACHED the handler
      // with its post-parse value, which an envelope alone cannot show.
      if (!jsonEqual(acceptedPayload, args[0])) schemaAcceptMisses += 1;
      if (validated.misses > 0) schemaAcceptMisses += validated.misses;

      let schemaRejectMisses = 0;
      if (rejectEnvelope.ok !== false) schemaRejectMisses += 1;
      if (rejectEnvelope.error?.name !== "ValidationError") schemaRejectMisses += 1;
      // The product's contract is that zod issues and user values never leave
      // the main process. A rejection that leaked the offending value would be
      // a different defect wearing the same envelope.
      if ((rejectEnvelope.error?.message ?? "").includes("cols")) schemaRejectMisses += 1;
      if (validationLogCount < 1) schemaRejectMisses += 1;

      let unvalidatedGateMisses = 0;
      if (controlEnvelope.ok !== true) unvalidatedGateMisses += 1;

      const core = await gradeCore(harness);
      core.roundTripMisses += unvalidated.misses;

      const unvalidatedUs = perInvokeUs(unvalidated);
      const validatedUs = perInvokeUs(validated);

      return {
        durationMs: unvalidated.ms + validated.ms,
        metrics: {
          invokeCount: unvalidated.invokes + validated.invokes,
          payloadBytes: jsonArgBytes(args),
          schemaFieldCount: VALIDATED_SCHEMA_FIELD_COUNT,
          validationLogCount,
          unvalidatedPerInvokeUs: unvalidatedUs,
          validatedPerInvokeUs: validatedUs,
          schemaValidationOverheadRatio: ratio(validatedUs, unvalidatedUs),
          schemaAcceptMisses,
          schemaRejectMisses,
          unvalidatedGateMisses,
          ...coreMisses(core),
        },
        notes: `zod safeParse adds ${(validatedUs - unvalidatedUs).toFixed(1)}us per invoke over a 2 KiB payload`,
      };
    },
  },
  {
    id: "PERF-363",
    name: "IPC Envelope Success vs Error Path",
    description:
      "Four arms through the same wrapper on the same 512 B payload: a handler that returns (wrapSuccess), a handler that throws in a development build (wrapError → serializeError), the same throw with app.isPackaged true (serializeError plus sanitizeErrorForRenderer over the message and userMessage, plus the stack/context/cause/properties strip), and a rejection raised by the gate itself before the handler is entered. Graded in both directions on the sanitizer: the packaged message must NOT carry the planted absolute path or the planted github token and must carry the redaction markers instead, while the development message MUST still carry both — so a sanitizer applied everywhere and a sanitizer that does nothing are separately caught, and one that returns an empty string fails the marker term.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    warmups: WARMUPS,
    correctness: [
      ...CORE_CORRECTNESS,
      "errorEnvelopeMisses",
      "sanitizerMisses",
      "strippedFieldMisses",
    ],
    async run() {
      const harness = await loadEnvelopeHarness();
      const args = getErrorArgs();
      const invokes = 200;
      const overCap = Array.from({ length: harness.modules.MAX_IPC_ARG_COUNT + 1 }, (_, index) => ({
        index,
      }));

      const success = await driveArm(harness, PLAIN_CHANNEL, args, invokes, true);
      const devError = await driveRejectingArm(harness, THROWING_CHANNEL, args, invokes);
      const gateReject = await driveRejectingArm(harness, PLAIN_CHANNEL, overCap, invokes);

      // The packaged branch logs every error through console.error. The sink is
      // counted and reported, so the branch is proven to have run, and the real
      // logger's stderr write stays out of the number.
      harness.setPackaged(true);
      const restoreConsole = harness.captureConsoleErrors();
      let packagedError: ArmTiming;
      let packagedLogCount: number;
      try {
        packagedError = await driveRejectingArm(harness, THROWING_CHANNEL, args, invokes);
      } finally {
        packagedLogCount = restoreConsole();
        harness.setPackaged(false);
      }

      // Graded envelopes, taken outside every timed region.
      const successEnvelope = await harness.invokeAs(TRUSTED_SENDER_URL, PLAIN_CHANNEL, args);
      const devEnvelope = await harness.invokeAs(TRUSTED_SENDER_URL, THROWING_CHANNEL, args);
      harness.setPackaged(true);
      const restoreGradeConsole = harness.captureConsoleErrors();
      let packagedEnvelope: Envelope;
      try {
        packagedEnvelope = await harness.invokeAs(TRUSTED_SENDER_URL, THROWING_CHANNEL, args);
      } finally {
        restoreGradeConsole();
        harness.setPackaged(false);
      }

      let errorEnvelopeMisses = 0;
      if (successEnvelope.ok !== true) errorEnvelopeMisses += 1;
      if (devEnvelope.ok !== false) errorEnvelopeMisses += 1;
      if (packagedEnvelope.ok !== false) errorEnvelopeMisses += 1;
      if (devEnvelope.error?.code !== "INTERNAL") errorEnvelopeMisses += 1;
      if (packagedEnvelope.error?.code !== "INTERNAL") errorEnvelopeMisses += 1;
      errorEnvelopeMisses += success.misses + devError.misses + gateReject.misses;
      errorEnvelopeMisses += packagedError.misses;
      if (packagedLogCount !== invokes) errorEnvelopeMisses += 1;

      const devMessage = devEnvelope.error?.message ?? "";
      const packagedMessage = packagedEnvelope.error?.message ?? "";
      const packagedUserMessage = packagedEnvelope.error?.userMessage ?? "";

      let sanitizerMisses = 0;
      // Development keeps everything — the control that catches a sanitizer
      // wired onto every build.
      if (!devMessage.includes(PLANTED_PATH)) sanitizerMisses += 1;
      if (!devMessage.includes(PLANTED_SECRET)) sanitizerMisses += 1;
      // Packaged strips both, and says so, so a sanitizer returning "" fails.
      if (packagedMessage.includes(PLANTED_PATH)) sanitizerMisses += 1;
      if (packagedMessage.includes(PLANTED_SECRET)) sanitizerMisses += 1;
      if (!packagedMessage.includes("<path>")) sanitizerMisses += 1;
      if (!packagedMessage.includes("[REDACTED]")) sanitizerMisses += 1;
      if (packagedUserMessage.includes(PLANTED_PATH)) sanitizerMisses += 1;
      if (!packagedUserMessage.includes("<path>")) sanitizerMisses += 1;

      let strippedFieldMisses = 0;
      if (typeof devEnvelope.error?.stack !== "string") strippedFieldMisses += 1;
      if (devEnvelope.error?.context === undefined) strippedFieldMisses += 1;
      if (packagedEnvelope.error?.stack !== undefined) strippedFieldMisses += 1;
      if (packagedEnvelope.error?.context !== undefined) strippedFieldMisses += 1;
      if (packagedEnvelope.error?.cause !== undefined) strippedFieldMisses += 1;
      if (packagedEnvelope.error?.properties !== undefined) strippedFieldMisses += 1;
      if (packagedEnvelope.error?.path !== undefined) strippedFieldMisses += 1;

      const core = await gradeCore(harness);

      const successUs = perInvokeUs(success);
      const packagedUs = perInvokeUs(packagedError);

      return {
        durationMs: success.ms + devError.ms + packagedError.ms + gateReject.ms,
        metrics: {
          invokeCount:
            success.invokes + devError.invokes + packagedError.invokes + gateReject.invokes,
          payloadBytes: jsonArgBytes(args),
          rawMessageBytes: Buffer.byteLength(devMessage, "utf8"),
          sanitizedMessageBytes: Buffer.byteLength(packagedMessage, "utf8"),
          packagedErrorLogCount: packagedLogCount,
          successPerInvokeUs: successUs,
          errorPerInvokeUs: perInvokeUs(devError),
          packagedErrorPerInvokeUs: packagedUs,
          gateRejectPerInvokeUs: perInvokeUs(gateReject),
          errorPathOverheadRatio: ratio(packagedUs, successUs),
          errorEnvelopeMisses,
          sanitizerMisses,
          strippedFieldMisses,
          ...coreMisses(core),
        },
        notes: `a packaged error envelope costs ${ratio(packagedUs, successUs).toFixed(1)}x a success envelope`,
      };
    },
  },
  {
    id: "PERF-364",
    name: "Size-Guard Fail-Open Bail",
    description:
      "The documented fail-open path in validateIpcInvokeEnvelope, priced across eight payload classes on the shipped terminal:spawn channel with its real 256 KiB budget. Every probe is deliberately OVER budget, so acceptance is the observable proof the byte gate was skipped: a Uint8Array on the first key, the same buffer on the last key, a Map, a Set, a cycle and a 60,000-level chain must all be waved through, while a plain payload and a BigInt-bearing one — which bigintSafeReplacer coerces rather than bailing on — must be measured and rejected. Two accumulators, not one: a wrapper that bails on everything scores failOpenMisses, and one that measures nothing scores unmeasuredPayloadMisses.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    warmups: WARMUPS,
    correctness: [
      ...CORE_CORRECTNESS,
      "failOpenMisses",
      "unmeasuredPayloadMisses",
      "bailClassShortfallCount",
    ],
    async run() {
      const harness = await loadEnvelopeHarness();
      const budget = harness.budgetFor(CATEGORY_CHANNEL);
      const oversizeBytes = budget + OVERSIZE_MARGIN_BYTES;
      const corpus = getBailCorpus(oversizeBytes);

      const timings = new Map<BailKey, ArmTiming>();
      const accepted = new Map<BailKey, boolean>();
      let totalMs = 0;
      let invokeCount = 0;

      for (const bailCase of corpus) {
        let acceptedHere = 0;
        const started = performance.now();
        for (let index = 0; index < bailCase.invokes; index += 1) {
          const envelope = await harness.invokeAs(
            TRUSTED_SENDER_URL,
            CATEGORY_CHANNEL,
            bailCase.args
          );
          if (envelope.ok === true) acceptedHere += 1;
        }
        const ms = performance.now() - started;
        totalMs += ms;
        invokeCount += bailCase.invokes;
        timings.set(bailCase.key, { ms, invokes: bailCase.invokes, misses: 0 });
        // Every invoke of a class must agree with every other; a class that
        // answered both ways is graded as not having bailed.
        accepted.set(bailCase.key, acceptedHere === bailCase.invokes);
      }

      let failOpenMisses = 0;
      let unmeasuredPayloadMisses = 0;
      let bailClassShortfall = Math.max(0, EXPECTED_BAIL_CLASSES - corpus.length);
      let bailedClassCount = 0;
      let measuredClassCount = 0;

      // The corpus only exercises the recursion-limit case while the chain is
      // genuinely deeper than the limit. If it stops being, that is a shortfall
      // in the corpus and not a defect in the subject.
      if (!deepChainOverflowsStringify(OVERFLOW_CHAIN_DEPTH)) bailClassShortfall += 1;
      if (oversizeBytes <= budget) bailClassShortfall += 1;

      for (const bailCase of corpus) {
        const wasAccepted = accepted.get(bailCase.key) === true;
        if (wasAccepted) bailedClassCount += 1;
        else measuredClassCount += 1;
        if (bailCase.expectBail && !wasAccepted) failOpenMisses += 1;
        if (!bailCase.expectBail && wasAccepted) unmeasuredPayloadMisses += 1;
      }

      const core = await gradeCore(harness);

      const early = timings.get("earlyBail");
      const late = timings.get("lateBail");
      const plain = timings.get("plain");
      if (!early || !late || !plain) {
        return failClosed("a bail class never ran", {
          ...coreMisses(emptyCoreGrade()),
          failOpenMisses: 0,
          unmeasuredPayloadMisses: 0,
          bailClassShortfallCount: EXPECTED_BAIL_CLASSES,
        });
      }

      const earlyUs = perInvokeUs(early);
      const lateUs = perInvokeUs(late);
      const overDeepBytes = deepChainArgBytes(OVERFLOW_CHAIN_DEPTH);

      return {
        durationMs: totalMs,
        metrics: {
          bailClassCount: corpus.length,
          bailedClassCount,
          measuredClassCount,
          invokeCount,
          oversizePayloadBytes: oversizeBytes,
          overDeepPayloadBytes: overDeepBytes,
          channelBudgetBytes: budget,
          perInvokeUsPlain: perInvokeUs(plain),
          perInvokeUsEarlyBail: earlyUs,
          perInvokeUsLateBail: lateUs,
          perInvokeUsCircular: perInvokeUs(timings.get("circular") ?? plain),
          perInvokeUsOverDeep: perInvokeUs(timings.get("overDeep") ?? plain),
          lateToEarlyBailOverheadRatio: ratio(lateUs, earlyUs),
          failOpenMisses,
          unmeasuredPayloadMisses,
          bailClassShortfallCount: bailClassShortfall,
          ...coreMisses(core),
        },
        notes: `${bailedClassCount} of ${corpus.length} over-budget classes reached the handler unmeasured; the deepest was ${overDeepBytes} bytes against a ${budget}-byte budget`,
      };
    },
  },
];
