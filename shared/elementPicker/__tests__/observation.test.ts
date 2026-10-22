import { describe, expect, it } from "vitest";
import {
  ELEMENT_CONTEXT_LIMITS,
  EVIDENCE_LIMITS,
  ElementObservationSchema,
  FrameworkEvidenceSchema,
  HoverObservationSchema,
  MAX_LAYOUT_PX,
  OBSERVATION_LIMITS,
  SelectionObservationSchema,
  type ElementContext,
} from "../index.js";
import { capabilities, component, creationFrame, hover, selection } from "./fixtures.js";

const context: ElementContext = {
  selector: "main > button.save",
  markup: '<button class="save">Save</button>',
  styles: [{ property: "color", value: "rgb(0, 0, 0)" }],
};

describe("observations", () => {
  it("accepts a DOM-only selection that says why it has no source", () => {
    const noFramework = { state: "unavailable", reason: "no-framework" } as const;
    const observation = selection({
      context,
      capabilities: capabilities({
        names: noFramework,
        chain: noFramework,
        componentSelection: noFramework,
        file: noFramework,
        line: noFramework,
        exactRange: noFramework,
      }),
    });
    expect(SelectionObservationSchema.parse(observation)).toEqual(observation);
  });

  it("carries page context on a selection and never on a hover", () => {
    expect(SelectionObservationSchema.safeParse(selection({ context })).success).toBe(true);
    expect(SelectionObservationSchema.safeParse(selection()).success).toBe(true);
    expect(HoverObservationSchema.safeParse({ ...hover(), context }).success).toBe(false);
    expect(ElementObservationSchema.safeParse({ ...hover(), context }).success).toBe(false);
  });

  it("has no selector outside the page context to key identity on", () => {
    expect(
      SelectionObservationSchema.safeParse({ ...selection(), selector: "#save" }).success
    ).toBe(false);
    expect(HoverObservationSchema.safeParse({ ...hover(), selector: "#save" }).success).toBe(false);
  });

  it("holds the page context to its ceilings", () => {
    const over = (patch: Partial<ElementContext>) =>
      SelectionObservationSchema.safeParse(selection({ context: { ...context, ...patch } }))
        .success;
    expect(over({ selector: "a".repeat(ELEMENT_CONTEXT_LIMITS.selector) })).toBe(true);
    expect(over({ selector: "a".repeat(ELEMENT_CONTEXT_LIMITS.selector + 1) })).toBe(false);
    expect(over({ markup: "a".repeat(ELEMENT_CONTEXT_LIMITS.markup + 1) })).toBe(false);
    expect(
      over({
        styles: Array.from({ length: ELEMENT_CONTEXT_LIMITS.styles + 1 }, () => ({
          property: "color",
          value: "red",
        })),
      })
    ).toBe(false);
    expect(
      over({ styles: [{ property: "color", value: "red", priority: "important" }] as never })
    ).toBe(false);
  });

  it("bounds geometry, candidates and detections", () => {
    const rect = { x: 0, y: 0, width: 1, height: 1 };
    expect(
      SelectionObservationSchema.safeParse(
        selection({ bounds: Array.from({ length: OBSERVATION_LIMITS.bounds + 1 }, () => rect) })
      ).success
    ).toBe(false);
    const withRect = (patch: Partial<typeof rect>) =>
      SelectionObservationSchema.safeParse(selection({ bounds: [{ ...rect, ...patch }] })).success;
    expect(withRect({ width: -1 })).toBe(false);
    // Scrolled above or left of the viewport: a real box, so negative positions stay legal.
    expect(withRect({ x: -MAX_LAYOUT_PX, y: -120 })).toBe(true);
    expect(withRect({ x: -MAX_LAYOUT_PX - 1 })).toBe(false);
    expect(withRect({ width: Number.MAX_VALUE })).toBe(false);
    expect(withRect({ x: Number.MAX_VALUE })).toBe(false);
    expect(
      SelectionObservationSchema.safeParse(
        selection({
          sourceCandidates: Array.from({ length: OBSERVATION_LIMITS.candidates + 1 }, (_, i) =>
            creationFrame(`c-${i}`)
          ),
        })
      ).success
    ).toBe(false);
    expect(
      SelectionObservationSchema.safeParse(
        selection({ detections: [{ framework: "react", signals: [] }] })
      ).success
    ).toBe(false);
  });

  it("rejects a candidate id reused between the element and a component in its chain", () => {
    const observation = selection({
      sourceCandidates: [creationFrame("c-1")],
      componentChain: {
        nearestId: "card",
        components: [component("card", { sourceCandidates: [creationFrame("c-1")] })],
        truncated: false,
      },
    });
    expect(SelectionObservationSchema.safeParse(observation).success).toBe(false);
    expect(HoverObservationSchema.safeParse({ ...observation, phase: "hover" }).success).toBe(
      false
    );
  });

  it("requires a reason exactly when a capability is unavailable", () => {
    const withLine = (line: unknown) =>
      SelectionObservationSchema.safeParse({
        ...selection(),
        capabilities: { ...capabilities(), line },
      }).success;
    expect(withLine({ state: "unavailable", reason: "not-exposed" })).toBe(true);
    expect(withLine({ state: "unavailable" })).toBe(false);
    expect(withLine({ state: "unknown", reason: "not-exposed" })).toBe(false);
    expect(withLine({ state: "unavailable", reason: "the page says so" })).toBe(false);
    expect(withLine(true)).toBe(false);
  });
});

