import { describe, expect, it } from "vitest";
import { parse as svelteParse } from "svelte/compiler";
import { resolveElementByStructure } from "../resolve/structure.js";
import { resolveElementAtLocation } from "../resolve.js";
import type { DevLocation, SvelteAstRoot, SvelteParse } from "../types.js";

const parse: SvelteParse = (source, options) =>
  svelteParse(source, options) as unknown as SvelteAstRoot;

const FILE = "src/routes/+page.svelte";

/** The position of `marker`'s first character, in the shape the dev runtime reports. */
function locationOf(source: string, marker: string): DevLocation {
  const offset = source.indexOf(marker);
  if (offset < 0) throw new Error(`marker ${marker} not found`);
  const before = source.slice(0, offset);
  const lines = before.split("\n");
  return { file: FILE, line: lines.length, column: lines[lines.length - 1]!.length };
}

// The shape of the page this was found on: a component rendered before the
// template's own elements. Hydration hands `div.journal` the location meant
// for `div.journal-end`, and `div.toolbar` the one meant for `span.mark`.
const PAGE = [
  "<script>",
  "  import Header from './Header.svelte';",
  "  let { items } = $props();",
  "</script>",
  "",
  "<Header />",
  '<div class="journal">',
  '  <div class="toolbar">',
  "    <p>September</p>",
  "    <nav>",
  "      {#each items as item}",
  "        <a href={item.href}>{item.label}</a>",
  '        <span class="gap" />',
  "      {/each}",
  "    </nav>",
  "  </div>",
  "</div>",
  '<div class="journal-end">',
  '  <span class="mark">*</span>',
  "  <p>The end</p>",
  "</div>",
  "",
].join("\n");

