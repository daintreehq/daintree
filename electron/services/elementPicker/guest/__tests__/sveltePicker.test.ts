// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUDIT_DEV_SETTLE_MS, AUDIT_SETTLE_MS } from "../svelte/audit.js";
import {
  click,
  componentNames,
  evidenceOf,
  key,
  lastSelection,
  lastSelectionEvent,
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
  vi.useRealTimers();
});

const page = { type: "component", file: "src/routes/+page.svelte", line: 1, column: 0 };

/** Two cards drawn by one line of the page: the same markup, two invocations. */
function renderCards() {
  document.body.innerHTML = `
    <main id="main">
      <article id="a"><h2 id="a-title">One</h2><p id="a-body">x</p></article>
      <article id="b"><h2 id="b-title">Two</h2></article>
    </main>`;
  const card = () => ({
    type: "component",
    file: "src/routes/+page.svelte",
    line: 6,
    column: 6,
    componentTag: "Card",
    parent: page,
  });
  const cardA = card();
  const cardB = card();
  const $ = (id: string) => document.getElementById(id)!;
  setMeta($("main"), loc(1), page);
  setMeta($("a"), loc(5, 0, "src/lib/Card.svelte"), cardA);
  setMeta($("a-title"), loc(6, 2, "src/lib/Card.svelte"), cardA);
  setMeta($("a-body"), loc(7, 2, "src/lib/Card.svelte"), cardA);
  setMeta($("b"), loc(5, 0, "src/lib/Card.svelte"), cardB);
  setMeta($("b-title"), loc(6, 2, "src/lib/Card.svelte"), cardB);
  return $;
}

const callSite = { file: "src/routes/+page.svelte", line: 6, column: 6 };
const cardRoot = loc(5, 0, "src/lib/Card.svelte");

describe("component selection", () => {
  it("walks to the parent, first child and siblings with the arrow keys, element by element", () => {
    const $ = renderCards();
    const { events } = start();
    click($("a-title"));

    expect(key({ key: "ArrowRight" }).defaultPrevented).toBe(true);
    expect(locOf(lastSelection(events)[0])).toEqual(loc(7, 2, "src/lib/Card.svelte"));
    key({ key: "ArrowUp" });
    expect(locOf(lastSelection(events)[0])).toEqual(cardRoot);
    key({ key: "ArrowDown" });
    expect(locOf(lastSelection(events)[0])).toEqual(loc(6, 2, "src/lib/Card.svelte"));
    expect(lastSelectionEvent(events).scope).toEqual({ kind: "element" });
  });

  it("widens to the invocation that drew the element, not every card from that line", () => {
    const $ = renderCards();
    const { events } = start();
    click($("a-title"));

    expect(key({ key: "ArrowUp", altKey: true }).defaultPrevented).toBe(true);

    const event = lastSelectionEvent(events);
    expect(event.observations).toHaveLength(1);
    const [root] = event.observations;
    expect(root?.tagName).toBe("article");
    expect(locOf(root)).toEqual(cardRoot);
    const card = root!.componentChain.components.find((record) => record.name?.value === "Card");
    expect(event.scope).toEqual({ kind: "component", componentId: card?.componentId });
    expect(card).toMatchObject({ rootElementIds: [root?.elementId], rootsComplete: true });
  });

  it("names the outer component when a wrapper renders no element of its own", () => {
    document.body.innerHTML =
      '<main id="main"><article id="card"><h2 id="title">Hi</h2></article></main>';
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
    const { events } = start();
    click($("title"));

    const scoped = () => {
      const event = lastSelectionEvent(events);
      if (event.scope.kind !== "component") return null;
      const { componentId } = event.scope;
      return event.observations[0]!.componentChain.components.find(
        (record) => record.componentId === componentId
      );
    };

    key({ key: "ArrowUp", altKey: true });
    expect(scoped()).toMatchObject({
      name: { value: "Child" },
      sourceCandidates: [{ file: "src/lib/Wrapper.svelte", location: { line: 2, column: 2 } }],
    });

    // Same roots, but now the selection is of Wrapper, not Child.
    key({ key: "ArrowUp", altKey: true });
    expect(scoped()).toMatchObject({
      name: { value: "Wrapper" },
      sourceCandidates: [{ file: "src/routes/+page.svelte", location: { line: 4, column: 2 } }],
    });
    expect(lastSelection(events)[0]?.tagName).toBe("article");
  });

  it("goes back to element scope on the next plain click", () => {
    const $ = renderCards();
    const { events } = start();
    click($("a-title"));
    key({ key: "ArrowUp", altKey: true });
    click($("b-title"));
    expect(lastSelectionEvent(events).scope).toEqual({ kind: "element" });
  });

  it("leaves arrow keys to fields on the page, and to other modifiers", () => {
    const $ = renderCards();
    const input = document.createElement("input");
    document.body.appendChild(input);
    const { events } = start();
    click($("a-title"));
    const before = ofType(events, "selectionChanged").length;

    const inField = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      altKey: true,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    input.dispatchEvent(inField);
    expect(inField.defaultPrevented).toBe(false);
    expect(key({ key: "ArrowUp", shiftKey: true }).defaultPrevented).toBe(false);
    expect(key({ key: "ArrowDown", altKey: true }).defaultPrevented).toBe(false);
    expect(ofType(events, "selectionChanged")).toHaveLength(before);
  });

  it("labels a hovered element with the component its framework names", () => {
    const $ = renderCards();
    const { picker } = start();
    $("a-title").dispatchEvent(new MouseEvent("pointermove", { bubbles: true, composed: true }));
    runFrames();

    expect(picker.getOverlayRoot()?.textContent).toContain("Card h2#a-title");
  });
});

