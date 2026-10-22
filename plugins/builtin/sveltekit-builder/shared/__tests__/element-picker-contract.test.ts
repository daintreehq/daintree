import { describe, expect, it } from "vitest";
import {
  COORDINATE_CONVENTIONS,
  ELEMENT_CONTEXT_LIMITS as NEUTRAL_CONTEXT_LIMITS,
  ElementContextSchema as NeutralElementContextSchema,
  SelectionObservationSchema,
  type SelectionObservation,
  type SvelteEvidence,
} from "../../../../../shared/elementPicker/index.js";
import {
  ELEMENT_CONTEXT_LIMITS,
  ElementContextSchema,
  GuestNodeObservationSchema,
  type GuestNodeObservation,
} from "../protocol.js";

/**
 * The neutral Element Picker contracts must hold everything the Svelte guest
 * reports today, so the port (#13873) can move to them without dropping a
 * field. These conversions are test-local on purpose: they prove the shapes
 * fit, and the real mapping belongs to the port.
 */

const LOC_FIELD = "__svelte_meta.loc";

function toNeutral(node: GuestNodeObservation): SelectionObservation {
  const evidence: SvelteEvidence = {
    kind: "svelte",
    ancestry: node.ancestry,
    sameLocCount: node.sameLocCount,
    ...(node.sameLocCountPartial && { sameLocCountPartial: node.sameLocCountPartial }),
    ...(node.locIndex !== undefined && { locIndex: node.locIndex }),
    ...(node.structure && { structure: node.structure }),
    unmapped: node.unmapped,
  };
  return {
    phase: "selection",
    elementId: node.runtimeOccurrenceId,
    tagName: node.tagName,
    label: node.label,
    bounds: node.bounds,
    detections: [{ framework: "svelte", signals: [{ via: "expando", name: "__svelte_meta" }] }],
    // Svelte names call sites, not instances: no component identity is minted from them.
    componentChain: { nearestId: null, components: [], truncated: false },
    sourceCandidates: node.loc
      ? [
          {
            kind: "template-location",
            candidateId: "svelte-loc",
            framework: "svelte",
            extraction: { kind: "runtime-field", field: LOC_FIELD },
            file: node.loc.file,
            location: {
              ...COORDINATE_CONVENTIONS.svelteMeta,
              columnUnit: "utf16",
              line: node.loc.line,
              column: node.loc.column,
            },
          },
        ]
      : [],
    capabilities: {
      names: { state: "available" },
      chain: { state: "available" },
      componentSelection: { state: "available" },
      file: node.loc ? { state: "available" } : { state: "unavailable", reason: "unmapped" },
      line: node.loc ? { state: "available" } : { state: "unavailable", reason: "unmapped" },
      exactRange: { state: "unknown" },
    },
    frameworkEvidence: [evidence],
    ...(node.context && { context: node.context }),
  };
}

function fromNeutral(observation: SelectionObservation): GuestNodeObservation {
  const evidence = observation.frameworkEvidence.find((entry) => entry.kind === "svelte");
  if (!evidence) throw new Error("no Svelte evidence");
  const loc = observation.sourceCandidates.find(
    (candidate) =>
      candidate.extraction.kind === "runtime-field" && candidate.extraction.field === LOC_FIELD
  );
  return {
    runtimeOccurrenceId: observation.elementId,
    loc:
      loc && "location" in loc
        ? { file: loc.file, line: loc.location.line, column: loc.location.column }
        : null,
    ancestry: evidence.ancestry,
    tagName: observation.tagName,
    sameLocCount: evidence.sameLocCount,
    ...(evidence.sameLocCountPartial && { sameLocCountPartial: evidence.sameLocCountPartial }),
    ...(evidence.locIndex !== undefined && { locIndex: evidence.locIndex }),
    ...(evidence.structure && { structure: evidence.structure }),
    label: observation.label,
    bounds: observation.bounds,
    unmapped: evidence.unmapped,
    ...(observation.context && { context: observation.context }),
  };
}

