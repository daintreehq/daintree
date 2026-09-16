import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "svelte/compiler";
import { applyReplacements } from "../splice.js";
import {
  planSetClassTokens,
  planSetLiteralAttribute,
  planSetLiteralProp,
  planSetLiteralText,
  verifyCandidate,
} from "../mutate.js";
import type { MutationPlan } from "../mutate.js";
import type { ResolvedElement, SourceRange, SurfaceSupport, SvelteParse } from "../types.js";

const svelteParse = parse as unknown as SvelteParse;

const FIXTURES = fileURLToPath(
  new URL("../../../../plugins/builtin/sveltekit-builder/__fixtures__/svelte/", import.meta.url)
);
const fixture = (name: string) => readFileSync(`${FIXTURES}${name}`, "utf8");

/**
 * A local stand-in for Phase 1's resolver, built from a real parse.
 *
 * Deliberately independent of `resolveElementAtLocation`: these tests are about
 * whether an edit is correct given a resolved element, and borrowing the
 * resolver would let one component's bug hide the other's.
 */
function resolveByTag(source: string, tagName: string, occurrence = 0): ResolvedElement {
  const ast = svelteParse(source, { modern: true });
  const found: Record<string, unknown>[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (
      (record.type === "RegularElement" ||
        record.type === "Component" ||
        record.type === "SvelteElement") &&
      record.name === tagName
    ) {
      found.push(record);
    }
    for (const value of Object.values(record)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") walk(value);
    }
  };
  walk(ast.fragment);
  const node = found[occurrence];
  if (!node) throw new Error(`No <${tagName}> #${occurrence} in this fixture.`);
  return describeElement(node);
}

function describeElement(node: Record<string, unknown>): ResolvedElement {
  const attributes = (node.attributes ?? []) as Record<string, unknown>[];
  const literal: Record<string, SurfaceSupport> = {};
  const classDirectives: string[] = [];
  let hasSpread = false;
  let classes: SurfaceSupport = { support: "unsupported", reason: "absent" };

  for (const attribute of attributes) {
    if (attribute.type === "SpreadAttribute") {
      hasSpread = true;
      continue;
    }
    if (attribute.type === "ClassDirective") {
      classDirectives.push(attribute.name as string);
      continue;
    }
    if (attribute.type !== "Attribute") continue;
    const support = valueSupport(attribute.value);
    if (attribute.name === "class") classes = support;
    literal[attribute.name as string] = support;
  }

  const isComponent = node.type === "Component";
  return {
    kind: node.type as string,
    tagName: node.name as string,
    range: { start: node.start as number, end: node.end as number },
    text: textSupport(node),
    classes,
    attributes: isComponent ? {} : literal,
    props: isComponent ? literal : {},
    hasSpread,
    classDirectives,
  };
}

function valueSupport(value: unknown): SurfaceSupport {
  if (value === true) return { support: "unsupported", reason: "absent" };
  // `name="x"` gives a one-element array; `name={expr}` gives the bare tag.
  if (!Array.isArray(value)) {
    if (!value || typeof value !== "object")
      return { support: "unsupported", reason: "dynamic-expression" };
    return literalSupport(value as Record<string, unknown>);
  }
  if (value.length !== 1) return { support: "unsupported", reason: "mixed-text-and-expression" };
  return literalSupport(value[0] as Record<string, unknown>);
}

function literalSupport(only: Record<string, unknown>): SurfaceSupport {
  const range = { start: only.start as number, end: only.end as number };
  if (only.type === "Text") return { support: "direct", range };
  // `tier={3}` is an ExpressionTag wrapping a JS Literal — a literal prop, and
  // the range reported is the whole `{3}` tag rather than its interior.
  const expression = only.expression as Record<string, unknown> | undefined;
  if (only.type === "ExpressionTag" && expression?.type === "Literal") {
    return { support: "direct", range };
  }
  return { support: "unsupported", reason: "dynamic-expression" };
}

function textSupport(node: Record<string, unknown>): SurfaceSupport {
  const fragment = node.fragment as Record<string, unknown> | undefined;
  const nodes = (fragment?.nodes ?? []) as Record<string, unknown>[];
  if (nodes.length === 0) return { support: "unsupported", reason: "absent" };
  if (nodes.length > 1) return { support: "unsupported", reason: "mixed-text-and-expression" };
  const only = nodes[0]!;
  if (only.type !== "Text") return { support: "unsupported", reason: "dynamic-expression" };
  return { support: "direct", range: { start: only.start as number, end: only.end as number } };
}

