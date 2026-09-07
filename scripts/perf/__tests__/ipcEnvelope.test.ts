import { describe, expect, it, vi } from "vitest";

// Vitest resolves imports through Vite, so the fixture's Node loader hooks never
// fire here. Hand the same stand-ins to Vite's resolver instead, so the suite
// drives the identical seam the perf runner does.
vi.mock(
  "electron",
  async () => (await import("../lib/ipcEnvelopeFixture")).perfIpcEnvelopeElectronStub
);
vi.mock("../../../electron/services/TelemetryService.js", () => ({
  getCurrentCorrelationId: () => undefined,
  sanitizePath: (value: string) => value,
}));

import {
  buildDeepChainArgs,
  buildShapedArgs,
  buildSizedArgs,
  CATEGORY_CHANNEL,
  deepChainArgBytes,
  deepChainOverflowsStringify,
  echoedInput,
  gradeCore,
  jsonArgBytes,
  jsonEqual,
  loadEnvelopeHarness,
  padToExactBytes,
  PLAIN_CHANNEL,
  readReportedBytes,
  SHAPE_TARGET_BYTES,
  TRUSTED_SENDER_URL,
  UNTRUSTED_SENDER_URL,
  validPayloadForSchema,
  VALIDATED_SCHEMA,
  type PayloadShape,
} from "../lib/ipcEnvelopeFixture";
import { ipcEnvelopeScenarios } from "../scenarios/ipcEnvelope";
import { classifyMetric } from "../lib/comparability";

/**
 * Two things this suite exists for, neither of which the perf run covers.
 *
 * The perf run gates nothing and is not on pull requests, so the module graph
 * behind PERF-360..364 — the real `electron/setup/security.ts` and
 * `electron/ipc/utils.ts` loaded outside Electron — can break without breaking
 * anything else. Running each scenario once links that graph in ordinary CI.
 *
 * The rest is the ORACLES. Every predicate in this family compares what the
 * wrapper did against arithmetic this fixture did itself, and an oracle whose
 * arithmetic quietly stops describing the corpus turns a miss count into
 * decoration that reports zero forever.
 */

const SHAPES: readonly PayloadShape[] = ["flat", "wide", "deep", "array"];

/**
 * The class every metric this family emits must classify as.
 *
 * Declared rather than derived, because the failure it guards is a metric named
 * so that `classifyMetric` reads a deterministic byte count as machine-dependent
 * (losing a comparison that travels) or a wall-clock reading as a count (which
 * the matrix test would then accept as a correctness predicate).
 */
const EXPECTED_METRIC_CLASSES: Record<string, string> = {
  invokeCount: "count",
  measuredBytesTotal: "size",
  perInvokeUs128B: "duration",
  perInvokeUs4KiB: "duration",
  perInvokeUs64KiB: "duration",
  perInvokeUs512KiB: "duration",
  sizeScalingOverheadRatio: "derived-ratio",
  shapeCount: "count",
  shapePayloadBytes: "size",
  widePayloadKeyCount: "count",
  deepPayloadDepthCount: "count",
  arrayPayloadRowCount: "count",
  perInvokeUsFlat: "duration",
  perInvokeUsWide: "duration",
  perInvokeUsDeep: "duration",
  perInvokeUsArray: "duration",
  deepToFlatOverheadRatio: "derived-ratio",
  wideToFlatOverheadRatio: "derived-ratio",
  shapeShortfallCount: "count",
  payloadBytes: "size",
  schemaFieldCount: "count",
  validationLogCount: "count",
  unvalidatedPerInvokeUs: "duration",
  validatedPerInvokeUs: "duration",
  schemaValidationOverheadRatio: "derived-ratio",
  schemaAcceptMisses: "count",
  schemaRejectMisses: "count",
  unvalidatedGateMisses: "count",
  rawMessageBytes: "size",
  sanitizedMessageBytes: "size",
  packagedErrorLogCount: "count",
  successPerInvokeUs: "duration",
  errorPerInvokeUs: "duration",
  packagedErrorPerInvokeUs: "duration",
  gateRejectPerInvokeUs: "duration",
  errorPathOverheadRatio: "derived-ratio",
  errorEnvelopeMisses: "count",
  sanitizerMisses: "count",
  strippedFieldMisses: "count",
  bailClassCount: "count",
  bailedClassCount: "count",
  measuredClassCount: "count",
  oversizePayloadBytes: "size",
  overDeepPayloadBytes: "size",
  channelBudgetBytes: "size",
  perInvokeUsPlain: "duration",
  perInvokeUsEarlyBail: "duration",
  perInvokeUsLateBail: "duration",
  perInvokeUsCircular: "duration",
  perInvokeUsOverDeep: "duration",
  lateToEarlyBailOverheadRatio: "derived-ratio",
  failOpenMisses: "count",
  unmeasuredPayloadMisses: "count",
  bailClassShortfallCount: "count",
  wrapperInstallMisses: "count",
  senderTrustMisses: "count",
  argCountMisses: "count",
  byteMeasurementMisses: "count",
  roundTripMisses: "count",
};

