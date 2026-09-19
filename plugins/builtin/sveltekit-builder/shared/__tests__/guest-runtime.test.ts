// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSiteBuilderGuest } from "../../renderer/guest/runtime.js";
import type { GuestMode, GuestRuntimeHandle } from "../../renderer/guest/types.js";
import {
  GUEST_PROTOCOL_VERSION,
  GuestEnvelopeSchema,
  type GuestEnvelope,
  type GuestNodeObservation,
} from "../protocol.js";

const BINDING = "__daintreeTestSend";
const HANDLE = "__daintreeTestHandle";

const scope = globalThis as unknown as Record<string, unknown>;
let handle: GuestRuntimeHandle | null = null;
let envelopes: GuestEnvelope[] = [];

function install(mode: GuestMode = "browse"): GuestRuntimeHandle {
  scope[BINDING] = (payload: string) => {
    envelopes.push(GuestEnvelopeSchema.parse(JSON.parse(payload)));
  };
  handle = createSiteBuilderGuest({
    protocolVersion: GUEST_PROTOCOL_VERSION,
    sessionId: "session-1",
    documentEpoch: 3,
    mode,
    bindingName: BINDING,
    handleName: HANDLE,
  });
  return handle;
}

function setMeta(node: Element, loc: unknown, parent?: unknown): void {
  (node as unknown as { __svelte_meta: unknown }).__svelte_meta = { loc, parent };
}

function loc(line: number, column = 2, file = "src/routes/+page.svelte") {
  return { file, line, column };
}

function events<T extends GuestEnvelope["event"]["type"]>(type: T) {
  return envelopes
    .filter((envelope) => envelope.event.type === type)
    .map((envelope) => envelope.event);
}

function lastSelection(): GuestNodeObservation[] {
  const selections = events("selectionChanged");
  const latest = selections[selections.length - 1];
  if (latest === undefined || latest.type !== "selectionChanged")
    throw new Error("no selectionChanged");
  return latest.nodes;
}

function click(node: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    composed: true,
    ...init,
  });
  node.dispatchEvent(event);
  return event;
}

afterEach(() => {
  handle?.dispose();
  handle = null;
  envelopes = [];
  // The runtime carries its sequence and occurrence counters across installs
  // on purpose; between tests that carry is order-dependence.
  delete scope[HANDLE + ".state"];
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  delete scope[BINDING];
});

