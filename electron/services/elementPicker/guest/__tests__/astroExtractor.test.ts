// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COORDINATE_CONVENTIONS } from "../../../../../shared/elementPicker/coordinates.js";
import { FrameworkEvidenceSchema } from "../../../../../shared/elementPicker/evidence.js";
import { CapabilitiesSchema } from "../../../../../shared/elementPicker/observation.js";
import {
  ElementPickerEventSchema,
  type ElementPickerEvent,
} from "../../../../../shared/elementPicker/protocol.js";
import { SourceCandidateSchema } from "../../../../../shared/elementPicker/source.js";
import { astroExtractor, createAstroExtractor, describeAstro } from "../astroExtractor.js";
import { SERVED_SIBLING_LIMIT } from "../servedDocument.js";
import { ANCESTRY_LIMIT } from "../detectors.js";
import { createPicker, type PickerHandle } from "../picker.js";
import { installExtractor, type ElementPickerExtractor } from "../registry.js";
import type { ExtractorContribution } from "../types.js";

/**
 * Synthetic Astro 7 dev pages: the attributes are what `@astrojs/compiler-rs`
 * stamps with the dev toolbar on, and the islands carry the attributes Astro's
 * runtime renders. Real dev servers are #13887's.
 */
const FILE = "/proj/src/pages/index.astro";
const SECRET = "s3cret-token";

const REACT_ISLAND = `<astro-island id="react-island" uid="r1" component-url="/src/components/Buy.jsx"
  component-export="default" renderer-url="/@id/@astrojs/react/client.js"
  props='{"token":[0,"${SECRET}"]}' ssr="" client="load" opts='{"name":"BuyButton","value":"${SECRET}"}'>`;
const SVELTE_ISLAND = `<astro-island id="svelte-island" uid="s1" component-url="/src/components/Counter.svelte"
  component-export="default" renderer-url="/@id/@astrojs/svelte/client.js"
  props='{"secret":[0,"${SECRET}"]}' ssr="" client="visible" opts='{"name":"Counter","value":true}'>`;

function toolbarOnPage(): void {
  document.body.innerHTML = `
    <main id="main" data-astro-cid-x1="" data-astro-source-file="${FILE}" data-astro-source-loc="5:7">
      <h1 id="title" data-astro-cid-x1="" data-astro-source-file="${FILE}" data-astro-source-loc="6:9">Shop</h1>
      ${REACT_ISLAND}
        <button id="buy">Buy</button>
        <astro-slot id="slot"><em id="slotted" data-astro-source-file="${FILE}" data-astro-source-loc="9:11">Astro text</em><span id="bare-slot">plain</span></astro-slot>
      </astro-island>
      ${SVELTE_ISLAND}<span id="count">0</span></astro-island>
    </main>`;
}

function toolbarOffPage(): void {
  document.body.innerHTML = `
    <main id="main" data-astro-cid-x1="">
      <h1 id="title" data-astro-cid-x1="">Shop</h1>
      ${REACT_ISLAND}<button id="buy">Buy</button></astro-island>
    </main>`;
}

function byId(id: string): Element {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`no #${id} in the fixture`);
  return element;
}

function fields(contribution: ExtractorContribution): Record<string, unknown> {
  const evidence = contribution.frameworkEvidence?.[0];
  if (evidence?.kind !== "generic") throw new Error("expected Astro's generic evidence");
  return Object.fromEntries(evidence.fields.map((field) => [field.name, field.value]));
}

