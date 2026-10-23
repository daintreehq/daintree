// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COORDINATE_CONVENTIONS } from "../../../../../shared/elementPicker/coordinates.js";
import {
  click,
  componentNames,
  evidenceOf,
  lastSelection,
  loc,
  locOf,
  ofType,
  runFrames,
  setMeta,
  start,
  stop,
} from "./svelteHarness.js";

afterEach(() => {
  stop();
});

describe("source metadata", () => {
  it("reports the template location, the invocation and the ancestry verbatim, innermost first", () => {
    document.body.innerHTML = '<article><button id="cta">Buy</button></article>';
    const button = document.body.querySelector("#cta")!;
    const outer = {
      type: "component",
      file: "src/routes/+page.svelte",
      line: 12,
      column: 1,
      componentTag: "PricingCard",
    };
    const inner = { type: "each", file: "src/lib/Card.svelte", line: 3, column: 4, parent: outer };
    setMeta(button, loc(7, 6, "src/lib/Card.svelte"), inner);
    const { events } = start();

    click(button);
    const [node] = lastSelection(events);

    expect(node?.sourceCandidates).toEqual([
      {
        kind: "template-location",
        candidateId: "svelte-loc",
        framework: "svelte",
        extraction: { kind: "runtime-field", field: "__svelte_meta.loc" },
        file: "src/lib/Card.svelte",
        location: { ...COORDINATE_CONVENTIONS.svelteMeta, columnUnit: "utf16", line: 7, column: 6 },
      },
    ]);
    expect(evidenceOf(node).ancestry).toEqual([
      { type: "each", file: "src/lib/Card.svelte", line: 3, column: 4 },
      {
        type: "component",
        file: "src/routes/+page.svelte",
        line: 12,
        column: 1,
        componentTag: "PricingCard",
      },
    ]);
    const [record] = node!.componentChain.components;
    expect(node?.componentChain.nearestId).toBe(record?.componentId);
    expect(record).toMatchObject({
      framework: "svelte",
      name: {
        value: "PricingCard",
        extraction: { kind: "runtime-field", field: "__svelte_meta.parent.componentTag" },
      },
      environment: "client",
      sourceCandidates: [
        {
          kind: "component-invocation",
          file: "src/routes/+page.svelte",
          location: { line: 12, column: 1 },
        },
      ],
    });
    // Unobserved, not absent: the chain cannot say which edge a frame is.
    expect(record).not.toHaveProperty("renderParentId");
    expect(record).not.toHaveProperty("ownerId");
  });

  it("drops malformed frames rather than the whole chain", () => {
    document.body.innerHTML = "<button>Buy</button>";
    const button = document.body.querySelector("button")!;
    const good = { type: "component", file: "src/routes/+page.svelte", line: 12, column: 0 };
    setMeta(button, loc(7), { type: "each", file: "", line: -1, column: null, parent: good });
    const { events } = start();

    click(button);

    expect(evidenceOf(lastSelection(events)[0]).ancestry).toEqual([good]);
  });

  it("truncates an over-long chain and says so, once, instead of being dropped by the host", () => {
    document.body.innerHTML = "<button>Buy</button><b>b</b>";
    let chain: Record<string, unknown> | undefined;
    for (let depth = 0; depth < 80; depth += 1) {
      chain = {
        type: "if",
        file: "src/lib/Deep.svelte",
        line: depth + 1,
        column: 0,
        parent: chain,
      };
    }
    setMeta(document.body.querySelector("button")!, loc(7), chain);
    setMeta(document.body.querySelector("b")!, loc(8), chain);
    const { events } = start();

    click(document.body.querySelector("button")!);
    expect(evidenceOf(lastSelection(events)[0]).ancestry).toHaveLength(64);
    click(document.body.querySelector("b")!);

    expect(ofType(events, "runtimeIssue")).toEqual([
      expect.objectContaining({ code: "capacity", framework: "svelte" }),
    ]);
  });

  it("survives a self-referential parent chain", () => {
    document.body.innerHTML = "<button>Buy</button>";
    const frame: Record<string, unknown> = {
      type: "each",
      file: "src/lib/Loop.svelte",
      line: 2,
      column: 0,
    };
    frame.parent = frame;
    setMeta(document.body.querySelector("button")!, loc(7), frame);
    const { events } = start();

    click(document.body.querySelector("button")!);

    expect(evidenceOf(lastSelection(events)[0]).ancestry).toHaveLength(1);
  });

  it("counts every live element rendered by the same markup, and says which one this is", () => {
    document.body.innerHTML = "<div></div><div></div><div></div><span></span>";
    for (const card of document.body.querySelectorAll("div")) setMeta(card, loc(14));
    setMeta(document.body.querySelector("span")!, loc(19));
    const { events } = start();

    click(document.body.querySelectorAll("div")[2]!);
    expect(evidenceOf(lastSelection(events)[0])).toMatchObject({ sameLocCount: 3, locIndex: 2 });

    click(document.body.querySelector("span")!);
    expect(evidenceOf(lastSelection(events)[0])).toMatchObject({ sameLocCount: 1, locIndex: 0 });
  });

  it("reports an unmarked node that could be the template's own, for the host to place", () => {
    // Raw `{@html}` markup and a template element whose stamp hydration
    // dropped look the same here: unstamped, at the tail of a stamped parent.
    document.body.innerHTML = '<div id="prose"><em id="raw">from {@html}</em></div>';
    setMeta(document.body.querySelector("#prose")!, loc(21));
    const { events } = start();

    click(document.body.querySelector("#raw")!);
    const [node] = lastSelection(events);

    expect(node?.tagName).toBe("em");
    expect(locOf(node)).toBeNull();
    expect(evidenceOf(node)).toMatchObject({
      unmapped: false,
      structure: {
        file: "src/routes/+page.svelte",
        path: [
          { tag: "div", index: 0 },
          { tag: "em", index: 0 },
        ],
      },
    });
    // Placed by shape: the host walks the template for the line.
    expect(node?.capabilities.file).toEqual({ state: "available" });
    expect(node?.capabilities.line).toEqual({ state: "unknown" });
  });

  it("selects the nearest mapped ancestor of an unmarked node the template cannot own", () => {
    // Unstamped, but followed by a stamped sibling of the same frame: the
    // hydration walk never leaves a template element ahead of a stamped one.
    document.body.innerHTML =
      '<div id="prose"><em id="raw">from {@html}</em><p id="after">p</p></div>';
    const page = { type: "component", file: "root.svelte", line: 1, column: 0 };
    setMeta(document.body.querySelector("#prose")!, loc(21), page);
    setMeta(document.body.querySelector("#after")!, loc(22), page);
    const { picker, events } = start();

    click(document.body.querySelector("#raw")!);
    const [node] = lastSelection(events);

    expect(node?.tagName).toBe("div");
    expect(locOf(node)).toEqual(loc(21));
    // Judged by what was clicked, not by the element standing in for it.
    expect(evidenceOf(node).unmapped).toBe(true);

    // Described again, it is still the click's answer.
    const before = ofType(events, "selectionChanged").length;
    picker.setAvailability({ detection: "settled", extractors: { svelte: "installed" } });
    expect(ofType(events, "selectionChanged")).toHaveLength(before + 1);
    const [again] = lastSelection(events);
    expect(again?.elementId).toBe(node?.elementId);
    expect(evidenceOf(again).unmapped).toBe(true);
  });

  it("refuses a source path it would have to truncate, and an unsafe line number", () => {
    document.body.innerHTML = "<button></button>";
    const button = document.body.querySelector("button")!;
    const long = "src/" + "a".repeat(1200) + ".svelte";
    setMeta(button, loc(3), {
      type: "component",
      file: long,
      line: 1,
      column: 0,
      componentTag: "Long",
      parent: { type: "each", file: "src/lib/Ok.svelte", line: 2 ** 53, column: 0 },
    });
    const { events } = start();

    click(button);
    const [node] = lastSelection(events);

    // Neither frame is quietly reshaped into a different file or a number the
    // host's schema rejects.
    expect(evidenceOf(node).ancestry).toEqual([]);
    expect(node?.componentChain.components).toEqual([]);
  });

  it("keeps a long template location whole rather than call the element unstamped", () => {
    document.body.innerHTML = '<div id="outer"><p id="deep">x</p></div>';
    const long = "src/" + "nested/".repeat(200) + "Deep.svelte";
    setMeta(document.getElementById("outer")!, loc(1));
    setMeta(document.getElementById("deep")!, loc(4, 2, long));
    const { events } = start();

    click(document.getElementById("deep")!);
    const [node] = lastSelection(events);

    expect(long.length).toBeGreaterThan(1024);
    expect(node?.tagName).toBe("p");
    expect(locOf(node)).toEqual(loc(4, 2, long));
    // The evidence cannot carry the path, so it places nothing by it.
    expect(evidenceOf(node).structure).toBeUndefined();
  });

  it("re-counts occurrences once the document's structure has changed", async () => {
    document.body.innerHTML = "<u></u><u></u>";
    for (const node of document.body.querySelectorAll("u")) setMeta(node, loc(60));
    const { events } = start();
    click(document.body.querySelector("u")!);
    expect(evidenceOf(lastSelection(events)[0]).sameLocCount).toBe(2);

    document.body.querySelectorAll("u")[1]!.remove();
    // Observer records arrive as a microtask, as they do between two clicks.
    await Promise.resolve();
    click(document.body.querySelector("u")!);

    expect(evidenceOf(lastSelection(events)[0]).sameLocCount).toBe(1);
  });

  it("claims no occurrence for a copy past the scan bound, and calls the count a floor", () => {
    const filler = Array.from({ length: 20_050 }, () => "<i></i>").join("");
    document.body.innerHTML = `<b id="first"></b>${filler}<b id="late"></b>`;
    setMeta(document.getElementById("first")!, loc(40));
    setMeta(document.getElementById("late")!, loc(40));
    const { events } = start();

    click(document.getElementById("first")!);
    expect(evidenceOf(lastSelection(events)[0])).toMatchObject({
      locIndex: 0,
      sameLocCount: 1,
      sameLocCountPartial: true,
    });
    click(document.getElementById("late")!);
    expect(evidenceOf(lastSelection(events)[0])).not.toHaveProperty("locIndex");
  });
});

