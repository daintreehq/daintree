import { describe, expect, it } from "vitest";
import {
  COORDINATE_CONVENTIONS,
  ExtractionSchema,
  MAX_SOURCE_COORDINATE,
  ObservedNameSchema,
  SourceCandidateSchema,
  SourceLocationSchema,
} from "../index.js";
import { creationFrame } from "./fixtures.js";

const svelte = { ...COORDINATE_CONVENTIONS.svelteMeta, columnUnit: "utf16" } as const;
const v8 = { ...COORDINATE_CONVENTIONS.v8StackFrame, columnUnit: "utf16" } as const;

describe("SourceLocationSchema", () => {
  it("keeps each runtime's convention as reported", () => {
    expect(SourceLocationSchema.parse({ ...svelte, line: 1, column: 0 })).toMatchObject({
      lineBase: 1,
      columnBase: 0,
    });
    expect(SourceLocationSchema.safeParse({ ...v8, line: 1, column: 1 }).success).toBe(true);
    expect(
      SourceLocationSchema.safeParse({
        lineBase: 0,
        columnBase: 0,
        columnUnit: "utf16",
        line: 0,
        column: 0,
      }).success
    ).toBe(true);
  });

  it("rejects a position below its own base", () => {
    expect(SourceLocationSchema.safeParse({ ...v8, line: 1, column: 0 }).success).toBe(false);
    expect(SourceLocationSchema.safeParse({ ...svelte, line: 0, column: 0 }).success).toBe(false);
  });

  it("accepts a forward range and rejects one that runs backwards or drops below base", () => {
    expect(
      SourceLocationSchema.safeParse({ ...svelte, line: 4, column: 2, end: { line: 4, column: 9 } })
        .success
    ).toBe(true);
    expect(
      SourceLocationSchema.safeParse({ ...svelte, line: 4, column: 2, end: { line: 4, column: 1 } })
        .success
    ).toBe(false);
    expect(
      SourceLocationSchema.safeParse({ ...svelte, line: 4, column: 2, end: { line: 3, column: 9 } })
        .success
    ).toBe(false);
    // Runs forward, so only the end's base can reject it.
    expect(
      SourceLocationSchema.safeParse({ ...v8, line: 1, column: 1, end: { line: 2, column: 0 } })
        .success
    ).toBe(false);
    expect(
      SourceLocationSchema.safeParse({ ...v8, line: 1, column: 1, end: { line: 2, column: 1 } })
        .success
    ).toBe(true);
  });

  it("rejects other units, other bases, fractions and unbounded numbers", () => {
    expect(
      SourceLocationSchema.safeParse({ ...svelte, columnUnit: "bytes", line: 1, column: 0 }).success
    ).toBe(false);
    expect(
      SourceLocationSchema.safeParse({ ...svelte, lineBase: 2, line: 2, column: 0 }).success
    ).toBe(false);
    expect(SourceLocationSchema.safeParse({ ...svelte, line: 1.5, column: 0 }).success).toBe(false);
    expect(
      SourceLocationSchema.safeParse({ ...svelte, line: MAX_SOURCE_COORDINATE + 1, column: 0 })
        .success
    ).toBe(false);
  });

  it("rejects unknown keys, including inside the range end", () => {
    expect(
      SourceLocationSchema.safeParse({ ...svelte, line: 1, column: 0, offset: 0 }).success
    ).toBe(false);
    expect(
      SourceLocationSchema.safeParse({
        ...svelte,
        line: 1,
        column: 0,
        end: { line: 1, column: 4, offset: 4 },
      }).success
    ).toBe(false);
  });
});

describe("SourceCandidateSchema", () => {
  const extraction = { kind: "runtime-field", field: "__svelte_meta.loc" } as const;
  const location = { ...svelte, line: 12, column: 4 };

  it.each([
    "element-creation",
    "component-invocation",
    "component-definition",
    "template-location",
  ] as const)("accepts a positioned %s claim", (kind) => {
    const candidate = {
      kind,
      candidateId: "c-1",
      framework: "svelte",
      extraction,
      file: "src/routes/+page.svelte",
      location,
    };
    expect(SourceCandidateSchema.parse(candidate)).toEqual(candidate);
    const { location: _location, ...positionless } = candidate;
    expect(SourceCandidateSchema.safeParse(positionless).success).toBe(false);
  });

  it("accepts a file-only hint and rejects one that carries any position", () => {
    const hint = {
      kind: "file-hint",
      candidateId: "c-1",
      framework: "vue",
      extraction: { kind: "runtime-field", field: "type.__file" },
      file: "/repo/src/components/Card.vue",
    };
    expect(SourceCandidateSchema.safeParse(hint).success).toBe(true);
    expect(SourceCandidateSchema.safeParse({ ...hint, location }).success).toBe(false);
    expect(SourceCandidateSchema.safeParse({ ...hint, line: 12 }).success).toBe(false);
    expect(SourceCandidateSchema.safeParse({ ...hint, line: 12, column: 4 }).success).toBe(false);
  });

  it("records a generated stack frame with the field and frame it came from", () => {
    const frame = creationFrame();
    expect(SourceCandidateSchema.parse(frame)).toEqual(frame);
    expect(
      SourceCandidateSchema.safeParse({
        ...frame,
        extraction: { kind: "generated-stack-frame", field: "_debugStack" },
      }).success
    ).toBe(false);
  });

  it("only takes a framework from the fixed set", () => {
    expect(SourceCandidateSchema.safeParse({ ...creationFrame(), framework: "next" }).success).toBe(
      false
    );
    expect(
      SourceCandidateSchema.safeParse({ ...creationFrame(), framework: "jquery" }).success
    ).toBe(false);
  });

  it("rejects an unknown claim kind and an unbounded file", () => {
    expect(SourceCandidateSchema.safeParse({ ...creationFrame(), kind: "guess" }).success).toBe(
      false
    );
    expect(
      SourceCandidateSchema.safeParse({ ...creationFrame(), file: "x".repeat(2049) }).success
    ).toBe(false);
  });
});

describe("ExtractionSchema and ObservedNameSchema", () => {
  it("accepts each extraction kind with its own fields only", () => {
    expect(
      ExtractionSchema.safeParse({ kind: "attribute", attribute: "data-v-inspector" }).success
    ).toBe(true);
    expect(
      ExtractionSchema.safeParse({ kind: "attribute", field: "data-v-inspector" }).success
    ).toBe(false);
    expect(ExtractionSchema.safeParse({ kind: "runtime-field", field: "" }).success).toBe(false);
  });

  it("will not take a name without saying where it was read", () => {
    expect(ObservedNameSchema.safeParse({ value: "Card" }).success).toBe(false);
    expect(
      ObservedNameSchema.safeParse({
        value: "ProductPage",
        extraction: { kind: "runtime-field", field: "_debugInfo[0].name" },
      }).success
    ).toBe(true);
  });
});