const SCENARIO_TIMEOUT_MS = 120_000;

describe("ipc envelope perf fixture", () => {
  it("loads the real security and ipc modules outside Electron", async () => {
    const harness = await loadEnvelopeHarness();
    // Proven by an envelope appearing around a listener registered through the
    // RAW ipcMain.handle that returns a bare string — not by comparing function
    // identities, which typedHandle's own wrapper would satisfy on its own.
    expect(harness.wrapperInstalled).toBe(true);
    // The budget comes from the product's own category table, via a shipped
    // channel name, not from a constant this suite chose.
    expect(harness.budgetFor(CATEGORY_CHANNEL)).toBe(256 * 1024);
    expect(harness.budgetFor(PLAIN_CHANNEL)).toBe(harness.modules.DEFAULT_PAYLOAD_BUDGET);
  });

  it("clears every core predicate against the real wrapper", async () => {
    const harness = await loadEnvelopeHarness();
    expect(await gradeCore(harness)).toEqual({
      wrapperInstallMisses: 0,
      senderTrustMisses: 0,
      argCountMisses: 0,
      byteMeasurementMisses: 0,
      roundTripMisses: 0,
    });
  });

  it("rejects an untrusted sender and serves a trusted one on the same channel", async () => {
    const harness = await loadEnvelopeHarness();
    const trusted = await harness.invokeAs(TRUSTED_SENDER_URL, PLAIN_CHANNEL, [{ a: 1 }]);
    const untrusted = await harness.invokeAs(UNTRUSTED_SENDER_URL, PLAIN_CHANNEL, [{ a: 1 }]);
    expect(trusted.ok).toBe(true);
    expect(untrusted.ok).toBe(false);
  });

  it("reports the byte count it measured, to the byte, on a budget rejection", async () => {
    const harness = await loadEnvelopeHarness();
    const budget = harness.budgetFor(CATEGORY_CHANNEL);
    const over = buildSizedArgs(budget + 1);
    const envelope = await harness.invokeAs(TRUSTED_SENDER_URL, CATEGORY_CHANNEL, over);
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("PAYLOAD_TOO_LARGE");
    expect(readReportedBytes(envelope)).toBe(jsonArgBytes(over));
    expect(readReportedBytes(envelope)).toBe(budget + 1);
  });
});