function planned(plan: MutationPlan): Extract<MutationPlan, { status: "planned" }> {
  if (plan.status !== "planned") {
    throw new Error(`Expected a plan, got refusal: ${plan.reason} ${plan.detail ?? ""}`);
  }
  return plan;
}

/** The `class` value as the compiler reads it back out of the candidate. */
function classValueOf(source: string, tagName: string, occurrence = 0): string {
  const element = resolveByTag(source, tagName, occurrence);
  if (element.classes.support !== "direct") throw new Error("class is not a literal here");
  return source.slice(element.classes.range.start, element.classes.range.end);
}

/**
 * The classes a browser would see: the compiler's decoded `Text.data`, not the
 * raw source. Splitting the raw bytes would read `[&amp;>*]:p-2` as a token
 * spelled with an entity and miss the ones that decode to a separator.
 */
function classTokensOf(source: string, tagName: string, occurrence = 0): string[] {
  const element = resolveByTag(source, tagName, occurrence);
  if (element.classes.support !== "direct") throw new Error("class is not a literal here");
  const start = element.classes.range.start;
  const ast = svelteParse(source, { modern: true });
  const text = findFirst(ast, (n) => n.type === "Text" && n.start === start);
  return String(text?.data ?? "")
    .split(/\s+/)
    .filter(Boolean);
}

/** Every byte of `source` except the element at `range`. */
function outside(source: string, range: SourceRange): SourceRange[] {
  return [
    { start: 0, end: range.start },
    { start: range.end, end: source.length },
  ];
}