/** Each part in the shape the host admits: the guest cannot import the schemas to check itself. */
function expectWireShaped(contribution: ExtractorContribution): void {
  for (const candidate of contribution.sourceCandidates ?? []) {
    expect(SourceCandidateSchema.safeParse(candidate).success).toBe(true);
  }
  for (const evidence of contribution.frameworkEvidence ?? []) {
    expect(FrameworkEvidenceSchema.safeParse(evidence).success).toBe(true);
  }
  if (contribution.capabilities !== undefined) {
    expect(CapabilitiesSchema.safeParse(contribution.capabilities).success).toBe(true);
  }
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the Astro extractor, toolbar on", () => {
  beforeEach(toolbarOnPage);

  it("reads a template location from the element's own attributes, in the compiler's convention", () => {
    const contribution = describeAstro(byId("title"));
    expectWireShaped(contribution);
    expect(contribution.ownership).toBe("direct");
    expect(contribution.sourceCandidates).toEqual([
      {
        kind: "template-location",
        candidateId: "astro-source",
        framework: "astro",
        extraction: { kind: "attribute", attribute: "data-astro-source-loc" },
        file: FILE,
        location: {
          ...COORDINATE_CONVENTIONS.astroSourceLoc,
          columnUnit: "utf16",
          line: 6,
          column: 9,
        },
      },
    ]);
    expect(contribution.capabilities).toMatchObject({
      file: { state: "available" },
      line: { state: "available" },
      exactRange: { state: "unavailable", reason: "not-exposed" },
      names: { state: "unavailable", reason: "not-exposed" },
    });
    expect(fields(contribution)).toEqual({
      boundary: "page",
      "data-astro-source-file": "present",
      "data-astro-source-loc": "present",
    });
  });

  it("never borrows an ancestor's attributes for an element that has none", () => {
    const span = document.createElement("span");
    byId("title").append(span);
    const contribution = describeAstro(span);
    expect(contribution.sourceCandidates).toEqual([]);
    expect(contribution.capabilities?.file).toEqual({
      state: "unavailable",
      reason: "not-exposed",
    });
  });

  it("offers a file with no line when the location is missing or unusable", () => {
    const title = byId("title");
    for (const loc of [
      null,
      "",
      "abc",
      "0:4",
      "4:0",
      "4",
      "4:5:6",
      "-1:2",
      "10000001:1",
      "123456789:1",
    ]) {
      if (loc === null) title.removeAttribute("data-astro-source-loc");
      else title.setAttribute("data-astro-source-loc", loc);
      const contribution = describeAstro(title);
      expectWireShaped(contribution);
      expect(contribution.sourceCandidates).toEqual([
        {
          kind: "file-hint",
          candidateId: "astro-source",
          framework: "astro",
          extraction: { kind: "attribute", attribute: "data-astro-source-file" },
          file: FILE,
        },
      ]);
      expect(contribution.capabilities?.line).toEqual({
        state: "unavailable",
        reason: "not-exposed",
      });
      expect(fields(contribution)["data-astro-source-loc"]).toBe(
        loc === null ? "absent" : "unusable"
      );
    }
  });

  it("claims no file it would have to cut down or that is not there", () => {
    const title = byId("title");
    for (const file of ["", "/".repeat(2049)]) {
      title.setAttribute("data-astro-source-file", file);
      const contribution = describeAstro(title);
      expect(contribution.sourceCandidates).toEqual([]);
      expect(contribution.capabilities?.file).toEqual({
        state: "unavailable",
        reason: "not-exposed",
      });
      expect(fields(contribution)["data-astro-source-file"]).toBe("unusable");
      // Still stamped markup: Astro's to describe, though it cannot place it.
      expect(contribution.ownership).toBe("direct");
    }
    title.removeAttribute("data-astro-source-file");
    expect(describeAstro(title).sourceCandidates).toEqual([]);
    expect(describeAstro(title).ownership).toBe("direct");
  });

  it("hands an island's interior to its renderer, saying only what the island says of itself", () => {
    const contribution = describeAstro(byId("buy"));
    expectWireShaped(contribution);
    expect(contribution).toEqual({ frameworkEvidence: [expect.anything()] });
    expect(fields(contribution)).toEqual({
      boundary: "island",
      "data-astro-source-file": "absent",
      "data-astro-source-loc": "absent",
      islandRenderer: "react",
      "astro-island[client]": "load",
      "astro-island[component-export]": "default",
      "astro-island[opts].name": "BuyButton",
    });
    // Props, the opts value and every URL stay in the page.
    const wire = JSON.stringify(contribution);
    for (const leak of [SECRET, "Buy.jsx", "@astrojs/react/client.js"]) {
      expect(wire).not.toContain(leak);
    }
  });

  it("describes Astro content slotted into an island, stamped or not", () => {
    const slotted = describeAstro(byId("slotted"));
    expect(slotted.ownership).toBe("direct");
    expect(slotted.sourceCandidates?.[0]?.kind).toBe("template-location");
    expect(fields(slotted)).toMatchObject({ boundary: "slot", islandRenderer: "react" });

    const bare = describeAstro(byId("bare-slot"));
    expect(bare.ownership).toBe("direct");
    expect(bare.sourceCandidates).toEqual([]);
    expect(bare.capabilities?.line).toEqual({ state: "unavailable", reason: "not-exposed" });

    // The slot element itself is rendered by the island's framework.
    expect(describeAstro(byId("slot"))).toEqual({ frameworkEvidence: [expect.anything()] });

    const staticSlot = document.createElement("astro-static-slot");
    const inner = document.createElement("i");
    staticSlot.append(inner);
    byId("svelte-island").append(staticSlot);
    expect(fields(describeAstro(inner))).toMatchObject({
      boundary: "slot",
      islandRenderer: "svelte",
    });
  });

  it("describes the island element itself, without inventing a location for it", () => {
    const contribution = describeAstro(byId("svelte-island"));
    expect(contribution.ownership).toBe("direct");
    expect(contribution.sourceCandidates).toEqual([]);
    expect(fields(contribution)).toMatchObject({
      boundary: "island-host",
      islandRenderer: "svelte",
      "astro-island[opts].name": "Counter",
    });
  });

  it("hands off to the nearest island when islands nest through a slot", () => {
    const nested = document.createElement("astro-island");
    nested.setAttribute("renderer-url", "/@id/@astrojs/vue/client.js");
    const leaf = document.createElement("b");
    nested.append(leaf);
    byId("slotted").after(nested);
    const contribution = describeAstro(leaf);
    expect(contribution.capabilities).toBeUndefined();
    expect(fields(contribution)).toMatchObject({ boundary: "island", islandRenderer: "vue" });
  });

  it("does not claim to know an element is outside an island when the walk ran out", () => {
    let parent: Element = byId("buy");
    for (let depth = 0; depth < ANCESTRY_LIMIT; depth += 1) {
      const child = document.createElement("div");
      parent.append(child);
      parent = child;
    }
    const contribution = describeAstro(parent);
    expect(contribution.capabilities).toBeUndefined();
    expect(fields(contribution).boundary).toBe("unknown");
  });

  it("reports only the island attributes it can read safely", () => {
    const island = byId("react-island");
    island.setAttribute("renderer-url", "/@id/@astrojs/qwik/client.js");
    island.setAttribute("client", "load; alert(1)");
    island.setAttribute("component-export", "default\nother");
    for (const opts of ["not json", "[1]", '{"name":42}', `{"name":"${"x".repeat(1100)}"}`]) {
      island.setAttribute("opts", opts);
      expect(fields(describeAstro(byId("buy")))).toEqual({
        boundary: "island",
        "data-astro-source-file": "absent",
        "data-astro-source-loc": "absent",
        islandRenderer: "unrecognized",
      });
    }
    island.removeAttribute("renderer-url");
    expect(fields(describeAstro(byId("buy"))).islandRenderer).toBeNull();
  });

  it("does nothing on hover", () => {
    const refs = { ref: () => null };
    expect(astroExtractor.extract(byId("title"), "hover", refs)).toBeNull();
    expect(astroExtractor.extract(byId("buy"), "hover", refs)).toBeNull();
  });
});