describe("unmapped regions", () => {
  it("marks canvas, shadow-root and cross-origin frame targets visual-only", () => {
    document.body.innerHTML =
      '<canvas id="chart"></canvas><div id="widget"></div><iframe id="frame"></iframe>';
    const canvas = document.body.querySelector("#chart")!;
    const widget = document.body.querySelector("#widget")!;
    const frame = document.body.querySelector("#frame")!;
    for (const node of [canvas, widget, frame]) setMeta(node, loc(30));
    const inner = document.createElement("span");
    widget.attachShadow({ mode: "open" }).appendChild(inner);
    Object.defineProperty(frame, "contentDocument", { value: null });
    const { events } = start();

    click(canvas);
    expect(evidenceOf(lastSelection(events)[0]).unmapped).toBe(true);

    click(inner);
    expect(lastSelection(events)[0]?.tagName).toBe("div");
    expect(evidenceOf(lastSelection(events)[0]).unmapped).toBe(true);

    click(frame);
    expect(evidenceOf(lastSelection(events)[0]).unmapped).toBe(true);
  });

  it("reports a mapped element of the page as markup", () => {
    document.body.innerHTML = '<h1 id="title">Hello</h1>';
    setMeta(document.body.querySelector("#title")!, loc(2));
    const { events } = start();

    click(document.body.querySelector("#title")!);

    expect(evidenceOf(lastSelection(events)[0]).unmapped).toBe(false);
  });

  it("treats an upgraded custom element as visual-only", () => {
    if (customElements.get("legacy-widget") === undefined) {
      customElements.define("legacy-widget", class extends HTMLElement {});
    }
    document.body.innerHTML = "<legacy-widget></legacy-widget>";
    const widget = document.body.querySelector("legacy-widget")!;
    setMeta(widget, loc(44));
    const { events } = start();

    click(widget);

    expect(evidenceOf(lastSelection(events)[0]).unmapped).toBe(true);
  });

  it("leaves an element with no Svelte stamp above it to whoever else knows it", () => {
    document.body.innerHTML = '<main id="app"><button class="cta">Start</button></main>';
    const { events } = start();

    click(document.querySelector("button")!);
    const [node] = lastSelection(events);

    expect(node?.frameworkEvidence).toEqual([]);
    expect(node?.sourceCandidates).toEqual([]);
    expect(node?.capabilities.file).toEqual({ state: "unknown" });
  });
});

