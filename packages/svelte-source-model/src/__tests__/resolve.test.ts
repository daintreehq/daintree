import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile, parse as svelteParse } from "svelte/compiler";
import { countElementsAtOffset, resolveElementAtLocation } from "../resolve.js";
import { lineColumnToOffset } from "../splice.js";
import type {
  DevLocation,
  ResolveResult,
  SurfaceSupport,
  SvelteAstRoot,
  SvelteParse,
} from "../types.js";

/**
 * The compiler types `Root.fragment` as a `Fragment`, which carries no
 * `start`/`end` — so the published `parse` is not assignable to `SvelteParse`
 * without this cast. Every consumer of the package needs the same one.
 */
const parse: SvelteParse = (source, options) =>
  svelteParse(source, options) as unknown as SvelteAstRoot;

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../plugins/builtin/sveltekit-builder/__fixtures__/svelte"
);

const fixtureNames = fs
  .readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith(".svelte"))
  .sort();

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8");
}

/** The position of `marker`'s first character, in the shape the dev runtime reports. */
function locationOf(source: string, marker: string, file = "src/fixture.svelte"): DevLocation {
  const offset = source.indexOf(marker);
  if (offset === -1) throw new Error(`marker not found in fixture: ${marker}`);
  const before = source.slice(0, offset);
  const lastBreak = before.lastIndexOf("\n");
  return { file, line: before.split("\n").length, column: offset - lastBreak - 1 };
}

type DevLocationTable = Array<number | DevLocationTable>;

function collect(table: DevLocationTable, file: string, out: DevLocation[]): void {
  const [line, column, children] = table;
  if (typeof line === "number" && typeof column === "number") {
    out.push({ file, line, column });
    if (Array.isArray(children)) {
      for (const child of children) if (Array.isArray(child)) collect(child, file, out);
    }
    return;
  }
  for (const entry of table) if (Array.isArray(entry)) collect(entry, file, out);
}

/**
 * The locations Svelte's dev build actually attaches to rendered elements, read
 * out of the compiled `add_locations` table.
 *
 * The corpus resolves against these rather than against positions the test
 * computes, so what is proved is that the real compiler emission maps to real
 * elements — not that two pieces of our own arithmetic agree.
 */
function devLocations(source: string, file: string): DevLocation[] {
  const code = compile(source, { dev: true, generate: "client", filename: file }).js.code;
  const locations: DevLocation[] = [];

  let cursor = 0;
  for (;;) {
    const marker = code.indexOf("[$.FILENAME],", cursor);
    if (marker === -1) break;
    const open = code.indexOf("[", marker + "[$.FILENAME],".length);
    if (open === -1) break;

    let depth = 0;
    let end = -1;
    for (let i = open; i < code.length; i++) {
      if (code[i] === "[") depth++;
      else if (code[i] === "]") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end === -1) break;

    collect(JSON.parse(code.slice(open, end)) as DevLocationTable, file, locations);
    cursor = end;
  }

  // Component call sites are not in the `add_locations` table at all — they go
  // through `add_svelte_meta`, which is also what fills `__svelte_meta.parent`.
  // Reading only the table silently skips every invocation in a fixture.
  for (const match of code.matchAll(/'component',\s*\w+,\s*(\d+),\s*(\d+)/g)) {
    locations.push({ file, line: Number(match[1]), column: Number(match[2]) });
  }

  return locations;
}

function resolved(result: ResolveResult) {
  if (result.status !== "resolved") {
    throw new Error(`expected resolve, got ${result.reason}: ${result.detail ?? ""}`);
  }
  return result.node;
}

function directRange(support: SurfaceSupport) {
  if (support.support !== "direct") {
    throw new Error(`expected direct support, got ${support.reason}`);
  }
  return support.range;
}

