// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  EXTRACTOR_REGISTRY_GLOBAL,
  MAX_BRIDGE_MESSAGE_CHARS,
  MAX_ELEMENT_REFS,
  MAX_LOCATED_REPLY_CHARS,
  channelEvent,
  type ExtractReply,
  type LocatedReply,
} from "../../guestChannel.js";
import { installExtractor, type ElementPickerExtractor, type ElementRefs } from "../registry.js";

const CHANNEL = "registry-test";
const scope = globalThis as Record<string, unknown>;

/** What the bootstrap's side of the channel would see, in the order it arrived. */
function listenAsBootstrap(): {
  log: Array<{ type: string; target: EventTarget; detail: unknown }>;
  stop(): void;
} {
  const log: Array<{ type: string; target: EventTarget; detail: unknown }> = [];
  const controller = new AbortController();
  for (const name of ["element", "extracted", "located"] as const) {
    document.addEventListener(
      channelEvent(CHANNEL, name),
      (event) => {
        const path = event.composedPath();
        log.push({
          type: name,
          target: path[0] ?? event.target!,
          detail: (event as CustomEvent).detail,
        });
      },
      { capture: true, signal: controller.signal }
    );
  }
  return { log, stop: () => controller.abort() };
}

function request(target: Element, id = 1, pick = false): void {
  target.dispatchEvent(
    new CustomEvent(channelEvent(CHANNEL, "extract"), {
      detail: JSON.stringify(pick ? { id, phase: "selection", pick } : { id, phase: "selection" }),
      composed: true,
    })
  );
}

function locate(target: EventTarget, id: number, framework = "svelte"): void {
  target.dispatchEvent(
    new CustomEvent(channelEvent(CHANNEL, "locate"), {
      detail: JSON.stringify({ id, framework, query: { kind: "roots" } }),
      composed: true,
    })
  );
}

function install(framework: string, extractor: ElementPickerExtractor): void {
  installExtractor({ channel: CHANNEL, framework, installed: false }, extractor);
}

afterEach(() => {
  (scope[EXTRACTOR_REGISTRY_GLOBAL] as { dispose(): void } | undefined)?.dispose();
  document.body.innerHTML = "";
});