describe("metadata capabilities", () => {
  const corpus = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/svelte-meta");
  function stampFrom(fixture: string, id = "stamped"): Element {
    const meta = JSON.parse(readFileSync(path.join(corpus, fixture), "utf8")) as {
      loc: unknown;
      parent?: unknown;
    };
    const node = document.createElement("section");
    node.id = id;
    document.body.appendChild(node);
    setMeta(node, meta.loc, meta.parent);
    return node;
  }

  const available = { state: "available" };
  const notExposed = { state: "unavailable", reason: "not-exposed" };

  it.each([
    ["loc-and-parent.json", available, available],
    ["loc-only.json", available, notExposed],
    ["blocks-only.json", available, notExposed],
    ["malformed.json", notExposed, notExposed],
  ])("answers %s with what its shape supports", (fixture, location, chain) => {
    const node = stampFrom(fixture);
    const { events, picker } = start();
    // The host has finished looking at the page and Svelte's is its only
    // reader: what Svelte says it cannot offer, nothing else could.
    picker.setAvailability({ detection: "settled", extractors: { svelte: "installed" } });

    click(node);
    const capabilities = lastSelection(events)[0]?.capabilities;

    expect(capabilities).toMatchObject({
      file: location,
      line: location,
      names: chain,
      chain,
      componentSelection: chain,
      exactRange: { state: "unknown" },
    });
  });

  it("answers for the page, not for the one element asked about", () => {
    // The page's root has no component above it, but the page does have
    // components: the root's empty chain is not the metadata's limit.
    const root = stampFrom("loc-only.json", "root");
    stampFrom("loc-and-parent.json", "card");
    const { events } = start();

    click(root);

    expect(lastSelection(events)[0]?.capabilities.chain).toEqual({ state: "unknown" });
  });
});