describe("resolveElementAtLocation against real dev-emitted locations", () => {
  it.each(fixtureNames)("resolves every location the dev build emits for %s", (name) => {
    const source = fixture(name);
    const file = `src/lib/${name}`;
    const locations = devLocations(source, file);

    for (const location of locations) {
      const node = resolved(resolveElementAtLocation(source, location, parse));
      expect(source.slice(node.range.start, node.range.start + node.tagName.length + 1)).toBe(
        `<${node.tagName}`
      );
    }
  });

  it("finds a location for every fixture that renders something", () => {
    const counts = Object.fromEntries(
      fixtureNames.map((name) => [name, devLocations(fixture(name), name).length])
    );
    // `empty.svelte` renders nothing and must report nothing; every other
    // fixture must contribute, or the corpus sweep above is sweeping past it.
    expect(counts["empty.svelte"]).toBe(0);
    const silent = fixtureNames.filter((name) => name !== "empty.svelte" && counts[name] === 0);
    expect(silent).toEqual([]);
    // invocations.svelte has four `<Card>` call sites, none of which appear in
    // the `add_locations` table.
    expect(counts["invocations.svelte"]).toBe(4);
  });

  it("never finds two elements sharing a start offset anywhere in the corpus", () => {
    for (const name of fixtureNames) {
      const source = fixture(name);
      const ast = parse(source, { modern: true });
      for (const location of devLocations(source, name)) {
        const offset = lineColumnToOffset(source, location.line, location.column);
        expect(offset).not.toBeNull();
        expect(countElementsAtOffset(ast, offset!)).toBe(1);
      }
    }
  });
});

describe("resolveElementAtLocation failure modes", () => {
  const source = fixture("native.svelte");

  it("refuses a location one column past the opening angle bracket", () => {
    const exact = locationOf(source, "<h1");
    const result = resolveElementAtLocation(source, { ...exact, column: exact.column + 1 }, parse);
    expect(result).toEqual({
      status: "failed",
      reason: "no-element-at-location",
      detail: expect.stringContaining("no element starts at offset"),
    });
  });

  it("fails rather than matching the nearest element once the file shifts", () => {
    const location = locationOf(source, "<h1");
    const shifted = `\n${source}`;
    const before = resolved(resolveElementAtLocation(source, location, parse));
    const after = resolveElementAtLocation(shifted, location, parse);

    expect(before.tagName).toBe("h1");
    expect(after.status).toBe("failed");
  });

  it("re-resolves a shifted location to whatever now sits there, which is why a location is not an identity", () => {
    const two = '<p class="a">First</p>\n<p class="b">Second</p>\n';
    const location = locationOf(two, '<p class="b"');
    const shifted = `<p class="x">Inserted</p>\n${two}`;

    const original = directRange(resolved(resolveElementAtLocation(two, location, parse)).text);
    const afterShift = directRange(
      resolved(resolveElementAtLocation(shifted, location, parse)).text
    );

    expect(two.slice(original.start, original.end)).toBe("Second");
    // Same line, same column, clean exact match — and a different element. The
    // caller must pin the file's revision; this function cannot detect it.
    expect(shifted.slice(afterShift.start, afterShift.end)).toBe("First");
  });

  it("resolves the shifted selection again only at its new location", () => {
    const shifted = `\n${source}`;
    const location = locationOf(source, "<h1");
    const node = resolved(
      resolveElementAtLocation(shifted, { ...location, line: location.line + 1 }, parse)
    );
    expect(node.tagName).toBe("h1");
  });

  it("reports a line past the end of the file as out of range", () => {
    const result = resolveElementAtLocation(
      source,
      { file: "src/native.svelte", line: 9_999, column: 0 },
      parse
    );
    expect(result.status === "failed" && result.reason).toBe("location-out-of-range");
  });

  it("reports a column past the end of its line as out of range", () => {
    const location = locationOf(source, "<h1");
    const result = resolveElementAtLocation(source, { ...location, column: 400 }, parse);
    expect(result.status === "failed" && result.reason).toBe("location-out-of-range");
  });

  it("reports a parse failure instead of calling it a miss", () => {
    const result = resolveElementAtLocation(
      "<div>\n  <span>\n",
      { file: "src/broken.svelte", line: 1, column: 0 },
      parse
    );
    expect(result.status === "failed" && result.reason).toBe("parse-failed");
    expect(result.status === "failed" && (result.detail ?? "").length).toBeGreaterThan(0);
  });

  it("rejects a generated file without parsing it at all", () => {
    let parsed = false;
    const spyParse: typeof parse = (...args) => {
      parsed = true;
      return parse(...args);
    };
    for (const file of [
      ".svelte-kit/generated/root.svelte",
      "node_modules/@sveltejs/kit/src/x.svelte",
      "packages/app/node_modules/lib/y.svelte",
    ]) {
      const result = resolveElementAtLocation(source, { file, line: 6, column: 2 }, spyParse);
      expect(result.status === "failed" && result.reason).toBe("generated-file");
    }
    expect(parsed).toBe(false);
  });

  it("finds nothing at an offset inside an element's body", () => {
    const ast = parse(source, { modern: true });
    const inside = source.indexOf("Plain literal heading");
    expect(countElementsAtOffset(ast, inside)).toBe(0);
  });

  it("finds nothing in a component that renders no elements", () => {
    const empty = fixture("empty.svelte");
    const ast = parse(empty, { modern: true });
    let matches = 0;
    for (let offset = 0; offset <= empty.length; offset++) {
      matches += countElementsAtOffset(ast, offset);
    }
    expect(matches).toBe(0);
  });
});