describe("the Astro extractor, toolbar off", () => {
  beforeEach(toolbarOffPage);

  it("says the location is not exposed, and gives way to any framework that can do better", () => {
    const contribution = describeAstro(byId("title"));
    expectWireShaped(contribution);
    expect(contribution.ownership).toBe("fallback");
    expect(contribution.sourceCandidates).toEqual([]);
    expect(contribution.capabilities).toMatchObject({
      file: { state: "unavailable", reason: "not-exposed" },
      line: { state: "unavailable", reason: "not-exposed" },
    });
    expect(fields(contribution)).toEqual({
      boundary: "page",
      "data-astro-source-file": "absent",
      "data-astro-source-loc": "absent",
    });
  });
});

/**
 * What Astro's toolbar leaves once its Audit app has run: the markup as
 * served, with both attributes taken off every element, and the toolbar
 * appended to the body. The served copy is what the host read back.
 */
const SERVED_BODY = `
    <main id="main" data-astro-source-file="${FILE}" data-astro-source-loc="5:7">
      <h1 id="title" data-astro-source-file="${FILE}" data-astro-source-loc="6:9">Shop</h1>
      <p data-astro-source-file="${FILE}" data-astro-source-loc="7:10">First <span>plain</span></p>
      <p data-astro-source-file="${FILE}" data-astro-source-loc="8:10">Second</p>
      <li data-astro-source-file="${FILE}" data-astro-source-loc="9:8">Same</li>
      <li data-astro-source-file="${FILE}" data-astro-source-loc="10:8">Same</li>
      <section id="a"><a data-astro-source-file="${FILE}" data-astro-source-loc="12:20">Details</a></section>
      <section id="b"><a data-astro-source-file="${FILE}" data-astro-source-loc="14:20">Details</a></section>
      ${REACT_ISLAND}<button id="buy" data-astro-source-file="${FILE}" data-astro-source-loc="16:9">Buy</button></astro-island>
    </main>`;