describe("resolveElementByStructure", () => {
  it("finds a root-template element by its path when the stamp is a neighbour's", () => {
    const result = resolveElementByStructure(
      PAGE,
      FILE,
      {
        frame: {
          type: "component",
          file: ".svelte-kit/generated/root.svelte",
          line: 56,
          column: 18,
        },
        path: [
          { tag: "div", index: 0 },
          { tag: "div", index: 0 },
        ],
        hint: locationOf(PAGE, '<span class="mark"'),
      },
      parse
    );
    expect(result).toEqual({
      status: "resolved",
      location: locationOf(PAGE, '<div class="toolbar"'),
      kind: "RegularElement",
      tagName: "div",
      // Two roots the template owns (`div.journal`, `div.journal-end` — the
      // Header's rendered root is not one of them), then `div.toolbar` alone
      // inside the first.
      levelCounts: [2, 1],
    });
    // What it names is what the ordinary resolve then proves.
    const proved = resolveElementAtLocation(PAGE, locationOf(PAGE, '<div class="toolbar"'), parse);
    expect(proved.status).toBe("resolved");
  });

  it("does not count a child component's root as one of the template's elements", () => {
    // `div.journal` is index 0 among the template's own roots even though the
    // Header's element precedes it in the DOM: the guest counts only siblings
    // that share the frame, and so does the walk.
    const result = resolveElementByStructure(
      PAGE,
      FILE,
      {
        frame: null,
        path: [
          { tag: "div", index: 1 },
          { tag: "span", index: 0 },
        ],
        hint: null,
      },
      parse
    );
    expect(result).toMatchObject({
      status: "resolved",
      location: locationOf(PAGE, '<span class="mark"'),
    });
  });

  it("walks an each body's first iteration only, unless the body has one root", () => {
    // Every iteration's roots are siblings under one parent, and a hydrated
    // page drops stamps off the tail of each, so past the first iteration a
    // position no longer says which root it is.
    const each = { type: "each", ...locationOf(PAGE, "{#each") };
    expect(
      resolveElementByStructure(
        PAGE,
        FILE,
        { frame: each, path: [{ tag: "span", index: 1 }], hint: null },
        parse
      )
    ).toMatchObject({ status: "resolved", location: locationOf(PAGE, '<span class="gap"') });
    expect(
      resolveElementByStructure(
        PAGE,
        FILE,
        { frame: each, path: [{ tag: "span", index: 5 }], hint: null },
        parse
      )
    ).toMatchObject({ status: "failed", reason: "no-element-at-path" });
    // One root: every position is it.
    const single = ["{#each items as item}", "  <li>{item}</li>", "{/each}", ""].join("\n");
    expect(
      resolveElementByStructure(
        single,
        FILE,
        {
          frame: { type: "each", ...locationOf(single, "{#each") },
          path: [{ tag: "li", index: 7 }],
          hint: null,
        },
        parse
      )
    ).toMatchObject({ status: "resolved", location: locationOf(single, "<li") });
  });

  it("refuses a level the page and the source would count differently", () => {
    // Raw markup renders under the template's frame but is no element of the
    // source; a dynamic element may render nothing; a slot's fallback and a
    // boundary's contents have no frame of their own.
    for (const middle of [
      "{@html raw}",
      "<svelte:element this={tag} />",
      "<slot><i>fallback</i></slot>",
      "<svelte:boundary><i>x</i></svelte:boundary>",
    ]) {
      const source = [
        "<script>let { raw, tag } = $props();</script>",
        "<div>",
        `  ${middle}`,
        "  <p>a</p>",
        "  <p>b</p>",
        "</div>",
        "",
      ].join("\n");
      const result = resolveElementByStructure(
        source,
        FILE,
        {
          frame: null,
          path: [
            { tag: "div", index: 0 },
            { tag: "p", index: 1 },
          ],
          hint: null,
        },
        parse
      );
      expect(result, middle).toMatchObject({ status: "failed", reason: "uncountable-level" });
    }
  });

  it("refuses the whole placement when any fragment the frame could mean is uncountable", () => {
    // The raw markup may be where the element is; a snippet the source can
    // count answering for it would be a guess.
    const source = [
      "<script>let { raw } = $props();</script>",
      "{#snippet a()}",
      "  <div>{@html raw}</div>",
      "{/snippet}",
      "{#snippet b()}",
      "  <div><section><p>b</p></section></div>",
      "{/snippet}",
      "",
    ].join("\n");
    const result = resolveElementByStructure(
      source,
      FILE,
      {
        frame: { type: "render", file: "src/lib/Shell.svelte", line: 9, column: 2 },
        path: [
          { tag: "div", index: 0 },
          { tag: "section", index: 0 },
          { tag: "p", index: 0 },
        ],
        hint: null,
      },
      parse
    );
    expect(result).toMatchObject({ status: "failed", reason: "uncountable-level" });
  });

  it("walks a component's supplied content when its frame's call site is in this file", () => {
    // Legacy `<slot>` fills with the caller's markup under the callee's
    // component frame. The frame names the call site, here in this very
    // file, so the elements are the Component node's own fragment — not the
    // file's root, where `section[0]` would be the one outside.
    const source = [
      "<script>import Shell from './Shell.svelte'; import C from './C.svelte';</script>",
      "<Shell>",
      "  <C />",
      '  <section id="slotted"></section>',
      "  <div></div>",
      "</Shell>",
      '<section id="outside"></section>',
      "",
    ].join("\n");
    const result = resolveElementByStructure(
      source,
      FILE,
      {
        frame: { type: "component", ...locationOf(source, "<Shell>") },
        path: [{ tag: "section", index: 0 }],
        hint: null,
      },
      parse
    );
    expect(result).toMatchObject({
      status: "resolved",
      location: locationOf(source, '<section id="slotted"'),
    });
  });

  it("walks an else-if branch as a branch of the outer if", () => {
    const source = [
      "<script>let { a, b } = $props();</script>",
      "{#if a}",
      "  <p>a</p>",
      "{:else if b}",
      "  <section><p>b</p></section>",
      "{:else}",
      "  <p>c</p>",
      "{/if}",
      "",
    ].join("\n");
    const result = resolveElementByStructure(
      source,
      FILE,
      {
        frame: { type: "if", ...locationOf(source, "{#if") },
        path: [
          { tag: "section", index: 0 },
          { tag: "p", index: 0 },
        ],
        hint: null,
      },
      parse
    );
    expect(result).toMatchObject({ status: "resolved", location: locationOf(source, "<p>b") });
  });

  it("refuses a path that lands on an element of another tag", () => {
    const result = resolveElementByStructure(
      PAGE,
      FILE,
      {
        frame: null,
        path: [
          { tag: "div", index: 0 },
          { tag: "nav", index: 0 },
        ],
        hint: null,
      },
      parse
    );
    expect(result).toMatchObject({ status: "failed", reason: "no-element-at-path" });
  });

  it("walks the branch an if frame's stamp falls in, and refuses when it cannot tell", () => {
    const source = [
      "<script>let { on } = $props();</script>",
      "{#if on}",
      "  <section><h2>On</h2></section>",
      "{:else}",
      "  <section><h3>Off</h3></section>",
      "{/if}",
      "",
    ].join("\n");
    const frame = { type: "if", ...locationOf(source, "{#if") };
    const hinted = resolveElementByStructure(
      source,
      FILE,
      { frame, path: [{ tag: "section", index: 0 }], hint: locationOf(source, "<h3") },
      parse
    );
    expect(hinted).toMatchObject({
      status: "resolved",
      location: locationOf(source, "<section><h3"),
    });
    const blind = resolveElementByStructure(
      source,
      FILE,
      { frame, path: [{ tag: "section", index: 0 }], hint: null },
      parse
    );
    expect(blind).toMatchObject({ status: "failed", reason: "ambiguous-fragment" });
    // A tag only one branch has needs no hint.
    const byTag = resolveElementByStructure(
      source,
      FILE,
      {
        frame,
        path: [
          { tag: "section", index: 0 },
          { tag: "h3", index: 0 },
        ],
        hint: null,
      },
      parse
    );
    expect(byTag).toMatchObject({ status: "resolved", location: locationOf(source, "<h3") });
  });

  it("finds an element in a component's implicit children under a render frame", () => {
    const source = [
      "<script>import Shell from './Shell.svelte';</script>",
      "<Shell>",
      "  <main><article>Body</article></main>",
      "</Shell>",
      "{#snippet aside()}",
      "  <aside><article>Aside</article></aside>",
      "{/snippet}",
      "",
    ].join("\n");
    const frame = { type: "render", file: "src/lib/Shell.svelte", line: 9, column: 2 };
    const result = resolveElementByStructure(
      source,
      FILE,
      {
        frame,
        path: [
          { tag: "aside", index: 0 },
          { tag: "article", index: 0 },
        ],
        hint: null,
      },
      parse
    );
    expect(result).toMatchObject({
      status: "resolved",
      location: locationOf(source, "<article>Aside"),
    });
    // The implicit children are a fragment of their own.
    const implicit = resolveElementByStructure(
      source,
      FILE,
      {
        frame,
        path: [
          { tag: "main", index: 0 },
          { tag: "article", index: 0 },
        ],
        hint: null,
      },
      parse
    );
    expect(implicit).toMatchObject({
      status: "resolved",
      location: locationOf(source, "<article>Body"),
    });
  });

  it("refuses a block frame from another file, even at this file's own block", () => {
    // The same line and column as this file's `{#each}`, but claimed for a
    // different file: a block's body lives in the block's file, nowhere else.
    const at = locationOf(PAGE, "{#each");
    const result = resolveElementByStructure(
      PAGE,
      FILE,
      {
        frame: { type: "each", file: "src/lib/Other.svelte", line: at.line, column: at.column },
        path: [{ tag: "span", index: 1 }],
        hint: null,
      },
      parse
    );
    expect(result).toMatchObject({ status: "failed", reason: "no-fragment" });
  });
});