describe("reselect", () => {
  it("selects the element compiled from a location and describes it, as a click would", () => {
    const { picker, events } = start();
    const root = document.createElement("div");
    setMeta(root, loc(4));
    const target = document.createElement("button");
    setMeta(target, loc(6), { type: "component", file: "src/lib/Card.svelte", line: 1, column: 0 });
    root.appendChild(target);
    document.body.appendChild(root);

    expect(picker.reselect({ framework: "svelte", locator: { loc: loc(6), index: 0 } })).toBe(true);

    const event = lastSelectionEvent(events);
    expect(event.cause).toBe("reselect");
    expect(locOf(event.observations[0])).toEqual(loc(6));
    expect(event.observations[0]?.tagName).toBe("button");
  });

  it("changes nothing and says so when no element carries that location", () => {
    document.body.innerHTML = '<button id="one"></button><button id="two"></button>';
    setMeta(document.getElementById("one")!, loc(6));
    setMeta(document.getElementById("two")!, loc(7));
    const { picker, events } = start();
    click(document.getElementById("one")!);
    const before = ofType(events, "selectionChanged").length;

    expect(picker.reselect({ framework: "svelte", locator: { loc: loc(99), index: 0 } })).toBe(
      false
    );
    expect(ofType(events, "selectionChanged")).toHaveLength(before);
    // Still the click's selection, so the next walk starts from it.
    key({ key: "ArrowRight" });
    expect(locOf(lastSelection(events)[0])).toEqual(loc(7));
  });

  it("does nothing in browse mode", () => {
    const { picker, events } = start("browse");
    const target = document.createElement("button");
    setMeta(target, loc(6));
    document.body.appendChild(target);

    expect(picker.reselect({ framework: "svelte", locator: { loc: loc(6), index: 0 } })).toBe(
      false
    );
    expect(ofType(events, "selectionChanged")).toHaveLength(0);
  });

  it("fails rather than substituting the first occurrence when the one asked for is gone", () => {
    document.body.innerHTML = '<b id="a"></b><b id="b"></b><b id="c"></b>';
    const cards = Array.from(document.body.querySelectorAll("b"));
    cards.forEach((card) => setMeta(card, loc(40)));
    const { picker, events } = start();
    const ask = { framework: "svelte", locator: { loc: loc(40), index: 2 } };

    expect(picker.reselect(ask)).toBe(true);
    expect(evidenceOf(lastSelection(events)[0]).locIndex).toBe(2);

    cards[2]!.remove();
    const before = ofType(events, "selectionChanged").length;
    expect(picker.reselect(ask)).toBe(false);
    // An occurrence the host does not know cannot be stood in for by the first.
    expect(picker.reselect({ framework: "svelte", locator: { loc: loc(40) } })).toBe(false);
    expect(ofType(events, "selectionChanged")).toHaveLength(before);
  });

  it("names who moved the selection: the user, the host's reselect, or the document", () => {
    document.body.innerHTML = '<b id="one"></b><b id="two"></b>';
    const [one, two] = Array.from(document.body.querySelectorAll("b"));
    setMeta(one!, loc(40));
    setMeta(two!, loc(41));
    const { picker, events } = start();

    click(one!);
    expect(lastSelectionEvent(events).cause).toBe("user");
    expect(picker.reselect({ framework: "svelte", locator: { loc: loc(41), index: 0 } })).toBe(
      true
    );
    expect(lastSelectionEvent(events).cause).toBe("reselect");
    two!.remove();
    runFrames();
    expect(lastSelectionEvent(events)).toMatchObject({ cause: "document", observations: [] });
  });

  it("counts a root whose own location does not read among the invocation's roots", () => {
    document.body.innerHTML = '<main id="main"><h2 id="title">T</h2><p id="body">B</p></main>';
    const card = { ...page, line: 6, column: 6, componentTag: "Card", parent: page };
    setMeta(document.getElementById("main")!, loc(1), page);
    setMeta(document.getElementById("title")!, loc(2, 0, "src/lib/Card.svelte"), card);
    setMeta(document.getElementById("body")!, { file: "", line: 0, column: 0 }, card);
    const { events } = start();
    click(document.getElementById("title")!);

    key({ key: "ArrowUp", altKey: true });

    expect(lastSelection(events).map((observation) => observation.tagName)).toEqual(["h2", "p"]);
  });

  it("keeps a widened component through a reselect, for the invocation that was edited", () => {
    renderCards();
    const { picker, events } = start();

    expect(
      picker.reselect({
        framework: "svelte",
        locator: { loc: cardRoot, index: 1, component: callSite },
      })
    ).toBe(true);
    const event = lastSelectionEvent(events);
    expect(event.scope.kind).toBe("component");
    expect(event.observations).toHaveLength(1);
    expect(evidenceOf(event.observations[0]).locIndex).toBe(1);

    // A call site the element isn't inside is not a component to keep.
    picker.reselect({
      framework: "svelte",
      locator: { loc: cardRoot, index: 1, component: { ...callSite, line: 99 } },
    });
    expect(lastSelectionEvent(events).scope).toEqual({ kind: "element" });
  });

  it("brings the selection into view only when the host asks to show it", () => {
    renderCards();
    const { picker } = start();
    const reveal = vi.fn();
    Element.prototype.scrollIntoView = reveal;
    try {
      const ask = {
        framework: "svelte",
        locator: { loc: cardRoot, index: 1, component: callSite },
      };
      expect(picker.reselect({ ...ask, reveal: true })).toBe(true);
      expect(reveal).toHaveBeenCalledTimes(1);
      // The same component again, as after a hot update: the page stays put.
      expect(picker.reselect(ask)).toBe(true);
      expect(reveal).toHaveBeenCalledTimes(1);
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("asks for the element the host was told about, not whichever node carries its location", () => {
    // A hydrated page: the toolbar's true location is stamped on the header's
    // child. By location alone the neighbour lights up; by the id the host was
    // told, the toolbar does.
    document.body.innerHTML = [
      '<header><h1 id="stray">Site</h1></header>',
      '<div id="journal"><div id="toolbar"><p>September</p></div></div>',
    ].join("");
    const root = {
      type: "component",
      file: "root.svelte",
      line: 1,
      column: 0,
      componentTag: "Page",
    };
    setMeta(document.getElementById("stray")!, loc(296, 1), root);
    setMeta(document.getElementById("journal")!, loc(366, 0), root);
    setMeta(document.getElementById("toolbar")!, loc(367, 1), root);
    const { picker, events } = start();
    click(document.getElementById("toolbar")!);
    const toolbarId = lastSelection(events)[0]!.elementId;
    click(document.getElementById("journal")!);
    const stale = { framework: "svelte", locator: { loc: loc(296, 1), index: 0 } };

    expect(picker.reselect({ ...stale, elementId: toolbarId })).toBe(true);
    expect(lastSelection(events)[0]?.elementId).toBe(toolbarId);
    expect(locOf(lastSelection(events)[0])).toEqual(loc(367, 1));

    // Without the id, the location is all there is, and it names the neighbour.
    expect(picker.reselect(stale)).toBe(true);
    expect(lastSelection(events)[0]?.label).toBe("h1#stray");

    // A node no longer in the document is not the same element: the ask falls
    // back to its location.
    document.getElementById("toolbar")!.remove();
    expect(
      picker.reselect({
        framework: "svelte",
        locator: { loc: loc(367, 1), index: 0 },
        elementId: toolbarId,
      })
    ).toBe(false);
    expect(picker.reselect({ ...stale, elementId: toolbarId })).toBe(true);
    expect(lastSelection(events)[0]?.label).toBe("h1#stray");
  });
});

describe("notices about the page's metadata", () => {
  it("names a production build when nothing on a Svelte page carries dev metadata", () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<main class="svelte-1abcde"><p>static</p></main>';
    const { events } = start("browse");
    expect(ofType(events, "runtimeIssue")).toEqual([]);

    vi.advanceTimersByTime(AUDIT_SETTLE_MS);
    expect(ofType(events, "runtimeIssue")).toEqual([
      expect.objectContaining({ code: "not-dev-build", framework: "svelte" }),
    ]);
    // Said once per document.
    vi.advanceTimersByTime(AUDIT_DEV_SETTLE_MS * 2);
    expect(ofType(events, "runtimeIssue")).toHaveLength(1);
  });

  it("says nothing at all without the extractor, which only a Svelte page gets", () => {
    vi.useFakeTimers();
    document.body.innerHTML = "<main><p>static</p></main>";
    const { events } = start("browse", { svelte: false });
    vi.advanceTimersByTime(AUDIT_DEV_SETTLE_MS * 2);
    expect(ofType(events, "runtimeIssue")).toEqual([]);
  });

  it("does not call a page on a dev server a production build", () => {
    vi.useFakeTimers();
    document.head.innerHTML = '<script src="/@vite/client" type="module"></script>';
    document.body.innerHTML = "<main><p>static</p></main>";
    const { events } = start("browse");

    vi.advanceTimersByTime(AUDIT_DEV_SETTLE_MS - AUDIT_SETTLE_MS);
    expect(ofType(events, "runtimeIssue")).toEqual([]);
    vi.advanceTimersByTime(AUDIT_SETTLE_MS * 2);
    expect(ofType(events, "runtimeIssue")).toEqual([
      expect.objectContaining({ code: "metadata-unavailable", framework: "svelte" }),
    ]);
  });

  it("recognises SvelteKit's dev page, which has no vite client script tag", () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      '<main><p>static</p></main><script>import("/@fs/app/node_modules/@sveltejs/kit/src/runtime/client/entry.js")</script>';
    const { events } = start("browse");

    vi.advanceTimersByTime(AUDIT_DEV_SETTLE_MS + AUDIT_SETTLE_MS * 2);
    expect(ofType(events, "runtimeIssue")).toEqual([
      expect.objectContaining({ code: "metadata-unavailable" }),
    ]);
  });

  it("says nothing about a page whose metadata arrives with hydration after load", () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      '<main><p>server rendered</p></main><script>import("/.svelte-kit/generated/client/app.js")</script>';
    const { events } = start("select");
    vi.advanceTimersByTime(AUDIT_SETTLE_MS + 1_500);

    setMeta(document.body.querySelector("p")!, loc(3));
    vi.advanceTimersByTime(AUDIT_DEV_SETTLE_MS * 2);
    expect(ofType(events, "runtimeIssue")).toEqual([]);
  });

  it("stays quiet when the page is a Svelte dev build", () => {
    vi.useFakeTimers();
    document.body.innerHTML = "<main><p>live</p></main>";
    setMeta(document.body.querySelector("p")!, loc(3));
    const { events } = start("select");

    vi.advanceTimersByTime(AUDIT_DEV_SETTLE_MS * 2);
    expect(ofType(events, "runtimeIssue")).toEqual([]);
  });

  it("leaves stamps it cannot read to the capabilities rather than call them absent", () => {
    vi.useFakeTimers();
    document.body.innerHTML = "<main><p>live</p></main>";
    setMeta(document.body.querySelector("p")!, { file: "", line: "5", column: null });
    const { events } = start("select");

    vi.advanceTimersByTime(AUDIT_DEV_SETTLE_MS * 2);
    expect(ofType(events, "runtimeIssue")).toEqual([]);
  });

  it("remembers a stamp it saw even when hydration replaced its node before the verdict", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = "<main><p>live</p></main>";
    const paragraph = document.body.querySelector("p")!;
    setMeta(paragraph, { file: "", line: "5", column: null });
    const { events } = start("browse");

    paragraph.remove();
    await Promise.resolve();
    vi.advanceTimersByTime(AUDIT_DEV_SETTLE_MS * 2);

    expect(ofType(events, "runtimeIssue")).toEqual([]);
  });

  it("cancels a pending verdict when the picker goes", () => {
    vi.useFakeTimers();
    document.body.innerHTML = "<main><p>static</p></main>";
    const { picker, events } = start("browse");
    const armed = vi.getTimerCount();
    expect(armed).toBeGreaterThan(0);
    picker.dispose();
    expect(vi.getTimerCount()).toBeLessThan(armed);

    vi.advanceTimersByTime(AUDIT_DEV_SETTLE_MS * 2);
    expect(ofType(events, "runtimeIssue")).toEqual([]);
  });

  it("judges a page that finishes loading after the extractor arrived", () => {
    vi.useFakeTimers();
    document.body.innerHTML = "<main><p>static</p></main>";
    Object.defineProperty(document, "readyState", { value: "interactive", configurable: true });
    try {
      const { events } = start("browse");
      vi.advanceTimersByTime(AUDIT_DEV_SETTLE_MS * 2);
      expect(ofType(events, "runtimeIssue")).toEqual([]);

      Object.defineProperty(document, "readyState", { value: "complete", configurable: true });
      window.dispatchEvent(new Event("load"));
      vi.advanceTimersByTime(AUDIT_SETTLE_MS);
      expect(ofType(events, "runtimeIssue")).toEqual([
        expect.objectContaining({ code: "not-dev-build" }),
      ]);
    } finally {
      Object.defineProperty(document, "readyState", { value: "complete", configurable: true });
    }
  });

  it("stops sweeping the document once it has its verdict", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = "<main><p>plain</p></main>";
    const { events } = start("select");
    vi.advanceTimersByTime(AUDIT_SETTLE_MS);
    expect(ofType(events, "runtimeIssue")).toHaveLength(1);

    const sweeps = vi.spyOn(document, "getElementsByTagName");
    document.body.appendChild(document.createElement("section"));
    await Promise.resolve();
    expect(sweeps).not.toHaveBeenCalled();
  });
});

describe("fitting a selection into one envelope", () => {
  it("shortens the ancestry of a wide component selection rather than lose it", () => {
    const longFile = "src/" + "x".repeat(1000) + ".svelte";
    let chain: Record<string, unknown> = page;
    for (let depth = 0; depth < 64; depth += 1) {
      chain = {
        type: "component",
        file: longFile,
        line: depth + 1,
        column: 0,
        componentTag: "Layer" + depth,
        parent: chain,
      };
    }
    const list = document.createElement("ul");
    document.body.appendChild(list);
    for (let index = 0; index < 32; index += 1) {
      const item = document.createElement("li");
      setMeta(item, loc(70, index), chain);
      list.appendChild(item);
    }
    const { events } = start();

    click(list.firstElementChild!);
    key({ key: "ArrowUp", altKey: true });

    const event = lastSelectionEvent(events);
    expect(event.scope.kind).toBe("component");
    expect(event.observations).toHaveLength(32);
    expect(evidenceOf(event.observations[0]).ancestry.length).toBeLessThanOrEqual(4);
    expect(componentNames(event.observations[0])).toContain("Layer63");
    expect(ofType(events, "runtimeIssue").map((issue) => issue.code)).toContain("capacity");
  });
});