function servedPage(body = SERVED_BODY): { url: string; html: string } {
  return {
    url: location.href,
    html: `<!doctype html><html><head><title>Shop</title></head><body>${body}</body></html>`,
  };
}

function strippedPage(): void {
  document.body.innerHTML = SERVED_BODY;
  for (const element of document.querySelectorAll("[data-astro-source-file]")) {
    element.removeAttribute("data-astro-source-file");
    element.removeAttribute("data-astro-source-loc");
  }
  document.body.append(document.createElement("astro-dev-toolbar"));
}

function paragraphs(): Element[] {
  return [...document.querySelectorAll("main > p")];
}

function items(): Element[] {
  return [...document.querySelectorAll("main > li")];
}

describe("the Astro extractor once the toolbar has taken the stamps off", () => {
  beforeEach(strippedPage);
  afterEach(() => {
    vi.restoreAllMocks();
    document.head.innerHTML = "";
    for (const added of document.querySelectorAll("html > daintree-overlay")) added.remove();
  });

  const select = (extractor: ElementPickerExtractor, element: Element) =>
    extractor.extract(element, "selection", { ref: () => null }) ?? {};

  it("reads the pair from the element's counterpart in the markup as served", () => {
    const extractor = createAstroExtractor(servedPage());
    const title = select(extractor, byId("title"));
    expectWireShaped(title);
    expect(title.ownership).toBe("direct");
    expect(title.sourceCandidates).toEqual([
      {
        kind: "template-location",
        candidateId: "astro-source",
        framework: "astro",
        extraction: { kind: "attribute", attribute: "data-astro-source-loc" },
        file: FILE,
        location: {
          ...COORDINATE_CONVENTIONS.astroSourceLoc,
          columnUnit: "utf16",
          line: 6,
          column: 9,
        },
      },
    ]);
    // The live element's attributes are reported as they are: gone.
    expect(fields(title)).toEqual({
      boundary: "page",
      "data-astro-source-file": "absent",
      "data-astro-source-loc": "absent",
      servedDocument: "matched",
    });
    const second = select(extractor, paragraphs()[1]!);
    expect(second.sourceCandidates?.[0]).toMatchObject({ location: { line: 8, column: 10 } });
  });

  it("is not thrown off by elements of other names that page script added", () => {
    const extractor = createAstroExtractor(servedPage());
    document.head.append(document.createElement("style"));
    byId("main").prepend(document.createElement("div"));
    document.documentElement.append(document.createElement("daintree-overlay"));
    expect(select(extractor, paragraphs()[1]!).sourceCandidates?.[0]).toMatchObject({
      location: { line: 8, column: 10 },
    });
  });

  it("refuses a counterpart once page script added or removed an element of the same name beside it", () => {
    const extractor = createAstroExtractor(servedPage());
    expect(select(extractor, items()[1]!).sourceCandidates?.[0]).toMatchObject({
      location: { line: 10, column: 8 },
    });
    // Same name, same text: only the count of them tells the second from a newcomer.
    const added = document.createElement("li");
    added.textContent = "Same";
    items()[0]!.before(added);
    const shifted = select(extractor, items()[1]!);
    expect(shifted.sourceCandidates).toEqual([]);
    expect(shifted.ownership).toBe("fallback");
    expect(fields(shifted).servedDocument).toBe("unmatched");

    strippedPage();
    items()[0]!.remove();
    expect(fields(select(extractor, items()[0]!)).servedDocument).toBe("unmatched");
  });

  it("refuses a counterpart once page script reordered what tells same-named elements apart", () => {
    const extractor = createAstroExtractor(servedPage());
    const links = () => [...document.querySelectorAll("section > a")];
    expect(select(extractor, links()[1]!).sourceCandidates?.[0]).toMatchObject({
      location: { line: 14, column: 20 },
    });
    // The second section moved first: its link reads like the first one's in every other way.
    byId("a").before(byId("b"));
    expect(fields(select(extractor, links()[0]!)).servedDocument).toBe("unmatched");

    strippedPage();
    links()[0]!.setAttribute("href", "/elsewhere");
    expect(fields(select(extractor, links()[0]!)).servedDocument).toBe("unmatched");
  });

  it("compares the whole of an element's own text, however long", () => {
    const long = "word ".repeat(2000);
    const body = SERVED_BODY.replace(">Shop</h1>", `>${long}end</h1>`);
    const extractor = createAstroExtractor(servedPage(body));
    document.body.innerHTML = body;
    const title = byId("title");
    title.removeAttribute("data-astro-source-file");
    title.removeAttribute("data-astro-source-loc");
    expect(fields(select(extractor, title)).servedDocument).toBe("matched");
    // Only the last characters differ.
    title.textContent = `${long}End`;
    expect(fields(select(extractor, title)).servedDocument).toBe("unmatched");
    title.textContent = `${long}end `;
    expect(fields(select(extractor, title)).servedDocument).toBe("unmatched");
    // The same length, one space become a tab: whitespace is compared too.
    title.textContent = `${long.replace(" ", "\t")}end`;
    expect(fields(select(extractor, title)).servedDocument).toBe("unmatched");
    // Split across text nodes, the text is still the element's own, read whole.
    title.replaceChildren(long, document.createComment(""), "end");
    expect(fields(select(extractor, title)).servedDocument).toBe("matched");
    title.replaceChildren(long, document.createComment(""), "End");
    expect(fields(select(extractor, title)).servedDocument).toBe("unmatched");
  });

  it("gives up on an element with more children than it reads", () => {
    const extractor = createAstroExtractor(servedPage());
    const title = byId("title");
    for (let index = 0; index < SERVED_SIBLING_LIMIT; index += 1) {
      title.append(document.createComment(""));
    }
    expect(fields(select(extractor, title)).servedDocument).toBe("unmatched");
  });

  it("refuses a counterpart whose id or own text page script changed", () => {
    const extractor = createAstroExtractor(servedPage());
    byId("title").textContent = "Basket";
    expect(fields(select(extractor, byId("title"))).servedDocument).toBe("unmatched");

    strippedPage();
    paragraphs()[1]!.id = "second";
    expect(fields(select(extractor, paragraphs()[1]!)).servedDocument).toBe("unmatched");
  });

  it("never borrows an ancestor's served stamps for an element the compiler did not stamp", () => {
    const extractor = createAstroExtractor(servedPage());
    const span = select(extractor, document.querySelector("main > p > span")!);
    expect(span.sourceCandidates).toEqual([]);
    expect(fields(span).servedDocument).toBe("unstamped");
  });

  it("keeps to the element's own attributes while it still carries either", () => {
    const extractor = createAstroExtractor(servedPage());
    const title = byId("title");
    title.setAttribute("data-astro-source-file", FILE);
    title.setAttribute("data-astro-source-loc", "16:9");
    const live = select(extractor, title);
    expect(live.sourceCandidates?.[0]).toMatchObject({ location: { line: 16, column: 9 } });
    expect(fields(live)).not.toHaveProperty("servedDocument");

    // Half a pair is still the page's word, not to be completed from older markup.
    title.removeAttribute("data-astro-source-loc");
    expect(select(extractor, title).sourceCandidates).toEqual([
      expect.objectContaining({ kind: "file-hint", file: FILE }),
    ]);
  });

  it("leaves an island's interior to its renderer, whatever the served markup stamped there", () => {
    const extractor = createAstroExtractor(servedPage());
    const buy = select(extractor, byId("buy"));
    expect(buy.sourceCandidates).toBeUndefined();
    expect(fields(buy)).not.toHaveProperty("servedDocument");
  });

  it("matches nothing in a shadow root, which the served markup does not describe", () => {
    const extractor = createAstroExtractor(servedPage());
    const host = document.createElement("section");
    byId("main").append(host);
    const inner = document.createElement("h1");
    host.attachShadow({ mode: "open" }).append(inner);
    expect(fields(select(extractor, inner)).servedDocument).toBe("unmatched");
  });

  it("reads nothing from markup served for another URL, or when the host had none to give", () => {
    const elsewhere = createAstroExtractor({ ...servedPage(), url: "http://elsewhere.localhost/" });
    expect(fields(select(elsewhere, byId("title"))).servedDocument).toBe("unavailable");
    // A client-side navigation moved the page on after the markup was fetched.
    const extractor = createAstroExtractor(servedPage());
    const original = location.href;
    try {
      history.pushState(null, "", "/other");
      expect(fields(select(extractor, byId("title"))).servedDocument).toBe("unavailable");
    } finally {
      history.replaceState(null, "", original);
    }
    for (const served of [null, undefined, { url: location.href }, "<h1></h1>"]) {
      const title = select(createAstroExtractor(served), byId("title"));
      expect(title.sourceCandidates).toEqual([]);
      expect(fields(title).servedDocument).toBe("unavailable");
    }
  });

  it("ignores either URL's fragment, which never reaches the server", () => {
    const served = servedPage();
    const extractor = createAstroExtractor({ ...served, url: `${served.url}#top` });
    try {
      history.replaceState(null, "", "#reviews");
      expect(fields(select(extractor, byId("title"))).servedDocument).toBe("matched");
    } finally {
      history.replaceState(null, "", served.url);
    }
  });

  it("parses once, on the first selection that needs it, and never on hover", () => {
    const parse = vi.spyOn(DOMParser.prototype, "parseFromString");
    const extractor = createAstroExtractor(servedPage());
    expect(extractor.selectionOnly).toBe(true);
    expect(extractor.extract(byId("title"), "hover", { ref: () => null })).toBeNull();
    expect(parse).not.toHaveBeenCalled();
    select(extractor, byId("title"));
    select(extractor, paragraphs()[1]!);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("does not try the parse again once it failed", () => {
    const parse = vi.spyOn(DOMParser.prototype, "parseFromString").mockImplementation(() => {
      throw new TypeError("This document requires 'TrustedHTML' assignment.");
    });
    const extractor = createAstroExtractor(servedPage());
    expect(fields(select(extractor, byId("title"))).servedDocument).toBe("unavailable");
    expect(fields(select(extractor, byId("title"))).servedDocument).toBe("unavailable");
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("lets the served copy go with the extractor, parsed or not", () => {
    const parse = vi.spyOn(DOMParser.prototype, "parseFromString");
    const unparsed = createAstroExtractor(servedPage());
    unparsed.dispose?.();
    expect(fields(select(unparsed, byId("title"))).servedDocument).toBe("unavailable");
    expect(parse).not.toHaveBeenCalled();

    const parsed = createAstroExtractor(servedPage());
    expect(fields(select(parsed, byId("title"))).servedDocument).toBe("matched");
    parsed.dispose?.();
    expect(fields(select(parsed, byId("title"))).servedDocument).toBe("unavailable");
  });
});

describe("a page with islands in two frameworks", () => {
  const CHANNEL = "astro-test-channel";
  let events: ElementPickerEvent[] = [];
  let frames: FrameRequestCallback[] = [];
  let picker: PickerHandle | null = null;

  /** Stands in for React's extractor: it claims anything under a React island's root, slot content too. */
  const reactExtractor: ElementPickerExtractor = {
    extract(element) {
      const island = element.closest("astro-island");
      if (island === null || !island.getAttribute("renderer-url")?.includes("@astrojs/react")) {
        return null;
      }
      return {
        componentChain: {
          nearestId: "react-1",
          components: [
            {
              componentId: "react-1",
              framework: "react",
              name: {
                value: "BuyButton",
                extraction: { kind: "runtime-field", field: "type.name" },
              },
              environment: "client",
              rootElementIds: [],
              rootsComplete: false,
              sourceCandidates: [],
            },
          ],
          truncated: false,
        },
        capabilities: {
          names: { state: "available" },
          chain: { state: "available" },
          componentSelection: { state: "unknown" },
          file: { state: "unknown" },
          line: { state: "unknown" },
          exactRange: { state: "unknown" },
        },
      };
    },
  };
  /** The Svelte extractor this build ships: installed, and silent. */
  const svelteExtractor: ElementPickerExtractor = { extract: () => null };

  function install(order: Array<"astro" | "react" | "svelte">): void {
    const extractors = { astro: astroExtractor, react: reactExtractor, svelte: svelteExtractor };
    for (const framework of order) {
      installExtractor({ channel: CHANNEL, framework, installed: false }, extractors[framework]);
    }
  }

  function select(id: string) {
    const before = events.length;
    (byId(id) as HTMLElement).click();
    const fresh = events.slice(before).filter((event) => event.type === "selectionChanged");
    // Exactly one new description per click, so no test reads an earlier one.
    expect(fresh).toHaveLength(1);
    const observation = fresh[0]?.observations[0];
    if (observation === undefined) throw new Error(`#${id} was not described`);
    return observation;
  }

  beforeEach(() => {
    events = [];
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    toolbarOnPage();
    picker = createPicker({
      channel: CHANNEL,
      mode: "select",
      post: (event) => {
        // Everything the bootstrap says has to survive the host's own schema.
        const parsed = ElementPickerEventSchema.safeParse(event);
        if (!parsed.success) throw new Error(`host would reject ${event.type}: ${parsed.error}`);
        events.push(event);
      },
    });
  });

  afterEach(() => {
    // Also disposes the registry, which listens on the document.
    picker?.dispose();
    picker = null;
    vi.unstubAllGlobals();
  });

  it("gives Astro, React and Svelte selections side by side", () => {
    install(["astro", "react", "svelte"]);

    const title = select("title");
    expect(title.sourceCandidates).toEqual([
      expect.objectContaining({ framework: "astro", kind: "template-location" }),
    ]);
    expect(title.capabilities.line).toEqual({ state: "available" });

    const buy = select("buy");
    expect(buy.componentChain.components.map((record) => record.name?.value)).toEqual([
      "BuyButton",
    ]);
    expect(buy.capabilities.chain).toEqual({ state: "available" });
    expect(buy.frameworkEvidence).toEqual([
      expect.objectContaining({ kind: "generic", framework: "astro" }),
    ]);

    // Svelte's extractor said nothing: the observation says what Astro saw around
    // the element, and leaves Svelte's capabilities unestablished rather than absent.
    const count = select("count");
    expect(count.componentChain.components).toEqual([]);
    expect(Object.values(count.capabilities)).toEqual(
      Array.from({ length: 6 }, () => ({ state: "unknown" }))
    );
    expect(count.frameworkEvidence).toEqual([
      expect.objectContaining({
        framework: "astro",
        fields: expect.arrayContaining([{ name: "islandRenderer", value: "svelte" }]),
      }),
    ]);
  });

  const orders: Array<Array<"astro" | "react" | "svelte">> = [
    ["react", "astro", "svelte"],
    ["astro", "react", "svelte"],
  ];
  it.each(orders)(
    "gives Astro the content it slotted into a React island, installed as %s, %s, %s",
    (...order) => {
      install(order);
      // Nothing is reported absent until the host's look at the page settles.
      picker?.setAvailability({
        detection: "settled",
        extractors: { astro: "installed", react: "installed", svelte: "installed" },
      });
      const slotted = select("slotted");
      expect(slotted.sourceCandidates).toEqual([
        expect.objectContaining({ framework: "astro", kind: "template-location" }),
      ]);
      expect(slotted.componentChain.components).toEqual([]);
      expect(slotted.capabilities.names).toEqual({ state: "unavailable", reason: "not-exposed" });
    }
  );

  it("leaves a hover's capabilities open rather than taking Astro's skipped hover for a look", () => {
    install(["astro", "react", "svelte"]);
    picker?.setAvailability({
      detection: "settled",
      extractors: { astro: "installed", react: "installed", svelte: "installed" },
    });
    byId("title").dispatchEvent(new MouseEvent("pointermove", { bubbles: true, composed: true }));
    for (const frame of frames.splice(0)) frame(0);
    const [hover] = events.flatMap((event) =>
      event.type === "hoverChanged" && event.observation !== null ? [event.observation] : []
    );
    expect(hover?.tagName).toBe("h1");
    expect(hover?.capabilities.file).toEqual({ state: "unknown" });
    expect(hover?.capabilities.line).toEqual({ state: "unknown" });
    // Selected, the same element's location is Astro's to give.
    expect(select("title").capabilities.line).toEqual({ state: "available" });
  });

  it("leaves the hover label to the island's renderer, with nothing of Astro's in it", () => {
    install(["astro", "react", "svelte"]);
    for (const id of ["buy", "title"]) {
      byId(id).dispatchEvent(new MouseEvent("pointermove", { bubbles: true, composed: true }));
      for (const frame of frames.splice(0)) frame(0);
    }
    const hovers = events.flatMap((event) =>
      event.type === "hoverChanged" && event.observation !== null ? [event.observation] : []
    );
    expect(hovers.map((hover) => hover.tagName)).toEqual(["button", "h1"]);
    expect(hovers[0]?.componentChain.components.map((record) => record.name?.value)).toEqual([
      "BuyButton",
    ]);
    for (const hover of hovers) {
      expect(hover.frameworkEvidence).toEqual([]);
      expect(hover.sourceCandidates).toEqual([]);
    }
  });
});