describe("resolved surfaces", () => {
  it("reads a literal text child as directly editable", () => {
    const source = fixture("native.svelte");
    const node = resolved(resolveElementAtLocation(source, locationOf(source, "<h1"), parse));
    const range = directRange(node.text);
    expect(source.slice(range.start, range.end)).toBe("Plain literal heading");
    expect(node.kind).toBe("RegularElement");
  });

  it("refuses text backed by an expression", () => {
    const source = fixture("native.svelte");
    const node = resolved(resolveElementAtLocation(source, locationOf(source, "<h2"), parse));
    expect(node.text).toEqual({ support: "unsupported", reason: "dynamic-expression" });
  });

  it("refuses text mixing a literal and an expression", () => {
    const source = fixture("card.svelte");
    const node = resolved(resolveElementAtLocation(source, locationOf(source, "<button"), parse));
    expect(node.text).toEqual({ support: "unsupported", reason: "mixed-text-and-expression" });
  });

  it("refuses text on an element whose children are elements", () => {
    const source = fixture("native.svelte");
    const node = resolved(resolveElementAtLocation(source, locationOf(source, "<section"), parse));
    expect(node.text).toEqual({ support: "unsupported", reason: "multiple-children" });
  });

  it("reports no text surface for an element with no text at all", () => {
    const source = fixture("unmapped.svelte");
    const node = resolved(resolveElementAtLocation(source, locationOf(source, "<div"), parse));
    expect(node.text).toEqual({ support: "unsupported", reason: "absent" });
  });

  it("reads literal attributes but leaves class out of them", () => {
    const source = fixture("native.svelte");
    const node = resolved(resolveElementAtLocation(source, locationOf(source, "<img"), parse));
    const src = directRange(node.attributes.src!);
    expect(source.slice(src.start, src.end)).toBe("/logo.png");
    const alt = directRange(node.attributes.alt!);
    expect(source.slice(alt.start, alt.end)).toBe("Acme");
    expect(Object.keys(node.attributes).sort()).toEqual(["alt", "src"]);
    expect(directRange(node.classes)).toBeTruthy();
    expect(node.props).toEqual({});
  });

  it("resolves elements in a foreign namespace the same way", () => {
    const source = fixture("native.svelte");
    const node = resolved(resolveElementAtLocation(source, locationOf(source, "<circle"), parse));
    const range = directRange(node.classes);
    expect([node.tagName, source.slice(range.start, range.end)]).toEqual([
      "circle",
      "fill-current",
    ]);
  });
});

