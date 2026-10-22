import { describe, expect, it } from "vitest";
import {
  FrameworkExtractionSchema,
  RESOLVE_BUDGET_CEILINGS,
  RESOLVE_LIMITS,
  ResolveCancelSchema,
  ResolveRequestSchema,
  ResolveResponseSchema,
  type FrameworkExtraction,
  type ResolveBudget,
  type ResolveRequest,
} from "../index.js";
import {
  REVISION_A,
  capabilities,
  component,
  creationFrame,
  hover,
  selection,
} from "./fixtures.js";

const budget: ResolveBudget = {
  maxFiles: 4,
  maxFileBytes: 64 * 1024,
  maxNetworkRequests: 2,
  maxNetworkBytes: 256 * 1024,
  deadlineMs: 1_000,
};

function request(overrides: Partial<ResolveRequest> = {}): ResolveRequest {
  return {
    requestId: "req-1",
    sessionId: "session-1",
    documentEpoch: 3,
    workspaceId: "ws-1",
    observations: [selection({ sourceCandidates: [creationFrame()] })],
    knownRevisions: [],
    budget,
    ...overrides,
  };
}

describe("ResolveRequestSchema", () => {
  it("accepts a bounded selection request", () => {
    expect(ResolveRequestSchema.parse(request())).toEqual(request());
  });

  it("never resolves a hover", () => {
    expect(ResolveRequestSchema.safeParse({ ...request(), observations: [hover()] }).success).toBe(
      false
    );
  });

  it("bounds the observations and revisions it carries", () => {
    expect(ResolveRequestSchema.safeParse(request({ observations: [] })).success).toBe(false);
    const many = Array.from({ length: RESOLVE_LIMITS.observations + 1 }, (_, i) =>
      selection({ elementId: `el-${i}` })
    );
    expect(ResolveRequestSchema.safeParse(request({ observations: many })).success).toBe(false);
    const revisions = Array.from({ length: RESOLVE_LIMITS.knownRevisions + 1 }, (_, i) => ({
      file: { workspaceId: "ws-1", path: `src/f${i}.ts` },
      revision: REVISION_A,
    }));
    expect(ResolveRequestSchema.safeParse(request({ knownRevisions: revisions })).success).toBe(
      false
    );
  });

  it.each(Object.keys(RESOLVE_BUDGET_CEILINGS) as (keyof ResolveBudget)[])(
    "refuses a budget whose %s exceeds its ceiling",
    (key) => {
      const over = { ...budget, [key]: RESOLVE_BUDGET_CEILINGS[key] + 1 };
      expect(ResolveRequestSchema.safeParse(request({ budget: over })).success).toBe(false);
      const at = { ...budget, [key]: RESOLVE_BUDGET_CEILINGS[key] };
      expect(ResolveRequestSchema.safeParse(request({ budget: at })).success).toBe(true);
    }
  );

  it("requires a deadline and per-file allowance above zero", () => {
    expect(
      ResolveRequestSchema.safeParse(request({ budget: { ...budget, deadlineMs: 0 } })).success
    ).toBe(false);
    expect(
      ResolveRequestSchema.safeParse(request({ budget: { ...budget, maxFileBytes: 0 } })).success
    ).toBe(false);
  });
});

describe("resolve responses and cancellation", () => {
  const file = { workspaceId: "ws-1", path: "src/Card.tsx" };
  const claim = { candidateId: "c-1", claim: "element-creation" } as const;
  const response = {
    requestId: "req-1",
    documentEpoch: 3,
    outcomes: [
      {
        elementId: "el-1",
        results: [
          {
            state: "verified",
            ...claim,
            target: { file, location: null },
            fileRevision: REVISION_A,
          },
          {
            state: "unavailable",
            candidateId: "c-2",
            claim: "component-definition",
            reason: "budget-exhausted",
          },
          { state: "unavailable", candidateId: "c-3", claim: "file-hint", reason: "cancelled" },
        ],
      },
    ],
  };

  it("carries resolved, refused and cancelled work side by side", () => {
    expect(ResolveResponseSchema.parse(response)).toEqual(response);
  });

  it("rejects a malformed result inside a response", () => {
    const missingTarget = { state: "observed", ...claim };
    expect(
      ResolveResponseSchema.safeParse({
        ...response,
        outcomes: [{ elementId: "el-1", results: [missingTarget] }],
      }).success
    ).toBe(false);
  });

  it("bounds the results it returns per observation", () => {
    const result = { state: "unavailable", ...claim, reason: "unsupported" };
    const results = Array.from({ length: RESOLVE_LIMITS.resultsPerObservation + 1 }, () => result);
    expect(
      ResolveResponseSchema.safeParse({ ...response, outcomes: [{ elementId: "el-1", results }] })
        .success
    ).toBe(false);
  });

  it("cancels by request id alone", () => {
    expect(ResolveCancelSchema.safeParse({ requestId: "req-1" }).success).toBe(true);
    expect(ResolveCancelSchema.safeParse({ requestId: "req-1", reason: "navigated" }).success).toBe(
      false
    );
  });
});

describe("FrameworkExtractionSchema", () => {
  const extraction: FrameworkExtraction = {
    framework: "react",
    componentChain: {
      nearestId: "card",
      components: [component("card", { rootElementIds: ["el-1"] })],
      truncated: false,
    },
    sourceCandidates: [creationFrame("c-1")],
    frameworkEvidence: [],
    capabilities: capabilities({ line: { state: "unknown" } }),
  };

  it("accepts what an extractor reports for one element", () => {
    expect(FrameworkExtractionSchema.parse(extraction)).toEqual(extraction);
  });

  it("holds an extractor to the same chain and candidate invariants as an observation", () => {
    expect(
      FrameworkExtractionSchema.safeParse({
        ...extraction,
        componentChain: { ...extraction.componentChain, nearestId: "ghost" },
      }).success
    ).toBe(false);
    expect(
      FrameworkExtractionSchema.safeParse({
        ...extraction,
        componentChain: {
          ...extraction.componentChain,
          components: [component("card", { sourceCandidates: [creationFrame("c-1")] })],
        },
      }).success
    ).toBe(false);
  });
});