describe("element refs", () => {
  it("sends each named element across as an event on it, before the reply that names it", () => {
    document.body.innerHTML = '<main><p id="a"></p><p id="b"></p></main>';
    const a = document.getElementById("a")!;
    const b = document.getElementById("b")!;
    let tokens: Array<string | null> = [];
    install("react", {
      extract: (_element, _phase, refs) => {
        tokens = [refs.ref(a), refs.ref(b), refs.ref(a)];
        return { componentChain: { nearestId: null, components: [], truncated: false } };
      },
    });
    const bootstrap = listenAsBootstrap();
    request(a, 7);
    bootstrap.stop();

    expect(tokens[0]).not.toBeNull();
    expect(tokens[2]).toBe(tokens[0]);
    expect(tokens[1]).not.toBe(tokens[0]);
    expect(bootstrap.log.map((entry) => [entry.type, entry.target])).toEqual([
      ["element", a],
      ["element", b],
      ["extracted", document],
    ]);
    expect(JSON.parse(bootstrap.log[0]!.detail as string)).toEqual({ id: 7, ref: 0 });
    expect(JSON.parse(bootstrap.log[1]!.detail as string)).toEqual({ id: 7, ref: 1 });
  });

  it("refuses a node an event could not carry to the bootstrap as itself", () => {
    document.body.innerHTML = '<div id="open-host"></div><div id="closed-host"></div>';
    const open = document.getElementById("open-host")!.attachShadow({ mode: "open" });
    const closed = document.getElementById("closed-host")!.attachShadow({ mode: "closed" });
    const inOpen = open.appendChild(document.createElement("span"));
    const inClosed = closed.appendChild(document.createElement("span"));
    const detached = document.createElement("span");
    const foreign = document.implementation.createHTMLDocument("other").createElement("span");
    const seen: Record<string, string | null> = {};
    install("react", {
      extract: (_element, _phase, refs) => {
        seen.open = refs.ref(inOpen);
        seen.closed = refs.ref(inClosed);
        seen.detached = refs.ref(detached);
        seen.foreign = refs.ref(foreign);
        return null;
      },
    });
    const bootstrap = listenAsBootstrap();
    request(document.body);
    bootstrap.stop();

    expect(seen.open).not.toBeNull();
    expect(seen).toMatchObject({ closed: null, detached: null, foreign: null });
    // The open root's node arrives as itself, not retargeted to its host.
    expect(bootstrap.log.filter((entry) => entry.type === "element").map((e) => e.target)).toEqual([
      inOpen,
    ]);
  });

  it("names at most its limit of elements per reply, shared by every extractor", () => {
    const nodes = Array.from({ length: MAX_ELEMENT_REFS + 10 }, () =>
      document.body.appendChild(document.createElement("i"))
    );
    const results: Array<Array<string | null>> = [];
    const naming = (from: number, to: number): ElementPickerExtractor => ({
      extract: (_element, _phase, refs: ElementRefs) => {
        results.push(nodes.slice(from, to).map((node) => refs.ref(node)));
        return null;
      },
    });
    install("react", naming(0, 200));
    install("vue", naming(200, MAX_ELEMENT_REFS + 10));
    const bootstrap = listenAsBootstrap();
    request(document.body);
    bootstrap.stop();

    const all = results.flat();
    expect(all.filter((token) => token !== null)).toHaveLength(MAX_ELEMENT_REFS);
    expect(new Set(all.filter((token) => token !== null)).size).toBe(MAX_ELEMENT_REFS);
    expect(bootstrap.log.filter((entry) => entry.type === "element")).toHaveLength(
      MAX_ELEMENT_REFS
    );
  });

  it("does not name a node a listener moved behind a closed root after it was referenced", () => {
    document.body.innerHTML = '<p id="a"></p><p id="b"></p><div id="closed-host"></div>';
    const a = document.getElementById("a")!;
    const b = document.getElementById("b")!;
    const closed = document.getElementById("closed-host")!.attachShadow({ mode: "closed" });
    install("react", {
      extract: (_element, _phase, refs) => {
        refs.ref(a);
        refs.ref(b);
        return null;
      },
    });
    // Page code on the channel, moving the second node as the first is named.
    document.addEventListener(
      channelEvent(CHANNEL, "element"),
      () => {
        if (b.isConnected && b.getRootNode() === document) closed.appendChild(b);
      },
      { capture: true, once: true }
    );
    const bootstrap = listenAsBootstrap();
    request(a);
    bootstrap.stop();

    expect(bootstrap.log.filter((entry) => entry.type === "element").map((e) => e.target)).toEqual([
      a,
    ]);
  });

  it("keeps every other framework's answer when one extractor throws", () => {
    document.body.innerHTML = "<p></p>";
    install("vue", {
      extract: () => {
        throw new Error("broken reader");
      },
    });
    install("react", {
      extract: () => ({ componentChain: { nearestId: null, components: [], truncated: false } }),
    });
    const bootstrap = listenAsBootstrap();
    request(document.querySelector("p")!, 5);
    bootstrap.stop();

    const reply = JSON.parse(bootstrap.log.at(-1)!.detail as string) as ExtractReply;
    expect(reply.contributions.map((entry) => entry.framework)).toEqual(["react"]);
  });

  it("names nothing when the reply itself has to be dropped for size", () => {
    document.body.innerHTML = "<p></p>";
    const p = document.querySelector("p")!;
    install("react", {
      extract: (_element, _phase, refs) => {
        refs.ref(p);
        return { frameworkEvidence: [{ blob: "x".repeat(MAX_BRIDGE_MESSAGE_CHARS) }] } as never;
      },
    });
    const bootstrap = listenAsBootstrap();
    request(p, 3);
    bootstrap.stop();

    expect(bootstrap.log.map((entry) => entry.type)).toEqual(["extracted"]);
    const reply = JSON.parse(bootstrap.log[0]!.detail as string) as ExtractReply;
    expect(reply).toEqual({ id: 3, contributions: [] });
  });

  it("names a pick's element from the reply's own table, on the contribution that picked it", () => {
    document.body.innerHTML = '<section id="list"><a id="hit"></a></section><p id="root"></p>';
    const hit = document.getElementById("hit")!;
    const list = document.getElementById("list")!;
    const root = document.getElementById("root")!;
    install("svelte", {
      extract: () => null,
      pick: (_hit, refs) => {
        refs.ref(root);
        return { target: list, data: {} };
      },
    });
    // No pick of its own: described where the pointer landed, and naming nothing more.
    install("react", { extract: () => ({}) });
    const bootstrap = listenAsBootstrap();
    request(hit, 4, true);
    bootstrap.stop();

    expect(bootstrap.log.map((entry) => [entry.type, entry.target])).toEqual([
      ["element", root],
      ["element", list],
      ["extracted", document],
    ]);
    const reply = JSON.parse(bootstrap.log.at(-1)!.detail as string) as ExtractReply;
    expect(reply.contributions).toEqual([
      { framework: "svelte", data: {}, target: "ref-1" },
      { framework: "react", data: {} },
    ]);
  });

  it("describes the hit when the element a pick stands for cannot be named", () => {
    document.body.innerHTML = '<a id="hit"></a><div id="closed-host"></div>';
    const hit = document.getElementById("hit")!;
    const closed = document.getElementById("closed-host")!.attachShadow({ mode: "closed" });
    const hidden = closed.appendChild(document.createElement("section"));
    const asked: Element[] = [];
    install("svelte", {
      extract: (element) => {
        asked.push(element);
        return { sourceCandidates: [] };
      },
      pick: () => ({ target: hidden, data: { frameworkEvidence: [] } }),
    });
    const bootstrap = listenAsBootstrap();
    request(hit, 8, true);
    bootstrap.stop();

    expect(asked).toEqual([hit]);
    expect(bootstrap.log.map((entry) => entry.type)).toEqual(["extracted"]);
    const reply = JSON.parse(bootstrap.log[0]!.detail as string) as ExtractReply;
    expect(reply.contributions).toEqual([{ framework: "svelte", data: { sourceCandidates: [] } }]);
  });

  it("says nothing for a pick it cannot name when describing the hit instead fails", () => {
    document.body.innerHTML = '<a id="hit"></a><div id="closed-host"></div>';
    const hit = document.getElementById("hit")!;
    const closed = document.getElementById("closed-host")!.attachShadow({ mode: "closed" });
    const hidden = closed.appendChild(document.createElement("section"));
    install("svelte", {
      extract: () => {
        throw new Error("the hit cannot be read");
      },
      pick: () => ({ target: hidden, data: { frameworkEvidence: [] } }),
    });
    const bootstrap = listenAsBootstrap();
    request(hit, 9, true);
    bootstrap.stop();

    const reply = JSON.parse(bootstrap.log.at(-1)!.detail as string) as ExtractReply;
    // A reader that threw has not looked, so it is not among those that found nothing either.
    expect(reply).toEqual({ id: 9, contributions: [], empty: [] });
  });

  it("names what a locate found by token, before its reply, and says when some could not be", () => {
    document.body.innerHTML = '<p id="a"></p><p id="b"></p>';
    const a = document.getElementById("a")!;
    const b = document.getElementById("b")!;
    const detached = document.createElement("p");
    install("svelte", {
      extract: () => null,
      locate: (_query, anchor) => ({
        elements: [anchor!, a, detached, b, a],
        data: { complete: true },
      }),
    });
    const bootstrap = listenAsBootstrap();
    locate(b, 6);
    bootstrap.stop();

    expect(bootstrap.log.map((entry) => [entry.type, entry.target])).toEqual([
      ["element", b],
      ["element", a],
      ["located", document],
    ]);
    expect(JSON.parse(bootstrap.log[1]!.detail as string)).toEqual({ id: 6, ref: 1 });
    expect(JSON.parse(bootstrap.log.at(-1)!.detail as string) as LocatedReply).toEqual({
      id: 6,
      elements: ["ref-0", "ref-1"],
      data: { complete: true },
      truncated: true,
    });
  });

  it("keeps a locate's names when only its data has to be dropped for size", () => {
    document.body.innerHTML = "<p></p>";
    const p = document.querySelector("p")!;
    install("svelte", {
      extract: () => null,
      locate: () => ({ elements: [p], data: { blob: "x".repeat(MAX_LOCATED_REPLY_CHARS) } }),
    });
    const bootstrap = listenAsBootstrap();
    locate(document, 2);
    bootstrap.stop();

    expect(bootstrap.log.map((entry) => [entry.type, entry.target])).toEqual([
      ["element", p],
      ["located", document],
    ]);
    expect(JSON.parse(bootstrap.log.at(-1)!.detail as string)).toEqual({
      id: 2,
      elements: ["ref-0"],
      data: null,
      truncated: false,
    });
  });

  it("fits a locate reply naming every element it may within the ceiling", () => {
    const nodes = Array.from({ length: MAX_ELEMENT_REFS + 1 }, () =>
      document.body.appendChild(document.createElement("i"))
    );
    install("svelte", { extract: () => null, locate: () => ({ elements: nodes }) });
    const bootstrap = listenAsBootstrap();
    locate(document, Number.MAX_SAFE_INTEGER);
    bootstrap.stop();

    const text = bootstrap.log.at(-1)!.detail as string;
    expect(text.length).toBeLessThanOrEqual(MAX_LOCATED_REPLY_CHARS);
    const reply = JSON.parse(text) as LocatedReply;
    expect(reply.elements).toHaveLength(MAX_ELEMENT_REFS);
    expect(reply.truncated).toBe(true);
    expect(bootstrap.log.filter((entry) => entry.type === "element")).toHaveLength(
      MAX_ELEMENT_REFS
    );
  });
});