describe("planSetLiteralText", () => {
  const source = fixture("native.svelte");

  it("replaces only the text node and re-parses to the same element set", () => {
    const element = resolveByTag(source, "h1");
    const plan = planned(planSetLiteralText(source, element, "New heading"));
    const verdict = verifyCandidate(
      source,
      plan.after,
      outside(source, element.range),
      svelteParse
    );
    expect(verdict).toEqual({ ok: true });
    expect(plan.after.length - source.length).toBe(
      "New heading".length -
        (element.text.support === "direct" ? element.text.range.end - element.text.range.start : 0)
    );
  });

  it("escapes markup rather than writing it back as source", () => {
    const element = resolveByTag(source, "h1");
    const plan = planned(planSetLiteralText(source, element, "<b>bold</b> & {count} > 2"));
    const after = svelteParse(plan.after, { modern: true });
    const h1 = resolveByTag(plan.after, "h1");
    expect(h1.text.support).toBe("direct");
    // The candidate still has exactly one <h1> with one text child: the angle
    // brackets did not become an element and the brace did not become a tag.
    expect(after).toBeDefined();
    const written = plan.after.slice(
      h1.text.support === "direct" ? h1.text.range.start : 0,
      h1.text.support === "direct" ? h1.text.range.end : 0
    );
    expect(written).not.toContain("<b>");
    expect(written).not.toMatch(/(^|[^&#\d;]){/);
  });

  it("round-trips the escaped text through the compiler's own decoding", () => {
    const element = resolveByTag(source, "h1");
    const value = 'Tom & Jerry <3 {curly} "quotes" ‘smart’ 😀 é';
    const plan = planned(planSetLiteralText(source, element, value));
    const ast = svelteParse(plan.after, { modern: true });
    const text = findFirst(
      ast,
      (n) => n.type === "Text" && typeof n.data === "string" && (n.data as string).includes("Jerry")
    );
    expect(text?.data).toBe(value);
  });

  it("refuses an element whose text is an expression", () => {
    const element = resolveByTag(source, "h2");
    expect(planSetLiteralText(source, element, "x")).toMatchObject({
      status: "refused",
      reason: "unsupported-surface",
    });
  });

  it("refuses a no-op", () => {
    const element = resolveByTag(source, "p");
    const current =
      element.text.support === "direct"
        ? source.slice(element.text.range.start, element.text.range.end)
        : "";
    expect(planSetLiteralText(source, element, current)).toEqual({
      status: "refused",
      reason: "no-op",
    });
  });

  it("writes CRLF into a CRLF file and LF into an LF file", () => {
    const lf = source;
    const crlf = source.replace(/\n/g, "\r\n");
    const lfPlan = planned(planSetLiteralText(lf, resolveByTag(lf, "h1"), "one\ntwo"));
    const crlfPlan = planned(planSetLiteralText(crlf, resolveByTag(crlf, "h1"), "one\ntwo"));
    expect(lfPlan.replacements[0]!.text).toBe("one\ntwo");
    expect(crlfPlan.replacements[0]!.text).toBe("one\r\ntwo");
    expect(/\r(?!\n)/.test(crlfPlan.after)).toBe(false);
  });

  it("doubles a leading newline in <pre>, which the HTML parser would eat", () => {
    const withPre = source.replace("<h2>{heading}</h2>", "<pre>old</pre>");
    const plan = planned(planSetLiteralText(withPre, resolveByTag(withPre, "pre"), "\nhello"));
    const written = plan.replacements[0]!.text;
    expect(written).toBe("\n\nhello");
    // Nothing else gains a newline: only the one the parser discards.
    const inline = planned(
      planSetLiteralText(withPre, resolveByTag(withPre, "pre"), "hello\nthere")
    );
    expect(inline.replacements[0]!.text).toBe("hello\nthere");
    const normal = planned(planSetLiteralText(source, resolveByTag(source, "h1"), "\nhello"));
    expect(normal.replacements[0]!.text).toBe("\nhello");
  });

  it("refuses a raw-text element, where entities are not escapes", () => {
    const withScript = source.replace("<h2>{heading}</h2>", "<script>let x = 1;<" + "/script>");
    const element = resolveByTag(withScript, "script");
    expect(planSetLiteralText(withScript, element, "let x = 2 && 3;")).toMatchObject({
      status: "refused",
      reason: "unsupported-surface",
    });
  });

  it("refuses a control character that no source position can carry", () => {
    expect(planSetLiteralText(source, resolveByTag(source, "h1"), "a\u0000b")).toMatchObject({
      status: "refused",
      reason: "invalid-attribute-value",
    });
  });
});

describe("planSetClassTokens", () => {
  const source = fixture("native.svelte");

  it("removes a whole token and leaves the prefix-sharing sibling alone", () => {
    const element = resolveByTag(source, "section");
    const plan = planned(planSetClassTokens(source, element, { add: [], remove: ["p-6"] }));
    const before = classTokensOf(source, "section");
    const after = classTokensOf(plan.after, "section");
    expect(before).toContain("p-6");
    expect(after).not.toContain("p-6");
    expect(after).toEqual(before.filter((t) => t !== "p-6"));
  });

  it("never matches a token by prefix", () => {
    const withBoth = source.replace(
      'class="flex flex-col gap-4 p-6"',
      'class="flex px-6 p-6 p-60"'
    );
    const element = resolveByTag(withBoth, "section");
    const plan = planned(planSetClassTokens(withBoth, element, { add: [], remove: ["p-6"] }));
    expect(classTokensOf(plan.after, "section")).toEqual(["flex", "px-6", "p-60"]);
  });

  it("preserves unrecognised tokens and variant chains in their original order", () => {
    const exotic = source.replace(
      'class="flex flex-col gap-4 p-6"',
      'class="dark:md:hover:bg-red-500/50 my-legacy-class p-6 w-1/2"'
    );
    const element = resolveByTag(exotic, "section");
    const plan = planned(planSetClassTokens(exotic, element, { add: ["gap-2"], remove: ["p-6"] }));
    const after = classTokensOf(plan.after, "section");
    expect(after.slice(0, 3)).toEqual(["dark:md:hover:bg-red-500/50", "my-legacy-class", "w-1/2"]);
    expect(after).toContain("gap-2");
  });

  it("does not reflow the separators it did not touch", () => {
    const wrapped = source.replace(
      'class="flex flex-col gap-4 p-6"',
      'class="flex\n    flex-col\n    gap-4\n    p-6"'
    );
    const element = resolveByTag(wrapped, "section");
    const plan = planned(
      planSetClassTokens(wrapped, element, { add: ["items-center"], remove: [] })
    );
    const value = classValueOf(plan.after, "section");
    expect(value.startsWith("flex\n    flex-col\n    gap-4\n    p-6")).toBe(true);
    expect(value.endsWith("\n    items-center")).toBe(true);
  });

  it("keeps padding inside the quotes when a middle token goes", () => {
    const padded = source.replace('class="flex flex-col gap-4 p-6"', 'class=" a  b  c "');
    const plan = planned(
      planSetClassTokens(padded, resolveByTag(padded, "section"), { add: [], remove: ["b"] })
    );
    const value = classValueOf(plan.after, "section");
    expect(value.startsWith(" ")).toBe(true);
    expect(value.endsWith(" ")).toBe(true);
    expect(value.trim()).toBe("a  c");
  });

  it("treats adding a token that is already there as a no-op", () => {
    const element = resolveByTag(source, "section");
    expect(planSetClassTokens(source, element, { add: ["p-6"], remove: [] })).toEqual({
      status: "refused",
      reason: "no-op",
    });
    expect(planSetClassTokens(source, element, { add: [], remove: ["not-present"] })).toEqual({
      status: "refused",
      reason: "no-op",
    });
  });

  it("still plans when part of the change is a no-op", () => {
    const element = resolveByTag(source, "section");
    const plan = planned(
      planSetClassTokens(source, element, { add: ["p-6", "isolate"], remove: [] })
    );
    const after = classTokensOf(plan.after, "section");
    expect(after.filter((t) => t === "p-6")).toHaveLength(1);
    expect(after).toContain("isolate");
  });

  it("empties the value rather than the attribute when the last token goes", () => {
    const element = resolveByTag(source, "a");
    const plan = planned(planSetClassTokens(source, element, { add: [], remove: ["underline"] }));
    expect(classValueOf(plan.after, "a")).toBe("");
    const href = resolveByTag(plan.after, "a").attributes["href"];
    expect(
      href.support === "direct" ? plan.after.slice(href.range.start, href.range.end) : null
    ).toBe("/pricing");
  });

  it("escapes a token that carries markup characters, and matches it back decoded", () => {
    const element = resolveByTag(source, "section");
    const added = planned(planSetClassTokens(source, element, { add: ["[&>*]:p-2"], remove: [] }));
    expect(classValueOf(added.after, "section")).toContain("&amp;");
    // The compiler decodes it back to the token the caller asked for, and a
    // later removal of that same token has to find it through the entity.
    const removed = planned(
      planSetClassTokens(added.after, resolveByTag(added.after, "section"), {
        add: [],
        remove: ["[&>*]:p-2"],
      })
    );
    expect(removed.after).toBe(source);
  });

  it("preserves single-quoted attribute style and escapes only that delimiter", () => {
    const single = source.replace('class="flex flex-col gap-4 p-6"', "class='flex p-6'");
    const plan = planned(
      planSetClassTokens(single, resolveByTag(single, "section"), { add: ['a"b'], remove: [] })
    );
    expect(plan.after).toContain("class='flex p-6 a\"b'");
  });

  it("quotes an unquoted class attribute once it needs a separator", () => {
    const bare = source.replace('class="flex flex-col gap-4 p-6"', "class=flex");
    const plan = planned(
      planSetClassTokens(bare, resolveByTag(bare, "section"), { add: ["p-6"], remove: [] })
    );
    expect(classTokensOf(plan.after, "section")).toEqual(["flex", "p-6"]);
  });

  it("refuses a token that is both added and removed in one change", () => {
    const element = resolveByTag(source, "section");
    expect(planSetClassTokens(source, element, { add: ["p-6"], remove: ["p-6"] })).toMatchObject({
      status: "refused",
      reason: "invalid-class-token",
    });
  });

  it("keeps a Tailwind arbitrary value with quotes and braces readable back", () => {
    const element = resolveByTag(source, "section");
    const token = "before:content-['{x}']";
    const plan = planned(planSetClassTokens(source, element, { add: [token], remove: [] }));
    // The brace is escaped in the source but decodes back to the token asked for.
    expect(classValueOf(plan.after, "section")).toContain("&#123;");
    expect(classTokensOf(plan.after, "section")).toContain(token);
    const undo = planned(
      planSetClassTokens(plan.after, resolveByTag(plan.after, "section"), {
        add: [],
        remove: [token],
      })
    );
    expect(undo.after).toBe(source);
  });

  it("reads an entity that decodes to whitespace as a token separator", () => {
    // `a&#32;b` is two classes to a browser, so `b` is already present and a
    // removal of `a` has a separator to take with it.
    const encoded = source.replace('class="flex flex-col gap-4 p-6"', 'class="a&#32;b"');
    const element = resolveByTag(encoded, "section");
    expect(classTokensOf(encoded, "section")).toEqual(["a", "b"]);
    expect(planSetClassTokens(encoded, element, { add: ["b"], remove: [] })).toEqual({
      status: "refused",
      reason: "no-op",
    });
    const removed = planned(planSetClassTokens(encoded, element, { add: [], remove: ["a"] }));
    expect(classValueOf(removed.after, "section")).toBe("b");
  });

  it("does not fold entity case, which HTML does not either", () => {
    // `&AMP;` is an ampersand; `&Amp;` is five literal characters.
    const mixed = source.replace('class="flex flex-col gap-4 p-6"', 'class="&AMP; &Amp;"');
    const plan = planned(
      planSetClassTokens(mixed, resolveByTag(mixed, "section"), { add: [], remove: ["&"] })
    );
    expect(classValueOf(plan.after, "section")).toBe("&Amp;");
  });

  it("refuses a token that is not a single token", () => {
    const element = resolveByTag(source, "section");
    for (const bad of ["p-6 p-4", "", "a\tb", "a\u0000b"]) {
      expect(planSetClassTokens(source, element, { add: [bad], remove: [] })).toMatchObject({
        status: "refused",
        reason: "invalid-class-token",
      });
    }
  });

  describe("against the adversarial fixture", () => {
    const dynamic = fixture("dynamic-classes.svelte");

    it("refuses every non-literal class form", () => {
      for (let i = 0; i < 2; i++) {
        expect(
          planSetClassTokens(dynamic, resolveByTag(dynamic, "button", i), {
            add: ["x"],
            remove: [],
          })
        ).toMatchObject({
          status: "refused",
          reason: "unsupported-surface",
        });
      }
      // `class="grid {expr}"` and `class={sizes[size]}` are divs 0 and 1.
      for (let i = 0; i < 2; i++) {
        expect(
          planSetClassTokens(dynamic, resolveByTag(dynamic, "div", i), { add: ["x"], remove: [] })
        ).toMatchObject({
          status: "refused",
          reason: "unsupported-surface",
        });
      }
    });

    it("edits a literal class on either side of a spread without disturbing the spread", () => {
      for (const occurrence of [2, 3]) {
        const element = resolveByTag(dynamic, "div", occurrence);
        expect(element.hasSpread).toBe(true);
        const plan = planned(
          planSetClassTokens(dynamic, element, { add: ["p-2"], remove: ["text-sm"] })
        );
        const verdict = verifyCandidate(
          dynamic,
          plan.after,
          outside(dynamic, element.range),
          svelteParse
        );
        expect(verdict).toEqual({ ok: true });
        expect(plan.after).toContain("{...rest}");
        expect(classTokensOf(plan.after, "div", occurrence)).toEqual(["p-2"]);
      }
    });

    it("leaves a class: directive alone when editing the class attribute", () => {
      const withBoth = dynamic.replace(
        '<button class={["btn", active && "bg-accent"]} class:on={active}>',
        '<button class="btn" class:on={active}>'
      );
      const element = resolveByTag(withBoth, "button");
      expect(element.classDirectives).toEqual(["on"]);
      const plan = planned(planSetClassTokens(withBoth, element, { add: ["on"], remove: [] }));
      expect(plan.after).toContain("class:on={active}");
      expect(classTokensOf(plan.after, "button")).toEqual(["btn", "on"]);
    });
  });
});

describe("planSetLiteralAttribute", () => {
  const source = fixture("native.svelte");

  it("replaces a literal value and leaves the other attributes byte-identical", () => {
    const element = resolveByTag(source, "img");
    const plan = planned(planSetLiteralAttribute(source, element, "alt", "Acme logo"));
    const after = resolveByTag(plan.after, "img");
    const srcRange = after.attributes["src"];
    expect(srcRange.support).toBe("direct");
    if (srcRange.support !== "direct") return;
    expect(plan.after.slice(srcRange.range.start, srcRange.range.end)).toBe("/logo.png");
    expect(
      verifyCandidate(source, plan.after, outside(source, element.range), svelteParse)
    ).toEqual({ ok: true });
  });

  it("escapes the delimiter in use and no other quote", () => {
    const element = resolveByTag(source, "img");
    const plan = planned(
      planSetLiteralAttribute(source, element, "alt", `The "Acme" logo — it's ours`)
    );
    const ast = svelteParse(plan.after, { modern: true });
    const text = findFirst(
      ast,
      (n) => n.type === "Text" && typeof n.data === "string" && (n.data as string).includes("Acme")
    );
    expect(text?.data).toBe(`The "Acme" logo — it's ours`);
    expect(plan.replacements[0]!.text).toContain("&quot;");
    expect(plan.replacements[0]!.text).toContain("it's");
  });

  it("escapes a brace so the value stays a literal rather than an expression", () => {
    const element = resolveByTag(source, "img");
    const plan = planned(planSetLiteralAttribute(source, element, "alt", "{count} items"));
    const after = resolveByTag(plan.after, "img");
    expect(after.attributes["alt"].support).toBe("direct");
  });

  it("carries emoji and combining marks through unescaped", () => {
    const element = resolveByTag(source, "img");
    const value = "Café 😀🇿🇦";
    const plan = planned(planSetLiteralAttribute(source, element, "alt", value));
    const ast = svelteParse(plan.after, { modern: true });
    const text = findFirst(
      ast,
      (n) => n.type === "Text" && typeof n.data === "string" && (n.data as string).includes("😀")
    );
    expect(text?.data).toBe(value);
  });

  it("refuses an attribute that is absent or not a literal", () => {
    const element = resolveByTag(source, "img");
    expect(planSetLiteralAttribute(source, element, "loading", "lazy")).toMatchObject({
      status: "refused",
      reason: "unsupported-surface",
    });
    const dynamic = fixture("dynamic-classes.svelte");
    expect(
      planSetLiteralAttribute(dynamic, resolveByTag(dynamic, "div", 1), "class", "x")
    ).toMatchObject({ status: "refused", reason: "unsupported-surface" });
  });

  it("refuses a no-op", () => {
    const element = resolveByTag(source, "a");
    expect(planSetLiteralAttribute(source, element, "href", "/pricing")).toEqual({
      status: "refused",
      reason: "no-op",
    });
  });
});

describe("planSetLiteralProp", () => {
  const source = fixture("invocations.svelte");

  it("changes one invocation and leaves its siblings byte-identical", () => {
    const element = resolveByTag(source, "Card", 1);
    const plan = planned(planSetLiteralProp(source, element, "plan", "Team"));
    expect(
      verifyCandidate(source, plan.after, outside(source, element.range), svelteParse)
    ).toEqual({ ok: true });
    const cards = [0, 1, 2, 3].map((i) => {
      const card = resolveByTag(plan.after, "Card", i);
      const prop = card.props["plan"];
      return prop?.support === "direct" ? plan.after.slice(prop.range.start, prop.range.end) : null;
    });
    expect(cards).toEqual(["Basic", "Team", "Enterprise", null]);
  });

  it("keeps a numeric prop numeric", () => {
    const element = resolveByTag(source, "Card", 2);
    const plan = planned(planSetLiteralProp(source, element, "tier", 7));
    expect(plan.after).toContain("tier={7}");
    const ast = svelteParse(plan.after, { modern: true });
    const literal = findFirst(ast, (n) => n.type === "Literal" && n.value === 7);
    expect(literal).toBeDefined();
  });

  it("refuses to turn a string prop into a number, or the reverse implicitly", () => {
    expect(planSetLiteralProp(source, resolveByTag(source, "Card", 0), "plan", 3)).toMatchObject({
      status: "refused",
      reason: "invalid-attribute-value",
    });
  });

  it("writes a string into a string-holding expression slot as a JS literal", () => {
    const braced = source.replace('plan="Enterprise"', 'plan={"Enterprise"}');
    const element = resolveByTag(braced, "Card", 2);
    const plan = planned(planSetLiteralProp(braced, element, "plan", 'a "quoted" \\ back'));
    const ast = svelteParse(plan.after, { modern: true });
    const literal = findFirst(
      ast,
      (n) =>
        n.type === "Literal" &&
        typeof n.value === "string" &&
        (n.value as string).includes("quoted")
    );
    expect(literal?.value).toBe('a "quoted" \\ back');
  });

  it("judges the prop's type by what the slot holds, not by its delimiters", () => {
    // `tier={"3"}` is an expression slot holding a string; writing a number
    // there would change the contract as surely as writing one into tier="3".
    const stringy = source.replace("tier={3}", 'tier={"3"}');
    expect(planSetLiteralProp(stringy, resolveByTag(stringy, "Card", 2), "tier", 7)).toMatchObject({
      status: "refused",
      reason: "invalid-attribute-value",
    });
    expect(planSetLiteralProp(source, resolveByTag(source, "Card", 2), "tier", "7")).toMatchObject({
      status: "refused",
      reason: "invalid-attribute-value",
    });
  });

  it("refuses a non-finite number", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        planSetLiteralProp(source, resolveByTag(source, "Card", 2), "tier", bad)
      ).toMatchObject({
        status: "refused",
        reason: "invalid-attribute-value",
      });
    }
  });

  it("refuses a boolean shorthand, which has no value slot to write into", () => {
    expect(
      planSetLiteralProp(source, resolveByTag(source, "Card", 1), "featured", false)
    ).toMatchObject({
      status: "refused",
      reason: "unsupported-surface",
    });
  });

  it("refuses a native element, where props are not the surface", () => {
    const native = fixture("native.svelte");
    expect(planSetLiteralProp(native, resolveByTag(native, "a"), "href", "/x")).toEqual({
      status: "refused",
      reason: "unsupported-surface",
      detail: "not-a-component",
    });
  });
});

