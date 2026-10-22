import { describe, expect, it } from "vitest";
import {
  COORDINATE_CONVENTIONS,
  RESOLUTION_LIMITS,
  ResolutionResultSchema,
  SourceFileRefSchema,
  type ResolutionResult,
} from "../index.js";
import { REVISION_A, REVISION_B } from "./fixtures.js";

const file = { workspaceId: "ws-1", path: "src/components/Card.tsx" };
const line = {
  ...COORDINATE_CONVENTIONS.sourceMap,
  columnUnit: "utf16",
  line: 42,
  column: 6,
} as const;
const target = { file, location: line };
const sourceMap = {
  mapUrl: "http://localhost:5173/src/components/Card.tsx.map",
  mapRevision: REVISION_B,
};
const claim = { candidateId: "c-1", claim: "element-creation" } as const;

const everyState: ResolutionResult[] = [
  { state: "observed", ...claim, target, fileRevision: null },
  { state: "mapped", ...claim, target, fileRevision: null, sourceMap },
  { state: "verified", ...claim, target, fileRevision: REVISION_A, sourceMap },
  {
    state: "ambiguous",
    ...claim,
    alternatives: [
      { target, fileRevision: REVISION_A },
      {
        target: { file: { ...file, path: "src/components/CardAlt.tsx" }, location: line },
        fileRevision: null,
      },
    ],
  },
  {
    state: "stale",
    ...claim,
    target,
    fileRevision: REVISION_A,
    currentFileRevision: REVISION_B,
    reason: "file-changed",
  },
  { state: "unavailable", ...claim, reason: "map-missing" },
];

describe("ResolutionResultSchema", () => {
  it.each(everyState.map((result) => [result.state, result] as const))(
    "accepts a %s result",
    (_, result) => {
      expect(ResolutionResultSchema.parse(result)).toEqual(result);
    }
  );

  it.each(everyState.map((result) => [result.state, result] as const))(
    "rejects a confidence number on a %s result",
    (_, result) => {
      expect(ResolutionResultSchema.safeParse({ ...result, confidence: 0.9 }).success).toBe(false);
    }
  );

  it("names the map a mapped result came through", () => {
    const { sourceMap: _map, ...unmapped } = everyState[1] as Extract<
      ResolutionResult,
      { state: "mapped" }
    >;
    expect(ResolutionResultSchema.safeParse(unmapped).success).toBe(false);
  });

  it("never lets a result claim a check without the revision it checked", () => {
    expect(ResolutionResultSchema.safeParse({ ...everyState[2], fileRevision: null }).success).toBe(
      false
    );
    expect(ResolutionResultSchema.safeParse({ ...everyState[0], fileRevision: null }).success).toBe(
      true
    );
  });

  it("keeps the revision a stale claim held at apart from what is on disk now", () => {
    const { currentFileRevision: _current, ...unsaid } = everyState[4] as Extract<
      ResolutionResult,
      { state: "stale" }
    >;
    expect(ResolutionResultSchema.safeParse(unsaid).success).toBe(false);
    expect(
      ResolutionResultSchema.safeParse({
        ...everyState[4],
        currentFileRevision: null,
        reason: "file-missing",
      }).success
    ).toBe(true);
    expect(ResolutionResultSchema.safeParse({ ...everyState[4], reason: "edited" }).success).toBe(
      false
    );
  });

  it("holds ambiguity to a bounded set of alternatives with no winner", () => {
    const ambiguous = everyState[3] as Extract<ResolutionResult, { state: "ambiguous" }>;
    const alternative = ambiguous.alternatives[0];
    expect(
      ResolutionResultSchema.safeParse({ ...ambiguous, alternatives: [alternative] }).success
    ).toBe(false);
    expect(
      ResolutionResultSchema.safeParse({
        ...ambiguous,
        alternatives: Array.from({ length: RESOLUTION_LIMITS.alternatives + 1 }, () => alternative),
      }).success
    ).toBe(false);
    expect(ResolutionResultSchema.safeParse({ ...ambiguous, target }).success).toBe(false);
    expect(
      ResolutionResultSchema.safeParse({ ...ambiguous, alternatives: [ambiguous, alternative] })
        .success
    ).toBe(false);
  });

  it("resolves a file-hint to a file and never to a line, verified or not", () => {
    const hint = { candidateId: "c-1", claim: "file-hint" } as const;
    const fileOnly = { file, location: null };
    expect(
      ResolutionResultSchema.safeParse({
        state: "verified",
        ...hint,
        target: fileOnly,
        fileRevision: REVISION_A,
      }).success
    ).toBe(true);
    expect(
      ResolutionResultSchema.safeParse({
        state: "verified",
        ...hint,
        target,
        fileRevision: REVISION_A,
      }).success
    ).toBe(false);
    expect(
      ResolutionResultSchema.safeParse({ state: "observed", ...hint, target, fileRevision: null })
        .success
    ).toBe(false);
    expect(
      ResolutionResultSchema.safeParse({
        state: "ambiguous",
        ...hint,
        alternatives: [
          { target: fileOnly, fileRevision: null },
          { target, fileRevision: null },
        ],
      }).success
    ).toBe(false);
  });

  it("rejects a revision that is not a sha256 content hash", () => {
    const verified = everyState[2];
    expect(
      ResolutionResultSchema.safeParse({ ...verified, fileRevision: "a".repeat(64) }).success
    ).toBe(false);
    expect(
      ResolutionResultSchema.safeParse({ ...verified, fileRevision: `sha256:${"A".repeat(64)}` })
        .success
    ).toBe(false);
    expect(
      ResolutionResultSchema.safeParse({ ...verified, fileRevision: "1700000000000" }).success
    ).toBe(false);
  });

  it("rejects an unknown state or reason", () => {
    expect(ResolutionResultSchema.safeParse({ ...everyState[0], state: "guessed" }).success).toBe(
      false
    );
    expect(ResolutionResultSchema.safeParse({ ...everyState[5], reason: "unlucky" }).success).toBe(
      false
    );
  });
});

describe("SourceFileRefSchema", () => {
  it("accepts a contained workspace-relative POSIX path", () => {
    expect(SourceFileRefSchema.safeParse(file).success).toBe(true);
    expect(SourceFileRefSchema.safeParse({ ...file, path: "+page.svelte" }).success).toBe(true);
  });

  it.each([
    "/etc/passwd",
    "../outside.ts",
    "src/../../x.ts",
    "src\\Card.tsx",
    "C:/x.ts",
    "src//x.ts",
    "./x.ts",
    "",
  ])("rejects %j", (path) => {
    expect(SourceFileRefSchema.safeParse({ ...file, path }).success).toBe(false);
  });
});