describe("hover", () => {
  it("shortens an oversized chain rather than lose the hover's answer", () => {
    document.body.innerHTML = '<p id="one">a</p>';
    // Each quote doubles in JSON: well inside the schema, past the bridge's ceiling.
    const file = '"'.repeat(1000);
    let chain: Record<string, unknown> | undefined;
    for (let depth = 0; depth < 64; depth += 1) {
      chain = {
        type: "component",
        file,
        line: depth + 1,
        column: 0,
        componentTag: "C" + depth,
        parent: chain,
      };
    }
    setMeta(document.getElementById("one")!, loc(3), chain);
    const { events } = start();

    document
      .getElementById("one")!
      .dispatchEvent(new MouseEvent("pointermove", { bubbles: true, composed: true }));
    runFrames();

    const hover = ofType(events, "hoverChanged").at(-1)?.observation;
    expect(componentNames(hover)[0]).toBe("C63");
    expect(hover?.componentChain.truncated).toBe(true);
    expect(locOf(hover)).toEqual(loc(3));
  });

  it("names the location and component without sweeping the document", () => {
    document.body.innerHTML = '<p id="one">a</p>';
    const card = {
      type: "component",
      file: "src/routes/+page.svelte",
      line: 4,
      column: 2,
      componentTag: "Card",
    };
    setMeta(document.getElementById("one")!, loc(3), card);
    const { events } = start();
    const sweeps = vi.spyOn(document, "getElementsByTagName");

    document
      .getElementById("one")!
      .dispatchEvent(new MouseEvent("pointermove", { bubbles: true, composed: true }));
    runFrames();

    const hover = ofType(events, "hoverChanged").at(-1)?.observation;
    expect(locOf(hover)).toEqual(loc(3));
    expect(componentNames(hover)).toEqual(["Card"]);
    expect(hover?.frameworkEvidence).toEqual([]);
    expect(sweeps).not.toHaveBeenCalled();
  });
});