describe("byte arithmetic", () => {
  it("pads every shape to exactly the declared target", () => {
    for (const shape of SHAPES) {
      expect(jsonArgBytes(buildShapedArgs(shape, SHAPE_TARGET_BYTES))).toBe(SHAPE_TARGET_BYTES);
    }
  });

  it("pads the flat sweep corpus to exactly each requested size", () => {
    for (const bytes of [128, 4 * 1024, 64 * 1024, 512 * 1024]) {
      expect(jsonArgBytes(buildSizedArgs(bytes))).toBe(bytes);
    }
  });

  it("refuses a target below a shape's own floor rather than silently undershooting", () => {
    // A silent undershoot is how a corpus stops describing what it claims to.
    expect(() => buildShapedArgs("array", 16)).toThrow(/floor/);
  });

  it("computes a deep chain's serialized size without serializing it", () => {
    // The arithmetic PERF-364 leans on for a payload neither the subject nor
    // this fixture can stringify. Checked at a depth where both still can.
    for (const depth of [1, 10, 1000]) {
      expect(deepChainArgBytes(depth)).toBe(jsonArgBytes(buildDeepChainArgs(depth)));
    }
  });

  it("finds the replacer-induced recursion ceiling where PERF-364 claims it is", () => {
    // A replacer of any kind moves V8 off its iterative serializer. Both halves
    // matter: shallow must NOT overflow or the fail-open arm is measuring the
    // wrong thing, and deep must overflow or the corpus stopped exercising it.
    expect(deepChainOverflowsStringify(1000)).toBe(false);
    expect(deepChainOverflowsStringify(60_000)).toBe(true);
  });

  it("padToExactBytes hits the target rather than approaching it", () => {
    const args = padToExactBytes((pad) => [{ k: pad }], 4096);
    expect(jsonArgBytes(args)).toBe(4096);
  });
});

describe("oracle helpers", () => {
  it("echoedInput fails a no-op envelope and passes a real round trip", () => {
    const sent = { a: 1 };
    expect(echoedInput({ __daintreeIpcEnvelope: true, ok: true, data: undefined }, sent)).toBe(
      false
    );
    expect(echoedInput({ ok: true, data: { echo: sent, argCount: 1 } }, sent)).toBe(false);
    expect(
      echoedInput(
        { __daintreeIpcEnvelope: true, ok: true, data: { echo: sent, argCount: 1 } },
        sent
      )
    ).toBe(true);
    // A structurally identical but different object is NOT a round trip: the
    // term exists to prove the listener received our arguments.
    expect(
      echoedInput(
        { __daintreeIpcEnvelope: true, ok: true, data: { echo: { a: 1 }, argCount: 1 } },
        sent
      )
    ).toBe(false);
  });

  it("jsonEqual separates a mutated payload from an intact one", () => {
    expect(jsonEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(jsonEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEqual({ a: 1, b: undefined }, { a: 1 })).toBe(false);
  });

  it("readReportedBytes reads the wrapper's own number from either source", () => {
    expect(readReportedBytes({ error: { context: { bytes: 4096 } } })).toBe(4096);
    expect(
      readReportedBytes({ error: { message: "IPC payload too large for x: 4096 > 1024 bytes" } })
    ).toBe(4096);
    expect(readReportedBytes({ error: { message: "something else" } })).toBe(null);
  });

  it("the validated corpus is valid and the invalid one fails exactly one field", () => {
    const valid = validPayloadForSchema("");
    expect(VALIDATED_SCHEMA.safeParse(valid).success).toBe(true);
    const invalid = { ...valid, cols: -1 };
    const parsed = VALIDATED_SCHEMA.safeParse(invalid);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.length).toBe(1);
  });
});

describe("scenario execution", () => {
  const context = { mode: "smoke" as const, now: () => performance.now() };

  for (const scenario of ipcEnvelopeScenarios) {
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
    "PERF-364 proves the fail-open path is real and two-sided",
    async () => {
      const scenario = ipcEnvelopeScenarios.find((s) => s.id === "PERF-364");
      expect(scenario).toBeDefined();
      const sample = await scenario!.run(context);
      const metrics = sample.metrics ?? {};
      // Six of the eight classes are documented to fail open; two — a plain
      // payload and a BigInt-bearing one — must be measured and rejected. If both
      // halves are not present the scenario cannot distinguish a guard that bails
      // on everything from one that measures nothing.
      expect(metrics.bailClassCount).toBe(8);
      expect(metrics.bailedClassCount).toBe(6);
      expect(metrics.measuredClassCount).toBe(2);
      // The deep payload really is over the channel's own budget, so acceptance
      // is proof the byte gate was skipped rather than proof it passed.
      expect(metrics.overDeepPayloadBytes).toBeGreaterThan(metrics.channelBudgetBytes!);
      expect(metrics.oversizePayloadBytes).toBeGreaterThan(metrics.channelBudgetBytes!);
    },
    SCENARIO_TIMEOUT_MS
  );
});
