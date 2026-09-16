import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as sveltePARSE } from "svelte/compiler";
import { resolveElementAtLocation } from "../resolve.js";
import {
  planSetClassTokens,
  planSetLiteralProp,
  planSetLiteralText,
  verifyCandidate,
} from "../mutate.js";
import { lineColumnToOffset } from "../splice.js";
import type { DevLocation, ResolvedElement, SvelteParse } from "../types.js";

const parse = sveltePARSE as unknown as SvelteParse;

/**
 * The resolver and the planner were built in parallel against a shared type, and
 * each was tested against its own idea of what the other produces. These tests
 * run the real path: a location Svelte's dev runtime would report, through the
 * real resolver, into the real planner, and assert what lands in the file.
 *
 * A disagreement here is the failure that unit tests on either side cannot see.
 */

const FIXTURES = path.join(
  import.meta.dirname,
  "../../../../plugins/builtin/sveltekit-builder/__fixtures__/svelte"
);

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

/** The location Svelte's dev runtime reports for the first occurrence of `tag`. */
function locationOf(source: string, file: string, marker: string): DevLocation {
  const offset = source.indexOf(marker);
  if (offset < 0) throw new Error(`marker ${marker} not in ${file}`);
  const before = source.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - (before.lastIndexOf("\n") + 1);
  // Round-trip through the same conversion the resolver uses, so a mistake in
  // the test's own arithmetic shows up here rather than as a resolver failure.
  expect(lineColumnToOffset(source, line, column)).toBe(offset);
  return { file, line, column };
}

function resolveAt(source: string, file: string, marker: string): ResolvedElement {
  const result = resolveElementAtLocation(source, locationOf(source, file, marker), parse);
  if (result.status !== "resolved") {
    throw new Error(`expected a resolve, got ${result.reason}: ${result.detail ?? ""}`);
  }
  return result.node;
}

describe("resolver output drives the planner", () => {
  it("adds a class token to a literal class attribute", () => {
    const source = fixture("native.svelte");
    const element = resolveAt(source, "src/lib/native.svelte", "<section");
    const plan = planSetClassTokens(source, element, { add: ["gap-8"], remove: ["gap-4"] });
    if (plan.status !== "planned") throw new Error(`refused: ${plan.reason}`);

    const classValue = /<section class="([^"]*)"/.exec(plan.after)?.[1];
    // An added token appends rather than taking the removed one's place, so the
    // assertion is about which tokens survive and that the untouched ones keep
    // their order — not about where the new one lands.
    expect(classValue?.split(/\s+/)).toEqual(["flex", "flex-col", "p-6", "gap-8"]);
    // Everything outside the class attribute is byte-identical.
    expect(plan.after.replace(/ class="[^"]*"/, "")).toBe(source.replace(/ class="[^"]*"/, ""));
  });

  it("edits literal text without disturbing the markup around it", () => {
    const source = fixture("native.svelte");
    const element = resolveAt(source, "src/lib/native.svelte", "<h1");
    const plan = planSetLiteralText(source, element, "Changed heading");
    if (plan.status !== "planned") throw new Error(`refused: ${plan.reason}`);

    expect(plan.after).toContain('<h1 class="text-2xl font-bold">Changed heading</h1>');
    expect(plan.after).toContain('<p class="text-sm">Literal paragraph text.</p>');
  });

  it("edits a literal prop at one invocation and leaves its siblings alone", () => {
    const source = fixture("invocations.svelte");
    const element = resolveAt(source, "src/lib/invocations.svelte", '<Card plan="Enterprise"');
    const plan = planSetLiteralProp(source, element, "tier", 7);
    if (plan.status !== "planned") throw new Error(`refused: ${plan.reason}`);

    expect(plan.after).toContain('<Card plan="Enterprise" ctaVariant="outline" tier={7} />');
    expect(plan.after).toContain('<Card plan="Basic" ctaVariant="solid" />');
    expect(plan.after).toContain('<Card plan="Pro" ctaVariant="solid" featured />');
  });

  it("refuses every class form the resolver marks unsupported", () => {
    const source = fixture("dynamic-classes.svelte");
    const file = "src/lib/dynamic-classes.svelte";
    for (const marker of ["<button class={[", "<button class={active", "<div class={sizes"]) {
      const element = resolveAt(source, file, marker);
      expect(element.classes.support).toBe("unsupported");
      const plan = planSetClassTokens(source, element, { add: ["p-8"], remove: [] });
      expect(plan.status).toBe("refused");
    }
  });

  it("keeps a class:directive and a spread visible to the caller", () => {
    const source = fixture("dynamic-classes.svelte");
    const file = "src/lib/dynamic-classes.svelte";
    expect(resolveAt(source, file, "<button class={[").classDirectives).toEqual(["on"]);
    expect(resolveAt(source, file, "<div {...rest}").hasSpread).toBe(true);
  });

  it("verifies a candidate against the ranges the plan promised not to touch", () => {
    const source = fixture("native.svelte");
    const element = resolveAt(source, "src/lib/native.svelte", "<h1");
    const plan = planSetLiteralText(source, element, "Verified");
    if (plan.status !== "planned") throw new Error(`refused: ${plan.reason}`);

    const paragraph = resolveAt(source, "src/lib/native.svelte", "<p");
    expect(verifyCandidate(source, plan.after, [paragraph.range], parse)).toEqual({ ok: true });
  });
});
