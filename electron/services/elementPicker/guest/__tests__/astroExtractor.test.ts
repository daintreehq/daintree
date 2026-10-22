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
import { astroExtractor, describeAstro } from "../astroExtractor.js";
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
      const slotted = select("slotted");
      expect(slotted.sourceCandidates).toEqual([
        expect.objectContaining({ framework: "astro", kind: "template-location" }),
      ]);
      expect(slotted.componentChain.components).toEqual([]);
      expect(slotted.capabilities.names).toEqual({ state: "unavailable", reason: "not-exposed" });
    }
  );

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
