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
const otherTarget = { file: { ...file, path: "src/components/CardAlt.tsx" }, location: line };
const sourceMap = {
  mapUrl: "http://localhost:5173/src/components/Card.tsx.map",
  mapRevision: REVISION_B,
};
const claim = { candidateId: "c-1", claim: "element-creation" } as const;

type Of<S extends ResolutionResult["state"]> = Extract<ResolutionResult, { state: S }>;

const observed: Of<"observed"> = { state: "observed", ...claim, target, fileRevision: null };
const mapped: Of<"mapped"> = { state: "mapped", ...claim, target, fileRevision: null, sourceMap };
const verified: Of<"verified"> = {
  state: "verified",
  ...claim,
  target,
  fileRevision: REVISION_A,
  sourceMap,
};
const checkedAlternative = { state: "verified", target, fileRevision: REVISION_A } as const;
const readAlternative = {
  state: "observed",
  target: otherTarget,
  fileRevision: REVISION_B,
} as const;
const ambiguous: Of<"ambiguous"> = {
  state: "ambiguous",
  ...claim,
  alternatives: [checkedAlternative, readAlternative],
};
const stale: Of<"stale"> = {
  state: "stale",
  ...claim,
  held: { state: "verified", target, fileRevision: REVISION_A },
  currentFileRevision: REVISION_B,
  reason: "file-changed",
};
const unavailable: Of<"unavailable"> = { state: "unavailable", ...claim, reason: "map-missing" };

const everyState: ResolutionResult[] = [observed, mapped, verified, ambiguous, stale, unavailable];

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
    const { sourceMap: _map, ...unmapped } = mapped;
    expect(ResolutionResultSchema.safeParse(unmapped).success).toBe(false);
  });

  it("never lets a result claim a check without the revision it checked", () => {
    expect(ResolutionResultSchema.safeParse({ ...verified, fileRevision: null }).success).toBe(
      false
    );
    expect(
      ResolutionResultSchema.safeParse({ ...observed, fileRevision: REVISION_A }).success
    ).toBe(true);
  });

  describe("stale", () => {
    it("keeps what the claim held apart from what is on disk now", () => {
      const { currentFileRevision: _current, ...unsaid } = stale;
      expect(ResolutionResultSchema.safeParse(unsaid).success).toBe(false);
      expect(
        ResolutionResultSchema.safeParse({
          ...stale,
          currentFileRevision: null,
          reason: "file-missing",
        }).success
      ).toBe(true);
      expect(ResolutionResultSchema.safeParse({ ...stale, reason: "edited" }).success).toBe(false);
    });

    it("keeps the map a mapping went stale through", () => {
      const mapChanged = {
        ...stale,
        held: { state: "mapped", target, fileRevision: null, sourceMap },
        currentFileRevision: null,
        reason: "map-changed",
      };
      expect(ResolutionResultSchema.safeParse(mapChanged).success).toBe(true);
      const { sourceMap: _map, ...withoutMap } = mapChanged.held;
      expect(ResolutionResultSchema.safeParse({ ...mapChanged, held: withoutMap }).success).toBe(
        false
      );
    });

    it("can retire a claim that was never read when its document is replaced", () => {
      const documentChanged = {
        ...stale,
        held: { state: "observed", target, fileRevision: null },
        currentFileRevision: null,
        reason: "document-changed",
      };
      expect(ResolutionResultSchema.safeParse(documentChanged).success).toBe(true);
      expect(
        ResolutionResultSchema.safeParse({
          ...documentChanged,
          held: { ...documentChanged.held, state: "verified" },
        }).success
      ).toBe(false);
    });
  });

  describe("ambiguous", () => {
    it("says how far each alternative got", () => {
      const { state: _state, ...stateless } = checkedAlternative;
      expect(
        ResolutionResultSchema.safeParse({
          ...ambiguous,
          alternatives: [stateless, readAlternative],
        }).success
      ).toBe(false);
      expect(
        ResolutionResultSchema.safeParse({
          ...ambiguous,
          alternatives: [{ ...checkedAlternative, fileRevision: null }, readAlternative],
        }).success
      ).toBe(false);
    });

    it("is bounded and names no winner", () => {
      const alternative = checkedAlternative;
      expect(
        ResolutionResultSchema.safeParse({ ...ambiguous, alternatives: [alternative] }).success
      ).toBe(false);
      expect(
        ResolutionResultSchema.safeParse({
          ...ambiguous,
          alternatives: Array.from(
            { length: RESOLUTION_LIMITS.alternatives + 1 },
            () => alternative
          ),
        }).success
      ).toBe(false);
      expect(ResolutionResultSchema.safeParse({ ...ambiguous, target }).success).toBe(false);
      expect(
        ResolutionResultSchema.safeParse({ ...ambiguous, alternatives: [ambiguous, alternative] })
          .success
      ).toBe(false);
    });
  });

  it("makes a mismatch name the file and revision it was checked against", () => {
    const mismatch = { ...unavailable, reason: "mismatch" };
    expect(ResolutionResultSchema.safeParse(mismatch).success).toBe(false);
    expect(
      ResolutionResultSchema.safeParse({ ...mismatch, read: { file, fileRevision: REVISION_A } })
        .success
    ).toBe(true);
    expect(
      ResolutionResultSchema.safeParse({ ...mismatch, read: { file, fileRevision: null } }).success
    ).toBe(false);
  });

  it("resolves a file-hint to a file and never to a line, in any state", () => {
    const hint = { candidateId: "c-1", claim: "file-hint" } as const;
    const fileOnly = { file, location: null };
    const accepts = (result: unknown) => ResolutionResultSchema.safeParse(result).success;

    expect(accepts({ ...verified, ...hint, target: fileOnly })).toBe(true);
    expect(accepts({ ...verified, ...hint })).toBe(false);
    expect(accepts({ ...observed, ...hint })).toBe(false);
    expect(accepts({ ...mapped, ...hint })).toBe(false);
    expect(
      accepts({
        ...ambiguous,
        ...hint,
        alternatives: [
          { state: "observed", target: fileOnly, fileRevision: null },
          { state: "observed", target, fileRevision: null },
        ],
      })
    ).toBe(false);
    expect(accepts({ ...stale, ...hint })).toBe(false);
    expect(
      accepts({
        ...stale,
        ...hint,
        held: { state: "observed", target: fileOnly, fileRevision: null },
      })
    ).toBe(true);
  });

  it("rejects a revision that is not a sha256 content hash", () => {
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
    expect(ResolutionResultSchema.safeParse({ ...observed, state: "guessed" }).success).toBe(false);
    expect(ResolutionResultSchema.safeParse({ ...unavailable, reason: "unlucky" }).success).toBe(
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
    "src/",
    `src/${String.fromCharCode(0)}.ts`,
    "",
  ])("rejects %j", (path) => {
    expect(SourceFileRefSchema.safeParse({ ...file, path }).success).toBe(false);
  });
});