describe("a hostile page", () => {
  const PAGE = { type: "component", file: "root.svelte", line: 1, column: 0, componentTag: "Page" };

  it("reads through a throwing `__svelte_meta` getter on the element it is asked about", () => {
    document.body.innerHTML = '<div id="host"><span id="hostile">x</span></div>';
    setMeta(document.body.querySelector("#host")!, loc(9), PAGE);
    const hostile = document.body.querySelector("#hostile")!;
    Object.defineProperty(hostile, "__svelte_meta", {
      configurable: true,
      get() {
        throw new Error("denied");
      },
    });
    const { events } = start();

    expect(() => click(hostile)).not.toThrow();
    // Unreadable is unstamped: placed against the nearest stamp that does read.
    const [node] = lastSelection(events);
    expect(locOf(node)).toBeNull();
    expect(evidenceOf(node).structure?.file).toBe(loc(9).file);
  });

  it("reads through a stamp whose own fields throw", () => {
    document.body.innerHTML = "<b></b>";
    const b = document.body.querySelector("b")!;
    (b as unknown as { __svelte_meta: unknown }).__svelte_meta = {
      get loc() {
        throw new Error("denied");
      },
      get parent() {
        throw new Error("denied");
      },
    };
    const { events } = start();

    expect(() => click(b)).not.toThrow();
    const [node] = lastSelection(events);
    expect(locOf(node)).toBeNull();
    expect(evidenceOf(node).ancestry).toEqual([]);
  });

  it("sweeps the document once for a location, however many of its elements are asked about", () => {
    document.body.innerHTML = '<ul><li id="a">1</li><li id="b">2</li><li id="c">3</li></ul>';
    for (const id of ["a", "b", "c"]) setMeta(document.getElementById(id)!, loc(7), PAGE);
    const { events } = start();
    const sweeps = vi.spyOn(document, "getElementsByTagName");

    click(document.getElementById("a")!);
    const afterOne = sweeps.mock.calls.filter((call) => call[0] === "*").length;
    click(document.getElementById("b")!);
    click(document.getElementById("c")!);

    expect(sweeps.mock.calls.filter((call) => call[0] === "*")).toHaveLength(afterOne);
    expect(evidenceOf(lastSelection(events)[0])).toMatchObject({ sameLocCount: 3, locIndex: 2 });
  });
});