describe("metadata capabilities", () => {
  const corpus = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../__fixtures__/svelte-meta"
  );
  function stampFrom(fixture: string): Element {
    const meta = JSON.parse(readFileSync(path.join(corpus, fixture), "utf8")) as {
      loc: unknown;
      parent?: unknown;
    };
    const node = document.createElement("section");
    document.body.appendChild(node);
    setMeta(node, meta.loc, meta.parent);
    return node;
  }
  function probed() {
    const found = events("metadataProbed");
    const latest = found[found.length - 1];
    return latest?.type === "metadataProbed" ? latest : null;
  }

  it("reports locations and ancestry for the pinned baseline's shape", () => {
    stampFrom("loc-and-parent.json");
    install("select");
    expect(probed()).toEqual({ type: "metadataProbed", locations: true, ancestry: true });
  });

  it("reports no ancestry for a runtime that stamps locations but keeps no dev stack", () => {
    stampFrom("loc-only.json");
    install("select");
    expect(probed()).toEqual({ type: "metadataProbed", locations: true, ancestry: false });
  });

  it("does not call a chain of block frames ancestry", () => {
    stampFrom("blocks-only.json");
    install("select");
    expect(probed()).toEqual({ type: "metadataProbed", locations: true, ancestry: false });
  });

  it("reports nothing readable for a shape it cannot follow", () => {
    stampFrom("malformed.json");
    install("select");
    expect(probed()).toEqual({ type: "metadataProbed", locations: false, ancestry: false });
  });

  it("answers for the page, not its first stamped element", () => {
    // The root has nothing above it; a deeper element carries the chain.
    stampFrom("loc-only.json");
    stampFrom("loc-and-parent.json");
    install("select");
    expect(probed()).toEqual({ type: "metadataProbed", locations: true, ancestry: true });
  });

  it("keeps the shape diagnosis rather than calling readable stamps absent", () => {
    vi.useFakeTimers();
    try {
      stampFrom("malformed.json");
      install("select");
      expect(probed()).toEqual({ type: "metadataProbed", locations: false, ancestry: false });
      vi.advanceTimersByTime(30_000);
      expect(events("runtimeIssue")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still answers for a page that hydrated after the missing-mapping verdict", () => {
    vi.useFakeTimers();
    try {
      install("select");
      vi.advanceTimersByTime(30_000);
      expect(events("runtimeIssue").map((event) => event.type)).toEqual(["runtimeIssue"]);
      expect(probed()).toBeNull();

      stampFrom("loc-and-parent.json");
      handle?.setMode("browse");
      handle?.setMode("select");
      expect(probed()).toEqual({ type: "metadataProbed", locations: true, ancestry: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("says nothing until a stamped element exists, then once", () => {
    install("select");
    expect(probed()).toBeNull();
    stampFrom("loc-and-parent.json");
    handle?.setMode("browse");
    handle?.setMode("select");
    handle?.setMode("browse");
    handle?.setMode("select");
    expect(events("metadataProbed")).toHaveLength(1);
  });
});

describe("guest envelope", () => {
  it("opens with documentReady and numbers messages from zero within the document", () => {
    document.body.innerHTML = '<p id="a">hi</p>';
    setMeta(document.body.querySelector("#a")!, loc(4));
    install("select");
    click(document.body.querySelector("#a")!);

    // Ready, then what the metadata supports, then the click.
    expect(envelopes.map((envelope) => envelope.sequence)).toEqual([0, 1, 2]);
    expect(envelopes.map((envelope) => envelope.event.type)).toEqual([
      "documentReady",
      "metadataProbed",
      "selectionChanged",
    ]);
    expect(envelopes.every((envelope) => envelope.documentEpoch === 3)).toBe(true);
    expect(envelopes.every((envelope) => envelope.sessionId === "session-1")).toBe(true);
  });

  it("reports the page again before a selection made after client-side navigation", () => {
    document.body.innerHTML = '<p id="a">hi</p>';
    setMeta(document.body.querySelector("#a")!, loc(4));
    install("select");
    click(document.body.querySelector("#a")!);
    expect(events("documentReady")).toHaveLength(1);

    // SvelteKit navigates with pushState: same document, no load event.
    const original = { url: location.href, state: history.state as unknown };
    try {
      history.replaceState({}, "", "/pricing");
      click(document.body.querySelector("#a")!);
      const ready = events("documentReady");
      expect(ready).toHaveLength(2);
      expect(ready[1]).toMatchObject({ url: expect.stringContaining("/pricing") });
      const types = envelopes.map((envelope) => envelope.event.type);
      expect(types.slice(-2)).toEqual(["documentReady", "selectionChanged"]);
    } finally {
      history.replaceState(original.state, "", original.url);
    }
  });
});

describe("modes", () => {
  it("intercepts nothing in browse mode", () => {
    document.body.innerHTML = '<a id="link" href="/next">go</a>';
    const link = document.body.querySelector("#link")!;
    setMeta(link, loc(9));
    let reachedPage = 0;
    document.addEventListener("click", () => (reachedPage += 1));
    install("browse");

    const event = click(link);

    expect(event.defaultPrevented).toBe(false);
    expect(reachedPage).toBe(1);
    expect(events("selectionChanged")).toHaveLength(0);
  });

  it("selects without activating in select mode", () => {
    document.body.innerHTML = '<a id="link" href="/next">go</a>';
    const link = document.body.querySelector("#link")!;
    setMeta(link, loc(9));
    let reachedPage = 0;
    document.addEventListener("click", () => (reachedPage += 1));
    install("select");

    const event = click(link);

    expect(event.defaultPrevented).toBe(true);
    expect(reachedPage).toBe(0);
    expect(lastSelection()[0].loc).toEqual(loc(9));
  });

  it("stops intercepting again when the host returns to browse", () => {
    document.body.innerHTML = '<a id="link" href="/next">go</a>';
    const link = document.body.querySelector("#link")!;
    setMeta(link, loc(9));
    const runtime = install("select");
    click(link);
    runtime.setMode("browse");

    expect(click(link).defaultPrevented).toBe(false);
    expect(runtime.getMode()).toBe("browse");
  });
});

describe("source metadata", () => {
  it("reports loc and the parent chain verbatim, innermost first", () => {
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
    install("select");

    click(button);
    const node = lastSelection()[0];

    expect(node.loc).toEqual(loc(7, 6, "src/lib/Card.svelte"));
    expect(node.ancestry).toEqual([
      { type: "each", file: "src/lib/Card.svelte", line: 3, column: 4 },
      {
        type: "component",
        file: "src/routes/+page.svelte",
        line: 12,
        column: 1,
        componentTag: "PricingCard",
      },
    ]);
  });

  it("drops malformed frames rather than the whole chain", () => {
    document.body.innerHTML = "<button>Buy</button>";
    const button = document.body.querySelector("button")!;
    const good = { type: "component", file: "src/routes/+page.svelte", line: 12, column: 0 };
    setMeta(button, loc(7), { type: "each", file: "", line: -1, column: null, parent: good });
    install("select");

    click(button);

    expect(lastSelection()[0].ancestry).toEqual([good]);
  });

  it("truncates an over-long chain and says so instead of being dropped by the host", () => {
    document.body.innerHTML = "<button>Buy</button>";
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
    install("select");

    click(document.body.querySelector("button")!);

    expect(lastSelection()[0].ancestry).toHaveLength(64);
    expect(events("runtimeIssue")).toContainEqual(
      expect.objectContaining({ code: "internal", detail: expect.stringContaining("truncated") })
    );
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
    install("select");

    click(document.body.querySelector("button")!);

    expect(lastSelection()[0].ancestry).toHaveLength(1);
  });

  it("counts every live element rendered by the same markup", () => {
    document.body.innerHTML = "<div></div><div></div><div></div><span></span>";
    for (const card of document.body.querySelectorAll("div")) setMeta(card, loc(14));
    setMeta(document.body.querySelector("span")!, loc(19));
    install("select");

    click(document.body.querySelector("div")!);
    expect(lastSelection()[0].sameLocCount).toBe(3);

    click(document.body.querySelector("span")!);
    expect(lastSelection()[0].sameLocCount).toBe(1);
  });

  it("reports an unmarked node that could be the template's own, for the host to place", () => {
    // Raw `{@html}` markup and a template element whose stamp hydration
    // dropped look the same here: unstamped, at the tail of a stamped parent.
    // The host walks the source and tells them apart; the page reports the
    // node itself with its shape rather than standing its ancestor in for it.
    document.body.innerHTML = '<div id="prose"><em id="raw">from {@html}</em></div>';
    setMeta(document.body.querySelector("#prose")!, loc(21));
    install("select");

    click(document.body.querySelector("#raw")!);
    const node = lastSelection()[0];

    expect(node.tagName).toBe("em");
    expect(node.loc).toBeNull();
    expect(node.unmapped).toBe(false);
    expect(node.structure).toEqual({
      file: "src/routes/+page.svelte",
      path: [
        { tag: "div", index: 0 },
        { tag: "em", index: 0 },
      ],
    });
  });

  it("selects the nearest mapped ancestor of an unmarked node the template cannot own", () => {
    // Unstamped, but followed by a stamped sibling of the same frame: the
    // hydration walk never leaves a template element ahead of a stamped one.
    document.body.innerHTML =
      '<div id="prose"><em id="raw">from {@html}</em><p id="after">p</p></div>';
    const page = { type: "component", file: "root.svelte", line: 1, column: 0 };
    setMeta(document.body.querySelector("#prose")!, loc(21), page);
    setMeta(document.body.querySelector("#after")!, loc(22), page);
    install("select");

    click(document.body.querySelector("#raw")!);
    const node = lastSelection()[0];

    expect(node.tagName).toBe("div");
    expect(node.loc).toEqual(loc(21));
    expect(node.unmapped).toBe(true);
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
    install("select");

    click(canvas);
    expect(lastSelection()[0].unmapped).toBe(true);

    click(inner);
    expect(lastSelection()[0]).toMatchObject({ unmapped: true, tagName: "div" });

    click(frame);
    expect(lastSelection()[0].unmapped).toBe(true);
  });

  it("reports a mapped element of the page as editable", () => {
    document.body.innerHTML = '<h1 id="title">Hello</h1>';
    setMeta(document.body.querySelector("#title")!, loc(2));
    install("select");

    click(document.body.querySelector("#title")!);

    expect(lastSelection()[0].unmapped).toBe(false);
  });
});

describe("selection interaction", () => {
  function threeCards(): Element[] {
    document.body.innerHTML = '<b id="one"></b><b id="two"></b><b id="three"></b>';
    const cards = Array.from(document.body.querySelectorAll("b"));
    cards.forEach((card, index) => setMeta(card, loc(40 + index)));
    return cards;
  }

  it("replaces the selection on a plain click and toggles it on Cmd/Ctrl-click", () => {
    const [one, two] = threeCards();
    install("select");

    click(one);
    click(two);
    expect(lastSelection().map((node) => node.label)).toEqual(["b#two"]);

    click(one, { metaKey: true });
    expect(lastSelection().map((node) => node.label)).toEqual(["b#two", "b#one"]);

    click(one, { ctrlKey: true });
    expect(lastSelection().map((node) => node.label)).toEqual(["b#two"]);
  });

  it("clears the selection on Escape and leaves Escape alone when there is nothing to clear", () => {
    const [one] = threeCards();
    install("select");
    click(one);

    const withSelection = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(withSelection);
    expect(withSelection.defaultPrevented).toBe(true);
    expect(lastSelection()).toEqual([]);

    const withoutSelection = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(withoutSelection);
    expect(withoutSelection.defaultPrevented).toBe(false);
  });

  it("caps multi-selection at the protocol maximum and says why", () => {
    document.body.innerHTML = Array.from(
      { length: 40 },
      (_, index) => `<i id="i${index}"></i>`
    ).join("");
    const nodes = Array.from(document.body.querySelectorAll("i"));
    nodes.forEach((node, index) => setMeta(node, loc(60 + index)));
    install("select");

    click(nodes[0]);
    for (const node of nodes.slice(1)) click(node, { metaKey: true });

    expect(lastSelection()).toHaveLength(32);
    expect(events("runtimeIssue")).toContainEqual(
      expect.objectContaining({ code: "internal", detail: expect.stringContaining("capped") })
    );
  });

  it("drops a node the framework replaced rather than reporting a dead one", () => {
    const [one] = threeCards();
    const runtime = install("select");
    click(one);

    one.remove();
    runtime.refresh();

    expect(lastSelection()).toEqual([]);
  });
});

describe("reselect", () => {
  it("selects the element compiled from a location and observes it, as a click would", () => {
    const runtime = install("select");
    const root = document.createElement("div");
    setMeta(root, loc(4));
    const target = document.createElement("button");
    setMeta(target, loc(6), { type: "component", file: "src/lib/Card.svelte", line: 1, column: 0 });
    root.appendChild(target);
    document.body.appendChild(root);
    const before = events("selectionChanged").length;

    expect(runtime.reselect(loc(6))).toBe(true);

    const observed = lastSelection();
    expect(events("selectionChanged")).toHaveLength(before + 1);
    expect(observed[0]?.loc).toEqual(loc(6));
    expect(observed[0]?.tagName).toBe("button");
  });

  it("changes nothing and says so when no element carries that location", () => {
    const runtime = install("select");
    const target = document.createElement("button");
    setMeta(target, loc(6));
    document.body.appendChild(target);
    const before = events("selectionChanged").length;

    expect(runtime.reselect(loc(99))).toBe(false);
    expect(events("selectionChanged")).toHaveLength(before);
  });

  it("does nothing in browse mode", () => {
    const runtime = install("browse");
    const target = document.createElement("button");
    setMeta(target, loc(6));
    document.body.appendChild(target);
    expect(runtime.reselect(loc(6))).toBe(false);
    expect(events("selectionChanged")).toHaveLength(0);
  });

  it("claims no occurrence for a copy past the scan bound", () => {
    const filler = Array.from({ length: 20_050 }, () => "<i></i>").join("");
    document.body.innerHTML = `<b id="first"></b>${filler}<b id="late"></b>`;
    const first = document.getElementById("first")!;
    const late = document.getElementById("late")!;
    setMeta(first, loc(40));
    setMeta(late, loc(40));
    install("select");

    click(first);
    expect(lastSelection()[0]?.locIndex).toBe(0);
    // One copy counted, and the count says it is only a floor.
    expect(lastSelection()[0]).toMatchObject({ sameLocCount: 1, sameLocCountPartial: true });
    click(late);
    expect(lastSelection()[0]?.locIndex).toBeUndefined();
  });

  it("fails rather than substituting the first occurrence when the one asked for is gone", () => {
    // Repeated markup shares file, tag and revision: the host could not tell a
    // stand-in from the real thing, so a missing occurrence is a failure.
    document.body.innerHTML = '<b id="a"></b><b id="b"></b><b id="c"></b>';
    const cards = Array.from(document.body.querySelectorAll("b"));
    cards.forEach((card) => setMeta(card, loc(40)));
    const runtime = install("select");
    expect(runtime.reselect(loc(40), 2)).toBe(true);
    expect(lastSelection()[0]?.locIndex).toBe(2);

    cards[2]!.remove();
    const before = events("selectionChanged").length;
    expect(runtime.reselect(loc(40), 2)).toBe(false);
    expect(events("selectionChanged")).toHaveLength(before);
  });

  it("names who moved the selection: the user, the host's reselect, or the document", () => {
    document.body.innerHTML = '<b id="one"></b><b id="two"></b>';
    const [one, two] = Array.from(document.body.querySelectorAll("b"));
    setMeta(one!, loc(40));
    setMeta(two!, loc(41));
    const runtime = install("select");
    const last = () => {
      const all = events("selectionChanged");
      return all[all.length - 1];
    };
    click(one!);
    expect(last()).toMatchObject({ cause: "user" });
    expect(runtime.reselect(loc(41))).toBe(true);
    expect(last()).toMatchObject({ cause: "reselect" });
    two!.remove();
    runtime.refresh();
    expect(last()).toMatchObject({ cause: "document", nodes: [] });
    click(one!);
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );
    expect(last()).toMatchObject({ cause: "user", nodes: [] });
  });
});

describe("hover", () => {
  it("reports each new target once and nothing while the pointer stays on it", () => {
    document.body.innerHTML = '<p id="one">a</p><p id="two">b</p>';
    const [one, two] = Array.from(document.body.querySelectorAll("p"));
    setMeta(one, loc(70));
    setMeta(two, loc(71));
    install("select");

    const move = (node: Element) =>
      node.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, composed: true }));
    move(one);
    move(one);
    move(two);

    const hovers = events("hoverChanged");
    expect(hovers).toHaveLength(2);
    expect(
      hovers.map((event) => (event.type === "hoverChanged" ? event.node?.label : null))
    ).toEqual(["p#one", "p#two"]);
  });

  it("does not follow the pointer in browse mode", () => {
    document.body.innerHTML = "<p>a</p>";
    setMeta(document.body.querySelector("p")!, loc(70));
    install("browse");

    document.body
      .querySelector("p")!
      .dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));

    expect(events("hoverChanged")).toHaveLength(0);
  });
});

