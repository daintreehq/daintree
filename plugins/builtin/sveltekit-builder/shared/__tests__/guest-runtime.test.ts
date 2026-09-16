// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createSiteBuilderGuest } from "../../guest/runtime.js";
import type { GuestMode, GuestRuntimeHandle } from "../../guest/types.js";
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
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  delete scope[BINDING];
});

describe("guest envelope", () => {
  it("opens with documentReady and numbers messages from zero within the document", () => {
    document.body.innerHTML = '<p id="a">hi</p>';
    setMeta(document.body.querySelector("#a")!, loc(4));
    install("select");
    click(document.body.querySelector("#a")!);

    expect(envelopes.map((envelope) => envelope.sequence)).toEqual([0, 1]);
    expect(envelopes[0].event.type).toBe("documentReady");
    expect(envelopes.every((envelope) => envelope.documentEpoch === 3)).toBe(true);
    expect(envelopes.every((envelope) => envelope.sessionId === "session-1")).toBe(true);
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

  it("selects the nearest mapped ancestor of an unmarked node", () => {
    document.body.innerHTML = '<div id="prose"><em id="raw">from {@html}</em></div>';
    setMeta(document.body.querySelector("#prose")!, loc(21));
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
  it("names a production build when nothing on the page carries dev metadata", () => {
    document.body.innerHTML = "<main><p>static</p></main>";
    install("browse");

    expect(events("runtimeIssue")).toEqual([expect.objectContaining({ code: "not-dev-build" })]);
  });

  it("distinguishes a dev server that simply has no Svelte metadata", () => {
    document.head.innerHTML = '<script src="/@vite/client" type="module"></script>';
    document.body.innerHTML = "<main><p>static</p></main>";
    install("browse");

    expect(events("runtimeIssue")).toEqual([expect.objectContaining({ code: "no-svelte-meta" })]);
  });

  it("stays quiet when the page is a Svelte dev build", () => {
    document.body.innerHTML = "<main><p>live</p></main>";
    setMeta(document.body.querySelector("p")!, loc(3));
    install("select");

    expect(events("runtimeIssue")).toEqual([]);
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
    document.body.innerHTML = "<main></main>";
    Object.defineProperty(document, "readyState", { value: "interactive", configurable: true });
    const runtime = install("browse");
    expect(events("runtimeIssue")).toEqual([]);

    Object.defineProperty(document, "readyState", { value: "complete", configurable: true });
    runtime.setMode("select");

    expect(events("runtimeIssue")).toEqual([expect.objectContaining({ code: "not-dev-build" })]);
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
    document.body.innerHTML = '<div id="prose"><em id="raw">raw</em></div>';
    const prose = document.body.querySelector("#prose")!;
    setMeta(prose, loc(21));
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
