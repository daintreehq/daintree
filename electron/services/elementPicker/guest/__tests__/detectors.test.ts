// @vitest-environment jsdom
import { h, render } from "preact";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  FrameworkDetectionSchema,
  OBSERVATION_LIMITS,
} from "../../../../../shared/elementPicker/observation.js";
import {
  ANCESTRY_LIMIT,
  BODY_TAIL_LIMIT,
  DETECTION_LIMITS,
  DOCUMENT_SAMPLE_LIMIT,
  DetectionSet,
  detectAncestry,
  detectExpandos,
  detectGlobals,
  detectMarkup,
  islandRenderer,
  sampleDocument,
} from "../detectors.js";

const DetectionsSchema = z.array(FrameworkDetectionSchema).max(OBSERVATION_LIMITS.detections);

function frameworks(set: DetectionSet): string[] {
  return set.toArray().map((entry) => entry.framework);
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("detection limits", () => {
  it("restates the shared schema's limits, which the guest cannot import", () => {
    expect(DETECTION_LIMITS).toEqual({
      detections: OBSERVATION_LIMITS.detections,
      signals: OBSERVATION_LIMITS.signals,
    });
  });

  it("stays within what the host will admit however much evidence there is", () => {
    const set = new DetectionSet();
    for (let index = 0; index < 40; index += 1) set.add("react", "attribute", `signal-${index}`);
    for (const framework of ["svelte", "vue", "angular", "astro", "preact", "solid"] as const) {
      set.add(framework, "global", "x");
    }
    const detections = set.toArray();
    expect(DetectionsSchema.safeParse(detections).success).toBe(true);
    expect(detections.find((entry) => entry.framework === "react")?.signals).toHaveLength(
      OBSERVATION_LIMITS.signals
    );
  });

  it("reports a repeated signal once", () => {
    const set = new DetectionSet();
    set.add("vue", "expando", "__vnode");
    set.add("vue", "expando", "__vnode");
    set.add("vue", "document-sample", "__vnode");
    expect(set.toArray()).toEqual([
      {
        framework: "vue",
        signals: [
          { via: "expando", name: "__vnode" },
          { via: "document-sample", name: "__vnode" },
        ],
      },
    ]);
  });
});

describe("detectGlobals", () => {
  it("reads framework-set globals, including SvelteKit's hash-suffixed one", () => {
    const set = new DetectionSet();
    detectGlobals({ __VUE__: true, __sveltekit_1a2b3c: {}, unrelated: 1 }, set);
    expect(set.toArray()).toEqual([
      { framework: "svelte", signals: [{ via: "global", name: "__sveltekit_*" }] },
      { framework: "vue", signals: [{ via: "global", name: "__VUE__" }] },
    ]);
  });

  it("ignores a devtools hook, which says the extension is there, not the framework", () => {
    const set = new DetectionSet();
    detectGlobals({ __REACT_DEVTOOLS_GLOBAL_HOOK__: {}, SolidDevtools$$: {} }, set);
    expect(set.size).toBe(0);
  });

  it("finds a client-rendered Solid dev build, which has no hydration marks to find", () => {
    const set = new DetectionSet();
    detectGlobals({ Solid$$: true }, set);
    expect(set.toArray()).toEqual([
      { framework: "solid", signals: [{ via: "global", name: "Solid$$" }] },
    ]);
  });

  it("survives a hostile global object", () => {
    const hostile = new Proxy(
      {},
      {
        has() {
          throw new Error("no");
        },
        ownKeys() {
          throw new Error("no");
        },
      }
    );
    const set = new DetectionSet();
    expect(() => detectGlobals(hostile, set)).not.toThrow();
    expect(set.size).toBe(0);
  });
});

describe("detectExpandos", () => {
  it("matches React's per-root suffixed keys and reports the marker, not the key", () => {
    const node = document.createElement("div");
    (node as unknown as Record<string, unknown>)["__reactFiber$k3j2h1"] = {};
    const set = new DetectionSet();
    detectExpandos(node, set);
    expect(set.toArray()).toEqual([
      { framework: "react", signals: [{ via: "expando", name: "__reactFiber$*" }] },
    ]);
  });

  it("finds nothing on a node without expandos", () => {
    const set = new DetectionSet();
    detectExpandos(document.createElement("div"), set);
    expect(set.size).toBe(0);
  });

  it("finds Preact on the container it rendered into, the only node that carries its tree", () => {
    const container = document.createElement("div");
    render(h("p", null, "rendered"), container);
    try {
      const atContainer = new DetectionSet();
      detectExpandos(container, atContainer);
      expect(atContainer.toArray()).toEqual([
        { framework: "preact", signals: [{ via: "expando", name: "__k" }] },
      ]);
      const atRendered = new DetectionSet();
      detectExpandos(container.querySelector("p")!, atRendered);
      expect(atRendered.size).toBe(0);
    } finally {
      render(null, container);
    }
  });

  it("finds Vue's expandos, which a dev build defines non-enumerable", () => {
    const node = document.createElement("div");
    for (const name of ["__vnode", "__vueParentComponent"]) {
      Object.defineProperty(node, name, { value: {}, enumerable: false, configurable: true });
    }
    expect(Object.keys(node)).toEqual([]);
    const set = new DetectionSet();
    detectExpandos(node, set);
    expect(set.toArray()).toEqual([
      {
        framework: "vue",
        signals: [
          { via: "expando", name: "__vueParentComponent" },
          { via: "expando", name: "__vnode" },
        ],
      },
    ]);
  });

  it("does not take an inherited property for an expando", () => {
    const proto = Object.create(HTMLDivElement.prototype) as object;
    Object.defineProperty(proto, "__vnode", { value: {} });
    const node = document.createElement("div");
    Object.setPrototypeOf(node, proto);
    const set = new DetectionSet();
    detectExpandos(node, set);
    expect(set.size).toBe(0);
  });
});

describe("detectMarkup", () => {
  it("reads an Astro island's renderer and the island itself as separate frameworks", () => {
    document.body.innerHTML =
      '<astro-island renderer-url="/@id/@astrojs/svelte/client.js"></astro-island>';
    const set = new DetectionSet();
    detectMarkup(document.querySelector("astro-island")!, "attribute", set);
    expect(frameworks(set)).toEqual(["astro", "svelte"]);
  });

  it("names an island's renderer from the fixed table, and nothing else", () => {
    expect(islandRenderer("/@fs/app/node_modules/@astrojs/preact/dist/client.js")).toBe("preact");
    expect(islandRenderer("/@id/@astrojs/qwik/client.js")).toBeNull();
  });

  it("reads a static slot as Astro's", () => {
    document.body.innerHTML = "<astro-static-slot><p>Server text</p></astro-static-slot>";
    const set = new DetectionSet();
    detectAncestry(document.querySelector("p")!, set);
    expect(set.toArray()).toEqual([
      { framework: "astro", signals: [{ via: "attribute", name: "<astro-static-slot>" }] },
    ]);
  });

  it("never reports a value the page chose as a signal name", () => {
    document.body.innerHTML =
      '<div ng-version="999-<script>" _nghost-evil-name="" class="svelte-abc123 other"></div>';
    const set = new DetectionSet();
    detectMarkup(document.querySelector("div")!, "attribute", set);
    const names = set.toArray().flatMap((entry) => entry.signals.map((signal) => signal.name));
    expect(names).toEqual(["ng-version", "_nghost-*", "class=svelte-*"]);
  });

  it("reads a letters-only hash as Svelte's scoped class, but not a word too short to be one", () => {
    document.body.innerHTML = '<p class="svelte-qwkzbe"></p><div class="svelte-logo"></div>';
    const hashed = new DetectionSet();
    detectMarkup(document.querySelector("p")!, "attribute", hashed);
    expect(frameworks(hashed)).toEqual(["svelte"]);
    const word = new DetectionSet();
    detectMarkup(document.querySelector("div")!, "attribute", word);
    expect(word.size).toBe(0);
  });
});

describe("sampleDocument", () => {
  it("stops at its limit, so a marker past it goes unseen", () => {
    // Last in the body, where only a tag past the sample is read, never an attribute.
    document.body.innerHTML = "<p></p>".repeat(20) + '<div data-v-app=""></div>';
    const bounded = new DetectionSet();
    sampleDocument(document, bounded, { expandos: false, limit: 10 });
    expect(bounded.size).toBe(0);

    const full = new DetectionSet();
    sampleDocument(document, full, { expandos: false });
    expect(full.toArray()).toEqual([
      { framework: "vue", signals: [{ via: "document-sample", name: "data-v-app" }] },
    ]);
  });

  it("reads the body's last children past the sample, where Astro's dev toolbar is appended", () => {
    document.body.innerHTML = "<p></p>".repeat(DOCUMENT_SAMPLE_LIMIT);
    document.body.append(document.createElement("astro-dev-toolbar"));
    const found = new DetectionSet();
    sampleDocument(document, found, { expandos: false });
    expect(found.toArray()).toEqual([
      { framework: "astro", signals: [{ via: "document-sample", name: "<astro-dev-toolbar>" }] },
    ]);
  });

  it("reads only a bounded number of the body's last children", () => {
    document.body.innerHTML = "<p></p>".repeat(DOCUMENT_SAMPLE_LIMIT);
    document.body.append(document.createElement("astro-dev-toolbar"));
    for (let index = 0; index < BODY_TAIL_LIMIT; index += 1) {
      document.body.append(document.createElement("div"));
    }
    const found = new DetectionSet();
    sampleDocument(document, found, { expandos: false });
    expect(found.size).toBe(0);
  });

  it("reads expandos only when asked to", () => {
    document.body.innerHTML = "<div></div>";
    (document.querySelector("div") as unknown as Record<string, unknown>).__ngContext__ = 1;
    const markupOnly = new DetectionSet();
    sampleDocument(document, markupOnly, { expandos: false });
    expect(markupOnly.size).toBe(0);
    const withExpandos = new DetectionSet();
    sampleDocument(document, withExpandos, { expandos: true });
    expect(frameworks(withExpandos)).toEqual(["angular"]);
  });
});

describe("detectAncestry", () => {
  it("walks out of a shadow root to its host", () => {
    document.body.innerHTML = '<section data-astro-cid-x1=""><span id="host"></span></section>';
    const host = document.getElementById("host")!;
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = "<button>inside</button>";
    const set = new DetectionSet();
    detectAncestry(root.querySelector("button")!, set);
    expect(set.toArray()).toEqual([
      { framework: "astro", signals: [{ via: "attribute", name: "data-astro-cid-*" }] },
    ]);
  });

  it("stops after a bounded number of ancestors", () => {
    let html = '<div ng-version="1">';
    for (let depth = 0; depth < ANCESTRY_LIMIT + 5; depth += 1) html += "<div>";
    html += '<span id="leaf"></span>';
    document.body.innerHTML = html;
    const set = new DetectionSet();
    detectAncestry(document.getElementById("leaf")!, set);
    expect(set.size).toBe(0);
  });
});