describe("overlay", () => {
  function paintedOverlay(): HTMLElement {
    document.body.innerHTML = '<section id="hero">hi</section>';
    setMeta(document.body.querySelector("#hero")!, loc(80));
    const runtime = install("select");
    click(document.body.querySelector("#hero")!);
    runtime.refresh();
    return document.body.lastElementChild as HTMLElement;
  }

  it("keeps its own markup out of the page's reach", () => {
    const host = paintedOverlay();
    const root = handle!.getOverlayRoot();

    expect(root!.querySelectorAll("div").length).toBeGreaterThan(0);
    // The page gets no way in: the root is closed and nothing it would select
    // — a div, a class of ours, stray text — exists in its document.
    expect(host.shadowRoot).toBe(null);
    expect(document.querySelectorAll("div, .box, .selected").length).toBe(0);
    expect(document.body.textContent).toBe("hi");
  });

  it("takes no space in the page it is inspecting", () => {
    const host = paintedOverlay();
    const style = getComputedStyle(host);

    expect(style.position).toBe("fixed");
    expect([style.width, style.height]).toEqual(["0px", "0px"]);
    expect(document.body.querySelector("#hero")!.nextElementSibling).toBe(host);
  });

  it("goes away with the mode and with dispose", () => {
    const host = paintedOverlay();
    handle!.setMode("browse");
    expect(host.isConnected).toBe(false);

    handle!.setMode("select");
    handle!.refresh();
    const second = document.body.lastElementChild as HTMLElement;
    expect(handle!.getOverlayRoot()).not.toBe(null);

    handle!.dispose();
    expect(second.isConnected).toBe(false);
    expect(document.body.innerHTML).toBe('<section id="hero">hi</section>');
  });
});

