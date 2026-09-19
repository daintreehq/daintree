import { describe, expect, it } from "vitest";
import { interpretAncestry, isGeneratedSourceFile } from "../resolve.js";
import type { RawAncestryFrame } from "../resolve.js";

function frame(type: string, file: string, line: number, componentTag?: string): RawAncestryFrame {
  return componentTag === undefined
    ? { type, file, line, column: 2 }
    : { type, file, line, column: 2, componentTag };
}

/** Innermost first, as `__svelte_meta.parent` is linked. */
const PRICING_PAGE: RawAncestryFrame[] = [
  frame("each", "src/routes/pricing/+page.svelte", 12),
  frame("component", "src/routes/pricing/+page.svelte", 12, "PricingCard"),
  frame("if", "src/routes/pricing/+page.svelte", 8),
  frame("component", ".svelte-kit/generated/root.svelte", 42, "Pyramid_0"),
  frame("component", ".svelte-kit/generated/root.svelte", 40, "Layout_0"),
];

describe("interpretAncestry", () => {
  it("flags framework frames and keeps them in the chain", () => {
    const { entries } = interpretAncestry(PRICING_PAGE);
    expect(entries.map((entry) => entry.generated)).toEqual([false, false, false, true, true]);
    expect(entries).toHaveLength(PRICING_PAGE.length);
  });

  it("names the nearest user-authored component frame as the invocation", () => {
    const { invocation } = interpretAncestry(PRICING_PAGE);
    expect(invocation?.componentTag).toBe("PricingCard");
    expect(invocation?.location.line).toBe(12);
  });

  it("never offers a generated frame as an invocation", () => {
    const generatedOnly = PRICING_PAGE.filter((entry) => entry.file.startsWith(".svelte-kit/"));
    const { invocation, breadcrumb } = interpretAncestry(generatedOnly);
    expect(invocation).toBeNull();
    expect(breadcrumb).toBe("");
  });

  it("builds an outermost-first breadcrumb from user frames only", () => {
    expect(interpretAncestry(PRICING_PAGE).breadcrumb).toBe("{#if} › PricingCard › {#each}");
  });

  it("reports no invocation when the nearest call site is dependency-owned", () => {
    // `<Wrapper child={Card} />` in the user's page: the frame that actually
    // rendered this node is inside the dependency, and the user's `<Wrapper>`
    // frame is a different call. Naming it would offer an edit at a site that
    // never rendered what was clicked.
    const { invocation, breadcrumb } = interpretAncestry([
      frame("component", "node_modules/@acme/ui/Wrapper.svelte", 9, "Child"),
      frame("component", "src/routes/+page.svelte", 4, "Wrapper"),
    ]);
    expect(invocation).toBeNull();
    expect(breadcrumb).toBe("Wrapper");
  });

  it("does not treat a block frame as an invocation", () => {
    const blocksOnly = PRICING_PAGE.filter((entry) => entry.type !== "component");
    expect(interpretAncestry(blocksOnly).invocation).toBeNull();
  });

  it("degrades an unrecognised frame kind instead of failing", () => {
    const { entries, breadcrumb, invocation } = interpretAncestry([
      frame("portal", "src/routes/+page.svelte", 3),
      frame("component", "src/routes/+page.svelte", 3, "Shell"),
    ]);
    expect(entries[0]!.kind).toBe("unknown");
    expect(breadcrumb).toBe("Shell › block");
    expect(invocation?.componentTag).toBe("Shell");
  });

  it("falls back to a generic label for a component frame with no tag", () => {
    expect(interpretAncestry([frame("component", "src/routes/+page.svelte", 3)]).breadcrumb).toBe(
      "component"
    );
  });

  it("handles an empty chain", () => {
    expect(interpretAncestry([])).toEqual({ entries: [], invocation: null, breadcrumb: "" });
  });

  it("copies the location verbatim rather than reinterpreting it", () => {
    const [entry] = interpretAncestry([
      { type: "each", file: "src/lib/List.svelte", line: 7, column: 0 },
    ]).entries;
    expect(entry!.location).toEqual({ file: "src/lib/List.svelte", line: 7, column: 0 });
  });
});

describe("isGeneratedSourceFile", () => {
  it("recognises generated and dependency-owned paths, and nothing else", () => {
    const generated = [
      ".svelte-kit/generated/root.svelte",
      "apps/web/.svelte-kit/generated/root.svelte",
      "node_modules/bits-ui/x.svelte",
      "apps/web/node_modules/bits-ui/x.svelte",
      ".svelte-kit\\generated\\root.svelte",
    ];
    const authored = [
      "src/routes/+page.svelte",
      "src/lib/svelte-kit-helpers/Thing.svelte",
      "src/lib/my-node_modules-explainer.svelte",
    ];
    expect(generated.map(isGeneratedSourceFile)).toEqual(generated.map(() => true));
    expect(authored.map(isGeneratedSourceFile)).toEqual(authored.map(() => false));
  });
});