const full = GuestNodeObservationSchema.parse({
  runtimeOccurrenceId: "occ-17",
  loc: { file: "src/lib/PricingCard.svelte", line: 14, column: 0 },
  ancestry: [
    { type: "each", file: "src/lib/PricingCard.svelte", line: 12, column: 1 },
    { type: "if", file: "src/lib/PricingCard.svelte", line: 10, column: 0 },
    { type: "await", file: "src/lib/PricingCard.svelte", line: 8, column: 0 },
    { type: "key", file: "src/lib/PricingCard.svelte", line: 6, column: 0 },
    { type: "snippet", file: "src/routes/+page.svelte", line: 22, column: 1 },
    { type: "render", file: "src/routes/+page.svelte", line: 30, column: 2 },
    { type: "boundary", file: "src/routes/+page.svelte", line: 4, column: 0 },
    {
      type: "component",
      file: "src/routes/+page.svelte",
      line: 31,
      column: 2,
      componentTag: "PricingCard",
    },
  ],
  tagName: "button",
  sameLocCount: 3,
  sameLocCountPartial: true,
  locIndex: 2,
  structure: {
    file: "src/lib/PricingCard.svelte",
    path: [
      { tag: "div", index: 0 },
      { tag: "button", index: 1 },
    ],
  },
  label: 'button "Start Pro"',
  bounds: [
    { x: 10, y: 20, width: 120, height: 32 },
    { x: 10, y: 60, width: 120, height: 32 },
  ],
  unmapped: false,
  context: {
    selector: "main > div.cards > button",
    markup: '<button class="cta">Start Pro</button>',
    markupTruncated: true,
    styles: [{ property: "background-color", value: "rgb(17, 24, 39)" }],
  },
});

const minimal = GuestNodeObservationSchema.parse({
  runtimeOccurrenceId: "occ-1",
  loc: null,
  ancestry: [],
  tagName: "canvas",
  sameLocCount: 1,
  label: "canvas",
  bounds: [],
  unmapped: true,
});

describe("Svelte guest observations on the neutral contract", () => {
  it.each([
    ["a fully stamped node", full],
    ["an unstamped node with nothing optional", minimal],
  ])("carries %s across and back without losing a field", (_, legacy) => {
    const neutral = SelectionObservationSchema.parse(toNeutral(legacy));
    expect(GuestNodeObservationSchema.parse(fromNeutral(neutral))).toEqual(legacy);
  });

  it("keeps Svelte's block ancestry in order instead of flattening it into components", () => {
    const neutral = SelectionObservationSchema.parse(toNeutral(full));
    const evidence = neutral.frameworkEvidence[0];
    expect(evidence.kind === "svelte" && evidence.ancestry.map((entry) => entry.type)).toEqual(
      full.ancestry.map((entry) => entry.type)
    );
    expect(neutral.componentChain.components).toEqual([]);
  });
});

describe("page context ceilings", () => {
  it("are the same on both contracts", () => {
    expect(NEUTRAL_CONTEXT_LIMITS).toEqual(ELEMENT_CONTEXT_LIMITS);
  });

  it.each([
    ["at every ceiling", 0],
    ["one past every ceiling", 1],
  ])("accept and reject the same context %s", (_, past) => {
    const context = {
      selector: "s".repeat(ELEMENT_CONTEXT_LIMITS.selector + past),
      markup: "m".repeat(ELEMENT_CONTEXT_LIMITS.markup + past),
      styles: Array.from({ length: ELEMENT_CONTEXT_LIMITS.styles + past }, () => ({
        property: "p".repeat(ELEMENT_CONTEXT_LIMITS.property + past),
        value: "v".repeat(ELEMENT_CONTEXT_LIMITS.value + past),
      })),
    };
    const expected = past === 0;
    expect([
      NeutralElementContextSchema.safeParse(context).success,
      ElementContextSchema.safeParse(context).success,
    ]).toEqual([expected, expected]);
  });
});