describe("literal ranges are quote interiors", () => {
  it("refuses an unquoted attribute value, which would otherwise gain a boolean attribute", () => {
    const unquoted = "<div class=p-4 title=hello>x</div>";
    const node = resolved(resolveElementAtLocation(unquoted, locationOf(unquoted, "<div"), parse));
    expect(node.classes).toEqual({
      support: "unsupported",
      reason: "not-a-writable-literal",
    });
    expect(node.attributes.title).toEqual({
      support: "unsupported",
      reason: "not-a-writable-literal",
    });
  });

  it("accepts single quotes and reports the interior", () => {
    const single = "<div class='p-4 flex'>x</div>";
    const node = resolved(resolveElementAtLocation(single, locationOf(single, "<div"), parse));
    const range = directRange(node.classes);
    expect(single.slice(range.start, range.end)).toBe("p-4 flex");
  });

  it("gives an empty literal a writable zero-width range inside its quotes", () => {
    const empty = '<div class="">x</div>';
    const node = resolved(resolveElementAtLocation(empty, locationOf(empty, "<div"), parse));
    const range = directRange(node.classes);
    expect([range.start, range.end]).toEqual([empty.indexOf('""') + 1, empty.indexOf('""') + 1]);
  });
});

describe("class attribute identity", () => {
  it("treats an upper-cased class as the class surface, because the compiler does", () => {
    const shouty = '<div CLASS="p-4">x</div>';
    const node = resolved(resolveElementAtLocation(shouty, locationOf(shouty, "<div"), parse));
    const range = directRange(node.classes);
    expect(shouty.slice(range.start, range.end)).toBe("p-4");
    expect(Object.keys(node.attributes)).toEqual([]);
  });

  it("refuses when two spellings of class are both present", () => {
    const both = '<div class="p-4" CLASS="p-8">x</div>';
    const node = resolved(resolveElementAtLocation(both, locationOf(both, "<div"), parse));
    expect(node.classes).toEqual({ support: "unsupported", reason: "not-a-writable-literal" });
  });

  it("keeps component prop casing distinct, since props are not HTML attributes", () => {
    const component = '<Card CLASS="p-4" />';
    const node = resolved(
      resolveElementAtLocation(component, locationOf(component, "<Card"), parse)
    );
    expect(Object.keys(node.props)).toEqual(["CLASS"]);
    expect(node.classes).toEqual({ support: "unsupported", reason: "absent" });
  });

  it("keeps an attribute named __proto__ as an own entry", () => {
    const hostile = '<Card __proto__="Basic" />';
    const node = resolved(resolveElementAtLocation(hostile, locationOf(hostile, "<Card"), parse));
    expect(Object.keys(node.props)).toEqual(["__proto__"]);
    expect(Object.prototype.hasOwnProperty.call(node.props, "__proto__")).toBe(true);
  });
});

describe("dynamic elements", () => {
  it("resolves svelte:element at the location the dev build emits for it", () => {
    const dynamic =
      '<script>let t = "div";</script>\n<svelte:element this={t} class="x">hi</svelte:element>\n';
    const location = locationOf(dynamic, "<svelte:element");
    const node = resolved(resolveElementAtLocation(dynamic, location, parse));
    const code = compile(dynamic, { dev: true, generate: "client", filename: "t.svelte" }).js.code;

    expect([node.kind, node.tagName]).toEqual(["SvelteElement", "svelte:element"]);
    // A dynamic element's location is handed to `$.element` rather than put in
    // the locations table, so prove the emitted pair is the one we resolve from.
    expect(code).toContain(`[${location.line}, ${location.column}]`);
  });
});

describe("class forms", () => {
  const source = fixture("dynamic-classes.svelte");

  function classesAt(marker: string) {
    return resolved(resolveElementAtLocation(source, locationOf(source, marker), parse));
  }

  it("refuses an array-form class and still records the class directive", () => {
    const node = classesAt('<button class={["btn"');
    expect(node.classes).toEqual({ support: "unsupported", reason: "dynamic-expression" });
    expect(node.classDirectives).toEqual(["on"]);
  });

  it("refuses a ternary-form class", () => {
    const node = classesAt("<button class={active ?");
    expect(node.classes).toEqual({ support: "unsupported", reason: "dynamic-expression" });
    expect(node.classDirectives).toEqual([]);
  });

  it("refuses a class mixing literal text with an expression", () => {
    const node = classesAt('<div class="grid');
    expect(node.classes).toEqual({ support: "unsupported", reason: "mixed-text-and-expression" });
  });

  it("refuses a lookup-form class", () => {
    const node = classesAt("<div class={sizes");
    expect(node.classes).toEqual({ support: "unsupported", reason: "dynamic-expression" });
  });

  it("keeps a literal class direct on both sides of a spread, and flags the spread", () => {
    for (const marker of ["<div {...rest}", '<div class="text-sm" {...rest}']) {
      const node = classesAt(marker);
      const range = directRange(node.classes);
      expect([source.slice(range.start, range.end), node.hasSpread]).toEqual(["text-sm", true]);
    }
  });

  it("does not claim a spread where there is none", () => {
    expect(classesAt("<div class={sizes").hasSpread).toBe(false);
  });
});