describe("runtime issues", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("names a production build when nothing on the page carries dev metadata", () => {
    vi.useFakeTimers();
    document.body.innerHTML = "<main><p>static</p></main>";
    install("browse");
    expect(events("runtimeIssue")).toEqual([]);

    vi.advanceTimersByTime(2_500);
    expect(events("runtimeIssue")).toEqual([expect.objectContaining({ code: "not-dev-build" })]);
  });

  it("distinguishes a dev server that simply has no Svelte metadata", () => {
    vi.useFakeTimers();
    document.head.innerHTML = '<script src="/@vite/client" type="module"></script>';
    document.body.innerHTML = "<main><p>static</p></main>";
    install("browse");

    vi.advanceTimersByTime(12_500);
    expect(events("runtimeIssue")).toEqual([]);
    vi.advanceTimersByTime(5_000);
    expect(events("runtimeIssue")).toEqual([expect.objectContaining({ code: "no-svelte-meta" })]);
  });

  it("recognises SvelteKit's dev page, which has no vite client script tag", () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      '<main><p>static</p></main><script>import("/@fs/app/node_modules/@sveltejs/kit/src/runtime/client/entry.js")</script>';
    install("browse");

    vi.advanceTimersByTime(20_000);
    expect(events("runtimeIssue")).toEqual([expect.objectContaining({ code: "no-svelte-meta" })]);
  });

  it("says nothing about a page whose metadata arrives with hydration after load", () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      '<main><p>server rendered</p></main><script>import("/.svelte-kit/generated/client/app.js")</script>';
    install("select");
    vi.advanceTimersByTime(4_000);

    setMeta(document.body.querySelector("p")!, loc(3));
    vi.advanceTimersByTime(20_000);
    expect(events("runtimeIssue")).toEqual([]);
  });

  it("stays quiet when the page is a Svelte dev build", () => {
    vi.useFakeTimers();
    document.body.innerHTML = "<main><p>live</p></main>";
    setMeta(document.body.querySelector("p")!, loc(3));
    install("select");

    vi.advanceTimersByTime(20_000);
    expect(events("runtimeIssue")).toEqual([]);
  });

  it("cancels a pending verdict when it is disposed", () => {
    vi.useFakeTimers();
    document.body.innerHTML = "<main><p>static</p></main>";
    const runtime = install("browse");
    const armed = vi.getTimerCount();
    expect(armed).toBeGreaterThan(0);
    runtime.dispose();
    expect(vi.getTimerCount()).toBeLessThan(armed);

    vi.advanceTimersByTime(20_000);
    expect(events("runtimeIssue")).toEqual([]);
  });

  it("judges a page that finishes loading with nothing else happening", () => {
    vi.useFakeTimers();
    document.body.innerHTML = "<main><p>static</p></main>";
    Object.defineProperty(document, "readyState", { value: "interactive", configurable: true });
    try {
      install("browse");
      vi.advanceTimersByTime(20_000);
      expect(events("runtimeIssue")).toEqual([]);

      Object.defineProperty(document, "readyState", { value: "complete", configurable: true });
      window.dispatchEvent(new Event("load"));
      vi.advanceTimersByTime(2_500);
      expect(events("runtimeIssue")).toEqual([expect.objectContaining({ code: "not-dev-build" })]);
    } finally {
      Object.defineProperty(document, "readyState", { value: "complete", configurable: true });
    }
  });
});