describe("resolveElementByStructure level counts", () => {
  const SIBLINGS = [
    "<div>",
    "  <button>one</button>",
    "  <button>two</button>",
    "  <span>after</span>",
    "</div>",
    "",
  ].join("\n");

  const secondButton = {
    frame: null,
    path: [
      { tag: "div", index: 0 },
      { tag: "button", index: 1 },
    ],
    hint: null,
  } as const;

  it("reports how many countable siblings sat at each level", () => {
    const result = resolveElementByStructure(SIBLINGS, FILE, secondButton, parse);
    expect(result).toMatchObject({
      status: "resolved",
      location: locationOf(SIBLINGS, "<button>two"),
      // One root `div`, then three elements beside each other inside it.
      levelCounts: [1, 3],
    });
  });

  it("moves a count when a sibling is inserted, which is the whole point", () => {
    // The path still resolves — to the element that took the old one's place.
    // Nothing about the path or the location says so; only the count does.
    const inserted = SIBLINGS.replace(
      "  <button>one</button>",
      "  <button>zero</button>\n  <button>one</button>"
    );
    const result = resolveElementByStructure(inserted, FILE, secondButton, parse);
    expect(result).toMatchObject({
      status: "resolved",
      location: locationOf(inserted, "<button>one"),
      levelCounts: [1, 4],
    });
  });

  it("holds the count steady when the element is edited in place", () => {
    // The case the gate exists to allow: same shape, different attributes.
    const restyled = SIBLINGS.replace(
      "<button>two</button>",
      '<button class="btn-primary">two</button>'
    );
    const result = resolveElementByStructure(restyled, FILE, secondButton, parse);
    expect(result).toMatchObject({
      status: "resolved",
      location: locationOf(restyled, '<button class="btn-primary">two'),
      levelCounts: [1, 3],
    });
  });
});