describe("component invocations", () => {
  const source = fixture("invocations.svelte");

  function invocationAt(marker: string) {
    return resolved(resolveElementAtLocation(source, locationOf(source, marker), parse));
  }

  it("reads literal scalar props at one call site", () => {
    const node = invocationAt('<Card plan="Basic"');
    const plan = directRange(node.props.plan!);
    expect([node.kind, node.tagName, source.slice(plan.start, plan.end)]).toEqual([
      "Component",
      "Card",
      "Basic",
    ]);
    expect(node.attributes).toEqual({});
  });

  it("separates the three authored call sites by range", () => {
    const ranges = ['<Card plan="Basic"', '<Card plan="Pro"', '<Card plan="Enterprise"'].map(
      (marker) => invocationAt(marker).range.start
    );
    expect(new Set(ranges).size).toBe(3);
  });

  it("gives a shorthand boolean prop no editable range", () => {
    const node = invocationAt('<Card plan="Pro"');
    expect(node.props.featured).toEqual({
      support: "unsupported",
      reason: "not-a-writable-literal",
    });
  });

  it("offers a braced literal prop but refuses a non-literal expression", () => {
    // `tier={3}` is an expression node wrapping a plain literal: there is a real
    // range to write into, and the planner strips the braces and refuses a write
    // that would change the prop's type.
    expect(invocationAt('<Card plan="Enterprise"').props.tier).toEqual({
      support: "direct",
      range: expect.objectContaining({ start: expect.any(Number), end: expect.any(Number) }),
    });
    // `{plan}` is an identifier — a textual edit would destroy the binding.
    expect(invocationAt("<Card {plan}").props.plan).toEqual({
      support: "unsupported",
      reason: "dynamic-expression",
    });
  });

  it("resolves an invocation inside an each block", () => {
    const node = invocationAt("<Card {plan}");
    expect(node.tagName).toBe("Card");
  });
});

describe("blocks and repetition", () => {
  it("resolves one source element behind many rendered rows", () => {
    const source = fixture("each-blocks.svelte");
    const keyed = resolved(
      resolveElementAtLocation(source, locationOf(source, '<li class="border p-1"'), parse)
    );
    const unkeyed = resolved(
      resolveElementAtLocation(source, locationOf(source, '<li class="border p-2"'), parse)
    );
    expect(keyed.range.start).not.toBe(unkeyed.range.start);
    expect([keyed.tagName, unkeyed.tagName]).toEqual(["li", "li"]);
  });

  it("resolves elements inside every branch of if and await", () => {
    const source = fixture("branches.svelte");
    const markers = [
      '<p class="text-green"',
      '<p class="text-grey"',
      '<p class="opacity-50"',
      '<p class="font-medium"',
      '<p class="text-red"',
    ];
    const starts = markers.map(
      (marker) =>
        resolved(resolveElementAtLocation(source, locationOf(source, marker), parse)).range.start
    );
    expect(new Set(starts).size).toBe(markers.length);
  });

  it("resolves an element authored inside a snippet", () => {
    const source = fixture("snippets.svelte");
    const node = resolved(resolveElementAtLocation(source, locationOf(source, "<li"), parse));
    expect(node.text).toEqual({ support: "unsupported", reason: "dynamic-expression" });
  });

  it("resolves both roots of a multi-root component", () => {
    const source = fixture("multi-root.svelte");
    const first = resolved(
      resolveElementAtLocation(source, locationOf(source, '<div class="first-root'), parse)
    );
    const second = resolved(
      resolveElementAtLocation(source, locationOf(source, '<div class="second-root'), parse)
    );
    expect(second.range.start).toBeGreaterThanOrEqual(first.range.end);
  });
});