describe("verifyCandidate", () => {
  const source = fixture("multi-root.svelte");

  it("passes when the edit stayed inside the element it claimed", () => {
    const element = resolveByTag(source, "div", 0);
    const plan = planned(planSetClassTokens(source, element, { add: ["m-1"], remove: [] }));
    expect(
      verifyCandidate(source, plan.after, outside(source, element.range), svelteParse)
    ).toEqual({ ok: true });
  });

  it("catches a change that reaches into a protected range, wherever it sits", () => {
    const second = resolveByTag(source, "div", 1);
    const sabotaged = applyReplacements(source, [
      { start: second.range.start, end: second.range.start, text: "<span>x</span>" },
    ]);
    const first = resolveByTag(source, "div", 0);
    expect(
      verifyCandidate(
        source,
        sabotaged,
        [{ start: second.range.start, end: second.range.end }],
        svelteParse
      )
    ).toMatchObject({ ok: false, reason: "protected-range-modified" });
    // The untouched first root is still provably identical.
    expect(verifyCandidate(source, sabotaged, [first.range], svelteParse)).toEqual({ ok: true });
  });

  it("compares a protected range after the edit at its shifted offset", () => {
    const first = resolveByTag(source, "div", 0);
    const second = resolveByTag(source, "div", 1);
    const plan = planned(
      planSetClassTokens(source, first, { add: ["a-very-long-token-name"], remove: [] })
    );
    expect(plan.after.length).toBeGreaterThan(source.length);
    expect(verifyCandidate(source, plan.after, [second.range], svelteParse)).toEqual({ ok: true });
  });

  it("refuses a candidate the compiler cannot parse", () => {
    const broken = source.replace("</div>", "</div");
    expect(verifyCandidate(source, broken, [], svelteParse)).toMatchObject({
      ok: false,
      reason: "candidate-parse-failed",
    });
  });

  it("refuses an identical candidate before it ever reaches the parser", () => {
    expect(verifyCandidate(source, source, [], svelteParse)).toEqual({
      ok: false,
      reason: "no-op",
    });
  });

  it("refuses a protected range that is not inside the original", () => {
    expect(
      verifyCandidate(
        source,
        `${source}\n<p>x</p>`,
        [{ start: 0, end: source.length + 5 }],
        svelteParse
      )
    ).toMatchObject({ ok: false, reason: "protected-range-modified" });
  });
});

function findFirst(
  root: unknown,
  predicate: (node: Record<string, unknown>) => boolean
): Record<string, unknown> | undefined {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    const record = node as Record<string, unknown>;
    if (typeof record.type === "string" && predicate(record)) return record;
    for (const value of Object.values(record)) {
      if (Array.isArray(value)) stack.push(...value);
      else if (value && typeof value === "object") stack.push(value);
    }
  }
  return undefined;
}