describe("disposal", () => {
  it("leaves no listener, observer or global behind", () => {
    document.body.innerHTML = '<a id="link" href="/next">go</a>';
    setMeta(document.body.querySelector("#link")!, loc(9));
    const runtime = install("select");
    const before = envelopes.length;
    runtime.dispose();

    const link = document.body.querySelector("#link")!;
    expect(click(link).defaultPrevented).toBe(false);
    link.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));

    expect(envelopes).toHaveLength(before);
  });
});

describe("hardening the observation", () => {
  it("keeps quiet about a page that has not finished rendering", () => {
    vi.useFakeTimers();
    try {
      document.body.innerHTML = "<main></main>";
      Object.defineProperty(document, "readyState", { value: "interactive", configurable: true });
      const runtime = install("browse");
      vi.advanceTimersByTime(20_000);
      expect(events("runtimeIssue")).toEqual([]);

      Object.defineProperty(document, "readyState", { value: "complete", configurable: true });
      runtime.setMode("select");
      vi.advanceTimersByTime(2_500);

      expect(events("runtimeIssue")).toEqual([expect.objectContaining({ code: "not-dev-build" })]);
    } finally {
      vi.useRealTimers();
    }
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
      parent: { type: "each", file: "src/lib/Ok.svelte", line: 2 ** 53, column: 0 },
    });
    install("select");

    click(button);

    // Both frames are unreportable; neither is quietly reshaped into a
    // different file or a number the host's schema rejects.
    expect(lastSelection()[0].ancestry).toEqual([]);
  });

  it("re-reports a target when the pointer moves into its unmapped content", () => {
    document.body.innerHTML = '<div id="prose"><em id="raw">raw</em><p id="after">p</p></div>';
    const prose = document.body.querySelector("#prose")!;
    const page = { type: "component", file: "root.svelte", line: 1, column: 0 };
    setMeta(prose, loc(21), page);
    setMeta(document.body.querySelector("#after")!, loc(22), page);
    install("select");

    const move = (node: Element) =>
      node.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, composed: true }));
    move(prose);
    move(document.body.querySelector("#raw")!);

    const hovers = events("hoverChanged");
    expect(
      hovers.map((event) => (event.type === "hoverChanged" ? event.node?.unmapped : null))
    ).toEqual([false, true]);
  });

  it("treats an upgraded custom element as visual-only", () => {
    customElements.define("legacy-widget", class extends HTMLElement {});
    document.body.innerHTML = "<legacy-widget></legacy-widget>";
    const widget = document.body.querySelector("legacy-widget")!;
    setMeta(widget, loc(44));
    install("select");

    click(widget);

    expect(lastSelection()[0].unmapped).toBe(true);
  });

  it("leaves an Escape that belongs to the IME alone", () => {
    document.body.innerHTML = "<b></b>";
    setMeta(document.body.querySelector("b")!, loc(50));
    install("select");
    click(document.body.querySelector("b")!);

    const composing = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    document.dispatchEvent(composing);

    expect(composing.defaultPrevented).toBe(false);
    expect(lastSelection()).toHaveLength(1);
  });

  it("re-counts occurrences that changed while the runtime was in browse mode", () => {
    document.body.innerHTML = "<u></u><u></u>";
    for (const node of document.body.querySelectorAll("u")) setMeta(node, loc(60));
    const runtime = install("select");
    click(document.body.querySelector("u")!);
    expect(lastSelection()[0].sameLocCount).toBe(2);

    runtime.setMode("browse");
    document.body.querySelectorAll("u")[1].remove();
    runtime.setMode("select");
    click(document.body.querySelector("u")!);

    expect(lastSelection()[0].sameLocCount).toBe(1);
  });

  it("keeps host and guest on the same selection when an observation will not fit", () => {
    const frames = (file: string) => {
      let chain: Record<string, unknown> | undefined;
      for (let depth = 0; depth < 64; depth += 1) {
        chain = { type: "component", file, line: depth + 1, column: 0, parent: chain };
      }
      return chain;
    };
    document.body.innerHTML = "<s id='a'></s><s id='b'></s><s id='c'></s><s id='d'></s>";
    const nodes = Array.from(document.body.querySelectorAll("s"));
    nodes.forEach((node, index) =>
      setMeta(node, loc(70 + index), frames("src/" + "x".repeat(1000)))
    );
    install("select");

    click(nodes[0]);
    for (const node of nodes.slice(1)) click(node, { metaKey: true });

    expect(lastSelection()).toHaveLength(4);
    expect(lastSelection()[0].ancestry).toHaveLength(4);
    expect(events("runtimeIssue")).toContainEqual(
      expect.objectContaining({ code: "internal", detail: expect.stringContaining("shortened") })
    );
  });
});