describe("FrameworkEvidenceSchema", () => {
  const svelte = {
    kind: "svelte",
    ancestry: [{ type: "each", file: "src/routes/+page.svelte", line: 8, column: 2 }],
    sameLocCount: 3,
    locIndex: 1,
    unmapped: false,
  };

  it("keeps a block kind a newer compiler adds instead of failing the observation", () => {
    const future = { ...svelte, ancestry: [{ ...svelte.ancestry[0], type: "boundary" }] };
    expect(FrameworkEvidenceSchema.parse(future)).toEqual(future);
  });

  it("bounds Svelte ancestry depth", () => {
    const deep = Array.from({ length: EVIDENCE_LIMITS.depth + 1 }, () => svelte.ancestry[0]);
    expect(FrameworkEvidenceSchema.safeParse({ ...svelte, ancestry: deep }).success).toBe(false);
  });

  it("takes only flat primitive generic fields", () => {
    const generic = {
      kind: "generic",
      framework: "vue",
      fields: [{ name: "scopeId", value: "data-v-7ba5bd90" }],
    };
    expect(FrameworkEvidenceSchema.safeParse(generic).success).toBe(true);
    expect(
      FrameworkEvidenceSchema.safeParse({
        ...generic,
        fields: [{ name: "instance", value: { uid: 1 } }],
      }).success
    ).toBe(false);
    expect(
      FrameworkEvidenceSchema.safeParse({
        ...generic,
        fields: [{ name: "x", value: "a".repeat(257) }],
      }).success
    ).toBe(false);
    expect(
      FrameworkEvidenceSchema.safeParse({
        ...generic,
        fields: Array.from({ length: EVIDENCE_LIMITS.genericFields + 1 }, (_, i) => ({
          name: `f${i}`,
          value: i,
        })),
      }).success
    ).toBe(false);
  });

  it("rejects an evidence kind it does not know and too many entries", () => {
    expect(FrameworkEvidenceSchema.safeParse({ ...svelte, kind: "react" }).success).toBe(false);
    expect(
      SelectionObservationSchema.safeParse({
        ...selection(),
        frameworkEvidence: Array.from({ length: EVIDENCE_LIMITS.entries + 1 }, () => svelte),
      }).success
    ).toBe(false);
  });
});
