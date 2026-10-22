import { describe, expect, it } from "vitest";
import {
  FrameworkExtractionSchema,
  RESOLVE_BUDGET_CEILINGS,
  RESOLVE_LIMITS,
  ResolveCancelSchema,
  ResolveRequestSchema,
  ResolveResponseSchema,
  type GuestFrameworkExtractor,
  type HostSourceResolver,
  type ResolveBudget,
  type ResolveRequest,
  type ResolverSourceAccess,
  type ResolutionResult,
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
  it("rejects a malformed result inside a response", () => {
    const response = {
      requestId: "req-1",
      documentEpoch: 3,
      outcomes: [
        {
          elementId: "el-1",
          results: [{ state: "observed", candidateId: "c-1", claim: "element-creation" }],
        },
      ],
    };
    expect(ResolveResponseSchema.safeParse(response).success).toBe(false);
  });

  it("cancels by request id alone", () => {
    expect(ResolveCancelSchema.safeParse({ requestId: "req-1" }).success).toBe(true);
    expect(ResolveCancelSchema.safeParse({ requestId: "req-1", reason: "navigated" }).success).toBe(
      false
    );
  });
});

describe("resolver contracts", () => {
  /** A resolver written only against the contract: it sees bytes the access hands it, never a path it opens. */
  const stubResolver: HostSourceResolver = {
    framework: "react",
    async resolve(req, access, signal) {
      const outcomes = await Promise.all(
        req.observations.map(async (observation) => {
          const results: ResolutionResult[] = [];
          for (const candidate of observation.sourceCandidates) {
            const claim = { candidateId: candidate.candidateId, claim: candidate.kind };
            if (signal.aborted) {
              results.push({ state: "unavailable", ...claim, reason: "cancelled" });
              continue;
            }
            const file = { workspaceId: req.workspaceId, path: "src/Card.tsx" };
            const read = await access.readSource(file, signal);
            results.push(
              read.ok
                ? {
                    state: "verified",
                    ...claim,
                    target: { file, location: null },
                    fileRevision: read.value.revision,
                  }
                : { state: "unavailable", ...claim, reason: read.reason }
            );
          }
          return { elementId: observation.elementId, results };
        })
      );
      return { requestId: req.requestId, documentEpoch: req.documentEpoch, outcomes };
    },
  };

  const access = (ok: boolean): ResolverSourceAccess => ({
    async readSource(file) {
      return ok
        ? {
            ok: true,
            value: { file, revision: REVISION_A, bytes: new TextEncoder().encode("export {}") },
          }
        : { ok: false, reason: "budget-exhausted" };
    },
    async fetchSourceMap() {
      return { ok: false, reason: "map-missing" };
    },
  });

  it("round-trips a resolve through the schemas, including a read the budget refused", async () => {
    const live = new AbortController().signal;
    const resolved = await stubResolver.resolve(request(), access(true), live);
    expect(ResolveResponseSchema.parse(resolved).outcomes[0]?.results[0]).toMatchObject({
      state: "verified",
      fileRevision: REVISION_A,
    });
    const refused = await stubResolver.resolve(request(), access(false), live);
    expect(ResolveResponseSchema.parse(refused).outcomes[0]?.results[0]).toMatchObject({
      state: "unavailable",
      reason: "budget-exhausted",
    });
  });

  it("reports cancelled work rather than dropping it", async () => {
    const controller = new AbortController();
    controller.abort();
    const response = await stubResolver.resolve(request(), access(true), controller.signal);
    expect(ResolveResponseSchema.parse(response).outcomes[0]?.results[0]).toMatchObject({
      reason: "cancelled",
    });
  });

  it("validates what an extractor hands back as untrusted data", () => {
    type FakeNode = { id: string };
    const extractor: GuestFrameworkExtractor<FakeNode> = {
      framework: "react",
      extract(node, _phase, identity) {
        return {
          framework: "react",
          componentChain: {
            nearestId: "card",
            components: [component("card", { rootElementIds: [identity.elementId(node)] })],
            truncated: false,
          },
          sourceCandidates: [creationFrame()],
          frameworkEvidence: [],
          capabilities: capabilities({ line: { state: "unknown" } }),
        };
      },
      componentRoots: () => ({ roots: [], complete: true }),
    };

    const extraction = extractor.extract({ id: "n" }, "selection", {
      elementId: (node) => `el-${node.id}`,
    });
    expect(
      FrameworkExtractionSchema.parse(extraction).componentChain.components[0]?.rootElementIds
    ).toEqual(["el-n"]);
    expect(
      FrameworkExtractionSchema.safeParse({
        ...extraction,
        componentChain: { nearestId: "ghost", components: [], truncated: false },
      }).success
    ).toBe(false);
  });
});