describe("keyboard traversal and component selection", () => {
  function key(init: KeyboardEventInit): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    window.dispatchEvent(event);
    return event;
  }

  function lastScope(): string | undefined {
    const selections = events("selectionChanged");
    const latest = selections[selections.length - 1];
    return latest?.type === "selectionChanged" ? latest.scope : undefined;
  }

  // Two cards drawn by one line of the page: the same markup, two invocations.
  function renderCards() {
    document.body.innerHTML = `
      <main id="main">
        <article id="a"><h2 id="a-title">One</h2><p id="a-body">x</p></article>
        <article id="b"><h2 id="b-title">Two</h2></article>
      </main>`;
    const page = { type: "component", file: "src/routes/+page.svelte", line: 1, column: 0 };
    const cardA = {
      type: "component",
      file: "src/routes/+page.svelte",
      line: 6,
      column: 6,
      componentTag: "Card",
      parent: page,
    };
    const cardB = {
      type: "component",
      file: "src/routes/+page.svelte",
      line: 6,
      column: 6,
      componentTag: "Card",
      parent: page,
    };
    const $ = (id: string) => document.getElementById(id)!;
    setMeta($("main"), loc(1), page);
    setMeta($("a"), loc(5, 0, "src/lib/Card.svelte"), cardA);
    setMeta($("a-title"), loc(6, 2, "src/lib/Card.svelte"), cardA);
    setMeta($("a-body"), loc(7, 2, "src/lib/Card.svelte"), cardA);
    setMeta($("b"), loc(5, 0, "src/lib/Card.svelte"), cardB);
    setMeta($("b-title"), loc(6, 2, "src/lib/Card.svelte"), cardB);
    return $;
  }

  it("walks to the parent, first child and siblings with the arrow keys", () => {
    const $ = renderCards();
    install("select");
    click($("a-title"));

    expect(key({ key: "ArrowRight" }).defaultPrevented).toBe(true);
    expect(lastSelection()[0].loc).toEqual(loc(7, 2, "src/lib/Card.svelte"));
    key({ key: "ArrowUp" });
    expect(lastSelection()[0].loc).toEqual(loc(5, 0, "src/lib/Card.svelte"));
    key({ key: "ArrowDown" });
    expect(lastSelection()[0].loc).toEqual(loc(6, 2, "src/lib/Card.svelte"));
    expect(lastScope()).toBeUndefined();
  });

  it("keeps a widened component through a reselect, for the invocation that was edited", () => {
    renderCards();
    const runtime = install("select");
    const callSite = { file: "src/routes/+page.svelte", line: 6, column: 6 };
    expect(runtime.reselect(loc(5, 0, "src/lib/Card.svelte"), 1, callSite)).toBe(true);
    expect(lastScope()).toBe("component");
    expect(lastSelection().map((node) => node.runtimeOccurrenceId)).toHaveLength(1);
    expect(lastSelection()[0].locIndex).toBe(1);

    // A call site the element isn't inside is not a component to keep.
    runtime.reselect(loc(5, 0, "src/lib/Card.svelte"), 1, { ...callSite, line: 99 });
    expect(lastScope()).toBeUndefined();
  });

  it("widens to the invocation that drew the element, not every card from that line", () => {
    const $ = renderCards();
    install("select");
    click($("a-title"));

    key({ key: "ArrowUp", altKey: true });

    const nodes = lastSelection();
    expect(lastScope()).toBe("component");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].tagName.toLowerCase()).toBe("article");
    // The first card only: the second shares the line, not the invocation.
    expect(nodes[0].ancestry[0]).toMatchObject({ componentTag: "Card" });
  });

  it("names the outer component when a wrapper renders no element of its own", () => {
    document.body.innerHTML =
      '<main id="main"><article id="card"><h2 id="title">Hi</h2></article></main>';
    const page = { type: "component", file: "src/routes/+page.svelte", line: 1, column: 0 };
    const wrapper = {
      type: "component",
      file: "src/routes/+page.svelte",
      line: 4,
      column: 2,
      componentTag: "Wrapper",
      parent: page,
    };
    const child = {
      type: "component",
      file: "src/lib/Wrapper.svelte",
      line: 2,
      column: 2,
      componentTag: "Child",
      parent: wrapper,
    };
    const $ = (id: string) => document.getElementById(id)!;
    setMeta($("main"), loc(3), page);
    setMeta($("card"), loc(1, 0, "src/lib/Child.svelte"), child);
    setMeta($("title"), loc(2, 2, "src/lib/Child.svelte"), child);
    install("select");
    click($("title"));

    key({ key: "ArrowUp", altKey: true });
    let latest = events("selectionChanged").at(-1);
    expect(latest).toMatchObject({
      scope: "component",
      component: {
        file: "src/lib/Wrapper.svelte",
        line: 2,
        column: 2,
        name: "Child",
      },
    });

    // Same roots, but now the request is about Wrapper, not Child.
    key({ key: "ArrowUp", altKey: true });
    latest = events("selectionChanged").at(-1);
    expect(latest).toMatchObject({
      scope: "component",
      component: {
        file: "src/routes/+page.svelte",
        line: 4,
        column: 2,
        name: "Wrapper",
      },
    });
    expect(lastSelection()[0].tagName.toLowerCase()).toBe("article");
  });

  it("goes back to element scope on the next plain click", () => {
    const $ = renderCards();
    install("select");
    click($("a-title"));
    key({ key: "ArrowUp", altKey: true });
    click($("b-title"));
    expect(lastScope()).toBeUndefined();
  });

  it("leaves arrow keys to fields and widgets on the page, and to other modifiers", () => {
    const $ = renderCards();
    const input = document.createElement("input");
    document.body.appendChild(input);
    install("select");
    click($("a-title"));
    const before = events("selectionChanged").length;

    const inField = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    input.dispatchEvent(inField);
    expect(inField.defaultPrevented).toBe(false);
    expect(key({ key: "ArrowUp", shiftKey: true }).defaultPrevented).toBe(false);
    expect(key({ key: "ArrowDown", altKey: true }).defaultPrevented).toBe(false);
    expect(events("selectionChanged")).toHaveLength(before);
  });

  it("leaves arrow keys to the page when nothing is selected", () => {
    renderCards();
    install("select");
    expect(key({ key: "ArrowUp" }).defaultPrevented).toBe(false);
  });
});