describe("structural path", () => {
  it("reports where a node sits among its own frame's elements, not the DOM's", () => {
    // A hydrated page: the Header component's root precedes the template's
    // own elements, and Svelte's location walk counted it.
    document.body.innerHTML = [
      '<header id="h"><h1>Site</h1></header>',
      '<div id="journal"><div id="toolbar"><p>September</p></div></div>',
      '<div id="end"><span>*</span></div>',
    ].join("");
    const page = {
      type: "component",
      file: ".svelte-kit/generated/root.svelte",
      line: 56,
      column: 18,
      componentTag: "Pyramid_2",
    };
    const header = {
      type: "component",
      file: "src/routes/+page.svelte",
      line: 6,
      column: 0,
      componentTag: "Header",
      parent: page,
    };
    setMeta(document.getElementById("h")!, loc(7, 0), header);
    setMeta(document.getElementById("journal")!, loc(18, 0), page);
    setMeta(document.getElementById("toolbar")!, loc(19, 2), page);
    setMeta(document.getElementById("end")!, loc(20, 0), page);
    const { events } = start();

    click(document.getElementById("toolbar")!);
    expect(evidenceOf(lastSelection(events)[0]).structure).toEqual({
      file: "src/routes/+page.svelte",
      path: [
        { tag: "div", index: 0 },
        { tag: "div", index: 0 },
      ],
    });
    click(document.getElementById("end")!);
    expect(evidenceOf(lastSelection(events)[0]).structure).toEqual({
      file: "src/routes/+page.svelte",
      path: [{ tag: "div", index: 1 }],
    });
  });

  it("places an unstamped element at the tail of a stamped run, and refuses one before a stamped sibling", () => {
    document.body.innerHTML = [
      '<div id="journal"><div id="toolbar"><p id="label">September</p><nav id="nav"><div id="months"></div><div id="years"><a id="year">2026</a></div></nav></div></div>',
      '<section id="late"><i id="raw">x</i><p id="stamped">y</p></section>',
    ].join("");
    const page = {
      type: "component",
      file: "root.svelte",
      line: 1,
      column: 0,
      componentTag: "Page",
    };
    setMeta(document.getElementById("journal")!, loc(366, 0), page);
    setMeta(document.getElementById("toolbar")!, loc(367, 1), page);
    setMeta(document.getElementById("late")!, loc(370, 0), page);
    setMeta(document.getElementById("stamped")!, loc(372, 2), page);
    const { events } = start();

    click(document.getElementById("label")!);
    let [node] = lastSelection(events);
    expect(locOf(node)).toBeNull();
    expect(node?.tagName).toBe("p");
    expect(evidenceOf(node).unmapped).toBe(false);
    expect(evidenceOf(node).ancestry[0]).toMatchObject({ type: "component", componentTag: "Page" });
    expect(evidenceOf(node).structure).toEqual({
      file: "src/routes/+page.svelte",
      path: [
        { tag: "div", index: 0 },
        { tag: "div", index: 0 },
        { tag: "p", index: 0 },
      ],
    });
    // Claimed by the template's file with no position, for the host to place
    // from the shape: never a line the page didn't stamp.
    expect(node?.sourceCandidates).toEqual([
      expect.objectContaining({
        kind: "template-location",
        file: "src/routes/+page.svelte",
        location: null,
      }),
    ]);
    click(document.getElementById("year")!);
    [node] = lastSelection(events);
    expect(evidenceOf(node).structure).toEqual({
      file: "src/routes/+page.svelte",
      path: [
        { tag: "div", index: 0 },
        { tag: "div", index: 0 },
        { tag: "nav", index: 1 },
        { tag: "div", index: 1 },
        { tag: "a", index: 0 },
      ],
    });
    // Before a stamped sibling under a stamped parent: not the template's. The
    // pick stands for the stamped ancestor.
    click(document.getElementById("raw")!);
    expect(locOf(lastSelection(events)[0])).toEqual(loc(370, 0));
  });

  it("does not claim a dropped root for the enclosing component's template", () => {
    document.body.innerHTML =
      '<div id="shell"><header id="h">h</header><div id="end"><p id="p">end</p></div></div>';
    const shellFile = "src/lib/components/SitePageShell.svelte";
    const shellFrame = {
      type: "component",
      file: "src/routes/+layout.svelte",
      line: 13,
      column: 0,
      componentTag: "SitePageShell",
    };
    const render = { type: "render", file: shellFile, line: 53, column: 1, parent: shellFrame };
    const pageFrame = {
      type: "component",
      file: ".svelte-kit/generated/root.svelte",
      line: 56,
      column: 18,
      componentTag: "Pyramid_2",
      parent: render,
    };
    const headerFrame = {
      type: "component",
      file: "src/routes/+page.svelte",
      line: 6,
      column: 0,
      componentTag: "Header",
      parent: pageFrame,
    };
    setMeta(document.getElementById("shell")!, loc(53, 1, shellFile), shellFrame);
    setMeta(document.getElementById("h")!, loc(3, 0, "src/lib/Header.svelte"), headerFrame);
    const { events } = start();

    click(document.getElementById("p")!);
    const [node] = lastSelection(events);
    expect(node?.tagName).toBe("div");
    expect(locOf(node)).toEqual(loc(53, 1, shellFile));
    expect(evidenceOf(node).unmapped).toBe(true);

    // A child component of the shell's own template beside it is fine: only a
    // block, or nothing, lies between its frame and the anchor's.
    const widget = {
      type: "component",
      file: shellFile,
      line: 60,
      column: 2,
      componentTag: "Widget",
      parent: shellFrame,
    };
    setMeta(document.getElementById("h")!, loc(9, 0, "src/lib/Widget.svelte"), widget);
    click(document.getElementById("p")!);
    expect(evidenceOf(lastSelection(events)[0]).structure).toEqual({
      file: shellFile,
      path: [
        { tag: "div", index: 0 },
        { tag: "div", index: 0 },
        { tag: "p", index: 0 },
      ],
    });
  });

  it("refuses a node after a snippet rendered inline, whose walk may have stamped it", () => {
    document.body.innerHTML =
      '<header id="h">H</header><section id="a1"></section><section id="a2"></section><section id="b1"></section>';
    const page = {
      type: "component",
      file: "root.svelte",
      line: 1,
      column: 0,
      componentTag: "Page",
    };
    const renderB = { type: "render", file: "src/X.svelte", line: 4, column: 0, parent: page };
    const renderA = { type: "render", file: "src/X.svelte", line: 3, column: 14, parent: renderB };
    const header = {
      type: "component",
      file: "src/X.svelte",
      line: 2,
      column: 14,
      componentTag: "Header",
      parent: renderA,
    };
    setMeta(document.getElementById("h")!, loc(1, 0, "src/Header.svelte"), header);
    setMeta(document.getElementById("a1")!, loc(2, 40, "src/X.svelte"), renderA);
    setMeta(document.getElementById("a2")!, loc(3, 60, "src/X.svelte"), renderB);
    setMeta(document.getElementById("b1")!, loc(3, 40, "src/X.svelte"), renderB);
    const { events } = start();

    click(document.getElementById("a2")!);
    expect(evidenceOf(lastSelection(events)[0]).structure).toBeUndefined();
    click(document.getElementById("b1")!);
    expect(evidenceOf(lastSelection(events)[0]).structure).toBeUndefined();
    click(document.getElementById("a1")!);
    expect(evidenceOf(lastSelection(events)[0]).structure).toEqual({
      file: "src/X.svelte",
      path: [{ tag: "section", index: 0 }],
    });
  });

  it("does not claim a block's dropped root for the enclosing template", () => {
    document.body.innerHTML =
      '<div id="wrap"><i id="c1">c</i><!--[--><i id="c2">c</i><section id="inside"></section><!--]--><section id="outside"></section></div>';
    const page = {
      type: "component",
      file: "root.svelte",
      line: 1,
      column: 0,
      componentTag: "Page",
    };
    const c1 = {
      type: "component",
      file: "src/routes/+page.svelte",
      line: 3,
      column: 2,
      componentTag: "C",
      parent: page,
    };
    const ifFrame = {
      type: "if",
      file: "src/routes/+page.svelte",
      line: 4,
      column: 2,
      parent: page,
    };
    const c2 = {
      type: "component",
      file: "src/routes/+page.svelte",
      line: 4,
      column: 10,
      componentTag: "C",
      parent: ifFrame,
    };
    setMeta(document.getElementById("wrap")!, loc(2, 0), page);
    setMeta(document.getElementById("c1")!, loc(1, 0, "src/C.svelte"), c1);
    setMeta(document.getElementById("c2")!, loc(1, 0, "src/C.svelte"), c2);
    const { events } = start();

    click(document.getElementById("inside")!);
    expect(locOf(lastSelection(events)[0])).toEqual(loc(2, 0));
    // The template's own dropped tail, outside the region, is placed.
    click(document.getElementById("outside")!);
    expect(evidenceOf(lastSelection(events)[0]).structure).toEqual({
      file: "src/routes/+page.svelte",
      path: [
        { tag: "div", index: 0 },
        { tag: "section", index: 0 },
      ],
    });
  });

  it("does not place raw markup that inherited a stamp inside a descendant component", () => {
    document.body.innerHTML =
      '<aside id="aside"><div id="raw"><p id="rawp">raw</p></div></aside><div id="own"><p>authored</p></div>';
    const page = {
      type: "component",
      file: "root.svelte",
      line: 1,
      column: 0,
      componentTag: "Page",
    };
    const wrapper = {
      type: "component",
      file: "src/routes/+page.svelte",
      line: 2,
      column: 0,
      componentTag: "RawWrapper",
      parent: page,
    };
    setMeta(document.getElementById("aside")!, loc(1, 0, "src/RawWrapper.svelte"), wrapper);
    setMeta(document.getElementById("raw")!, loc(3, 5), page);
    setMeta(document.getElementById("own")!, loc(2, 13), page);
    const { events } = start();

    click(document.getElementById("rawp")!);

    expect(evidenceOf(lastSelection(events)[0]).structure).toBeUndefined();
  });

  it("refuses a node beside a snippet's own element rendered inline", () => {
    document.body.innerHTML = '<i id="s">snippet</i><section id="a"></section><div id="d"></div>';
    const page = {
      type: "component",
      file: "root.svelte",
      line: 1,
      column: 0,
      componentTag: "Page",
    };
    const renderA = { type: "render", file: "src/X.svelte", line: 3, column: 0, parent: page };
    setMeta(document.getElementById("s")!, loc(2, 14, "src/X.svelte"), renderA);
    setMeta(document.getElementById("a")!, loc(3, 30, "src/X.svelte"), page);
    setMeta(document.getElementById("d")!, loc(3, 30, "src/X.svelte"), page);
    const { events } = start();

    click(document.getElementById("a")!);

    expect(evidenceOf(lastSelection(events)[0]).structure).toBeUndefined();
  });

  it("stops the path at the frame's edge, so a component's root is a root", () => {
    document.body.innerHTML =
      '<section id="outer"><article id="root"><b id="leaf">x</b></article></section>';
    const page = {
      type: "component",
      file: "root.svelte",
      line: 1,
      column: 0,
      componentTag: "Page",
    };
    const card = {
      type: "component",
      file: "src/routes/+page.svelte",
      line: 3,
      column: 2,
      componentTag: "Card",
      parent: page,
    };
    setMeta(document.getElementById("outer")!, loc(2, 0), page);
    setMeta(document.getElementById("root")!, loc(9, 0, "src/lib/Card.svelte"), card);
    setMeta(document.getElementById("leaf")!, loc(10, 2, "src/lib/Card.svelte"), card);
    const { events } = start();

    click(document.getElementById("leaf")!);

    expect(evidenceOf(lastSelection(events)[0]).structure).toEqual({
      file: "src/lib/Card.svelte",
      path: [
        { tag: "article", index: 0 },
        { tag: "b", index: 0 },
      ],
    });
  });

  it("does not place what `<svelte:head>` rendered into the head", () => {
    const meta = document.createElement("meta");
    document.head.appendChild(meta);
    setMeta(meta, loc(4));
    const { events } = start();

    click(meta);

    expect(evidenceOf(lastSelection(events)[0]).structure).toBeUndefined();
  });
});