describe("structural path", () => {
  it("reports where a node sits among its own frame's elements, not the DOM's", () => {
    // A hydrated page: the Header component's root precedes the template's
    // own elements, and Svelte's location walk counted it. The path counts
    // only siblings that share the frame, so `div.journal` is index 0 and the
    // toolbar inside it index 0, whatever the stamps say.
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
    setMeta(document.body.querySelector("#h")!, loc(7, 0), header);
    setMeta(document.body.querySelector("#journal")!, loc(18, 0), page);
    setMeta(document.body.querySelector("#toolbar")!, loc(19, 2), page);
    setMeta(document.body.querySelector("#end")!, loc(20, 0), page);
    install("select");
    click(document.body.querySelector("#toolbar")!);
    const [node] = lastSelection();
    expect(node?.structure).toEqual({
      file: "src/routes/+page.svelte",
      path: [
        { tag: "div", index: 0 },
        { tag: "div", index: 0 },
      ],
    });
    click(document.body.querySelector("#end")!);
    expect(lastSelection()[0]?.structure).toEqual({
      file: "src/routes/+page.svelte",
      path: [{ tag: "div", index: 1 }],
    });
  });

  it("places an unstamped element at the tail of a stamped run, and refuses one before a stamped sibling", () => {
    // The hydration walk drops stamps off the tail: `p` and `nav` inside the
    // toolbar carry nothing, and so does everything under them. They are the
    // template's own, counted after the stamped siblings; an unstamped element
    // before a stamped one is not.
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
    setMeta(document.body.querySelector("#journal")!, loc(366, 0), page);
    setMeta(document.body.querySelector("#toolbar")!, loc(367, 1), page);
    setMeta(document.body.querySelector("#late")!, loc(370, 0), page);
    setMeta(document.body.querySelector("#stamped")!, loc(372, 2), page);
    install("select");
    click(document.body.querySelector("#label")!);
    let [node] = lastSelection();
    expect(node?.loc).toBeNull();
    expect(node?.unmapped).toBe(false);
    expect(node?.label).toContain("p");
    expect(node?.ancestry[0]).toMatchObject({ type: "component", componentTag: "Page" });
    expect(node?.structure).toEqual({
      file: "src/routes/+page.svelte",
      path: [
        { tag: "div", index: 0 },
        { tag: "div", index: 0 },
        { tag: "p", index: 0 },
      ],
    });
    click(document.body.querySelector("#year")!);
    [node] = lastSelection();
    expect(node?.structure).toEqual({
      file: "src/routes/+page.svelte",
      path: [
        { tag: "div", index: 0 },
        { tag: "div", index: 0 },
        { tag: "nav", index: 1 },
        { tag: "div", index: 1 },
        { tag: "a", index: 0 },
      ],
    });
    // `i` sits before a stamped sibling under a stamped parent: not the
    // template's. The click falls back to the stamped ancestor, as before.
    click(document.body.querySelector("#raw")!);
    [node] = lastSelection();
    expect(node?.loc).toEqual(loc(370, 0));
  });

  it("does not claim a dropped root for the enclosing component's template", () => {
    // `div.journal-end` lost its whole stamp; its nearest stamped ancestor is
    // the shell's container. Beside it sits a `header` of a frame reached
    // from the shell's only through the page's component frame — so this
    // container holds another template's roots, and the unstamped div may
    // be one of them. The click stands the container in, as before.
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
    setMeta(document.body.querySelector("#shell")!, loc(53, 1, shellFile), shellFrame);
    setMeta(document.body.querySelector("#h")!, loc(3, 0, "src/lib/Header.svelte"), headerFrame);
    install("select");
    click(document.body.querySelector("#p")!);
    const [node] = lastSelection();
    expect(node?.label).toContain("div");
    expect(node?.loc).toEqual(loc(53, 1, shellFile));
    expect(node?.unmapped).toBe(true);
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
    setMeta(document.body.querySelector("#h")!, loc(9, 0, "src/lib/Widget.svelte"), widget);
    click(document.body.querySelector("#p")!);
    // The shell's container is itself a root of the shell's template.
    expect(lastSelection()[0]?.structure).toEqual({
      file: shellFile,
      path: [
        { tag: "div", index: 0 },
        { tag: "div", index: 0 },
        { tag: "p", index: 0 },
      ],
    });
  });

  it("refuses a node after a snippet rendered inline, whose walk may have stamped it", () => {
    // `{@render a()}` is not bracketed in server output, so b's template walk
    // stamped a's elements with b's locations and frame — and a2, past the
    // end of a's own list, kept them. From a2 the siblings before it reach b's
    // frame through a's render frame; that is the tell, and a2 is not placed.
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
    setMeta(document.body.querySelector("#h")!, loc(1, 0, "src/Header.svelte"), header);
    setMeta(document.body.querySelector("#a1")!, loc(2, 40, "src/X.svelte"), renderA);
    setMeta(document.body.querySelector("#a2")!, loc(3, 60, "src/X.svelte"), renderB);
    setMeta(document.body.querySelector("#b1")!, loc(3, 40, "src/X.svelte"), renderB);
    install("select");
    click(document.body.querySelector("#a2")!);
    expect(lastSelection()[0]?.structure).toBeUndefined();
    // b1, after a2, is refused for the same reason; a1 inside the snippet is fine.
    click(document.body.querySelector("#b1")!);
    expect(lastSelection()[0]?.structure).toBeUndefined();
    click(document.body.querySelector("#a1")!);
    expect(lastSelection()[0]?.structure).toEqual({
      file: "src/X.svelte",
      path: [{ tag: "section", index: 0 }],
    });
  });

  it("does not claim a block's dropped root for the enclosing template", () => {
    // `{#if}` content is bracketed in server output and skipped by the
    // template's walk; a section inside it that lost its own stamp is the
    // block's, whatever the enclosing div's frame says.
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
    setMeta(document.body.querySelector("#wrap")!, loc(2, 0), page);
    setMeta(document.body.querySelector("#c1")!, loc(1, 0, "src/C.svelte"), c1);
    setMeta(document.body.querySelector("#c2")!, loc(1, 0, "src/C.svelte"), c2);
    install("select");
    click(document.body.querySelector("#inside")!);
    expect(lastSelection()[0]?.loc).toEqual(loc(2, 0));
    // The template's own dropped tail, outside the region, is placed.
    click(document.body.querySelector("#outside")!);
    expect(lastSelection()[0]?.structure).toEqual({
      file: "src/routes/+page.svelte",
      path: [
        { tag: "div", index: 0 },
        { tag: "section", index: 0 },
      ],
    });
  });

  it("does not place raw markup that inherited a stamp inside a descendant component", () => {
    // Page's walk stamped RawWrapper's raw `div` with a Page location and
    // frame before RawWrapper re-stamped its own `aside`. The raw `p` under
    // it would read as Page's `div[0] > p[0]` — but its container's frame is
    // RawWrapper's, which is below Page's, not above: no template's roots
    // sit in a descendant's element.
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
    setMeta(document.body.querySelector("#aside")!, loc(1, 0, "src/RawWrapper.svelte"), wrapper);
    setMeta(document.body.querySelector("#raw")!, loc(3, 5), page);
    setMeta(document.body.querySelector("#own")!, loc(2, 13), page);
    install("select");
    click(document.body.querySelector("#rawp")!);
    expect(lastSelection()[0]?.structure).toBeUndefined();
  });

  it("refuses a node beside a snippet's own element rendered inline", () => {
    // The sibling's own frame is the render frame: the snippet's element was
    // rendered right here, and the outer walk went through it.
    document.body.innerHTML = '<i id="s">snippet</i><section id="a"></section><div id="d"></div>';
    const page = {
      type: "component",
      file: "root.svelte",
      line: 1,
      column: 0,
      componentTag: "Page",
    };
    const renderA = { type: "render", file: "src/X.svelte", line: 3, column: 0, parent: page };
    setMeta(document.body.querySelector("#s")!, loc(2, 14, "src/X.svelte"), renderA);
    setMeta(document.body.querySelector("#a")!, loc(3, 30, "src/X.svelte"), page);
    setMeta(document.body.querySelector("#d")!, loc(3, 30, "src/X.svelte"), page);
    install("select");
    click(document.body.querySelector("#a")!);
    expect(lastSelection()[0]?.structure).toBeUndefined();
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
    setMeta(document.body.querySelector("#outer")!, loc(2, 0), page);
    setMeta(document.body.querySelector("#root")!, loc(9, 0, "src/lib/Card.svelte"), card);
    setMeta(document.body.querySelector("#leaf")!, loc(10, 2, "src/lib/Card.svelte"), card);
    install("select");
    click(document.body.querySelector("#leaf")!);
    expect(lastSelection()[0]?.structure).toEqual({
      file: "src/lib/Card.svelte",
      path: [
        { tag: "article", index: 0 },
        { tag: "b", index: 0 },
      ],
    });
  });
});

describe("reselect by occurrence", () => {
  it("asks for the element the host was told about, not whichever node carries its location", () => {
    // A hydrated page: the toolbar's true location is stamped on the header's
    // child. Asked by location alone the page would light up that neighbour;
    // asked by the id it reported, it lights up the toolbar.
    document.body.innerHTML = [
      '<header><h1 id="stray">Site</h1></header>',
      '<div id="journal"><div id="toolbar"><p>September</p></div></div>',
    ].join("");
    const page = {
      type: "component",
      file: "root.svelte",
      line: 1,
      column: 0,
      componentTag: "Page",
    };
    setMeta(document.body.querySelector("#stray")!, loc(296, 1), page);
    setMeta(document.body.querySelector("#journal")!, loc(366, 0), page);
    setMeta(document.body.querySelector("#toolbar")!, loc(367, 1), page);
    const runtime = install("select");
    click(document.body.querySelector("#toolbar")!);
    const [node] = lastSelection();
    expect(node?.loc).toEqual(loc(367, 1));
    // Something else is selected in between, so the answer has to be a fresh
    // selection of the toolbar, not the one already standing.
    click(document.body.querySelector("#journal")!);
    expect(lastSelection()[0]?.loc).toEqual(loc(366, 0));
    const before = events("selectionChanged").length;

    expect(runtime.reselect(loc(296, 1), 0, null, node!.runtimeOccurrenceId)).toBe(true);
    expect(events("selectionChanged")).toHaveLength(before + 1);
    expect(lastSelection()[0]?.runtimeOccurrenceId).toBe(node!.runtimeOccurrenceId);
    expect(lastSelection()[0]?.loc).toEqual(loc(367, 1));

    // Without the id, the location is all there is, and it names the neighbour.
    expect(runtime.reselect(loc(296, 1), 0, null)).toBe(true);
    expect(lastSelection()[0]?.label).toContain("h1");

    // A node no longer in the document is not the same element.
    document.body.querySelector("#toolbar")!.remove();
    expect(runtime.reselect(loc(367, 1), 0, null, node!.runtimeOccurrenceId)).toBe(false);
    // The ask then falls back to the location, which here names the neighbour.
    expect(runtime.reselect(loc(296, 1), 0, null, node!.runtimeOccurrenceId)).toBe(true);
    expect(lastSelection()[0]?.label).toContain("h1");
  });
});
