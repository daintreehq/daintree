// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ElementPickerEventSchema,
  type ElementPickerEvent,
} from "../../../../../shared/elementPicker/protocol.js";
import {
  OBSERVATION_LIMITS,
  type Capabilities,
  type Capability,
} from "../../../../../shared/elementPicker/observation.js";
import { EXTRACTOR_REGISTRY_GLOBAL, channelEvent } from "../../guestChannel.js";
import { createPicker, type PickerHandle } from "../picker.js";
import { installExtractor } from "../registry.js";
import type { PickerAvailability, PickerMode } from "../types.js";

const CHANNEL = "test-channel";

let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let events: ElementPickerEvent[] = [];
/** Removes the listeners a test adds to the document, which outlives the test. */
let testListeners = new AbortController();
let picker: PickerHandle | null = null;

function start(mode: PickerMode = "select"): PickerHandle {
  picker = createPicker({
    channel: CHANNEL,
    mode,
    post: (event) => {
      // Everything the bootstrap says has to survive the host's own schema.
      const parsed = ElementPickerEventSchema.safeParse(event);
      if (!parsed.success) throw new Error(`host would reject ${event.type}: ${parsed.error}`);
      events.push(event);
    },
  });
  return picker;
}

function runFrames(): void {
  const pending = [...frames.values()];
  frames = new Map();
  for (const callback of pending) callback(0);
}

function ofType<T extends ElementPickerEvent["type"]>(type: T) {
  return events.filter((event): event is Extract<ElementPickerEvent, { type: T }> => {
    return event.type === type;
  });
}

function pointAt(target: Element): void {
  target.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, composed: true }));
}

function press(
  key: string,
  init: KeyboardEventInit = {},
  target: EventTarget = window
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function selectedTag(): string | undefined {
  return ofType("selectionChanged").at(-1)?.observations[0]?.tagName;
}

function selectedLabel(): string | undefined {
  return ofType("selectionChanged").at(-1)?.observations[0]?.label;
}

function selectedCapabilities(): Capabilities | undefined {
  return ofType("selectionChanged").at(-1)?.observations[0]?.capabilities;
}

function every(capability: Capability): Capabilities {
  return {
    names: capability,
    chain: capability,
    componentSelection: capability,
    file: capability,
    line: capability,
    exactRange: capability,
  };
}

const SETTLED: PickerAvailability = { detection: "settled", extractors: {} };

/** Stands in for the main-world registry: every request gets `reply(id)`'s answer. */
function answerWith(reply: (id: number) => unknown): void {
  document.addEventListener(
    channelEvent(CHANNEL, "extract"),
    (event) => {
      const { id } = JSON.parse((event as CustomEvent<string>).detail) as { id: number };
      document.dispatchEvent(
        new CustomEvent(channelEvent(CHANNEL, "extracted"), { detail: JSON.stringify(reply(id)) })
      );
    },
    { capture: true, signal: testListeners.signal }
  );
}

/** Installed readers for `frameworks` that looked and found nothing. */
function answerEmpty(...frameworks: string[]): void {
  answerWith((id) => ({ id, contributions: [], empty: frameworks }));
}

beforeEach(() => {
  frames = new Map();
  events = [];
  testListeners = new AbortController();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    nextFrame += 1;
    frames.set(nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
  document.body.innerHTML = `
    <main id="main">
      <section id="list"><a id="first">One</a><a id="second">Two</a></section>
      <input id="field" />
    </main>`;
});

afterEach(() => {
  testListeners.abort();
  picker?.dispose();
  picker = null;
  delete (globalThis as Record<string, unknown>)[EXTRACTOR_REGISTRY_GLOBAL];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("createPicker", () => {
  it("reports the document before anything else", () => {
    start();
    expect(events[0]).toMatchObject({
      type: "documentReady",
      url: location.href,
      viewport: { deviceScaleFactor: expect.any(Number) },
    });
  });

  it("tells the host where the page has moved to before a selection made there", () => {
    start();
    expect(ofType("documentReady")).toHaveLength(1);
    // A client-side navigation keeps the document, so nothing else reports it.
    history.pushState({}, "", "/settings?tab=1");
    document.getElementById("second")!.click();

    const index = events.findIndex((event) => event.type === "selectionChanged");
    expect(events[index - 1]).toMatchObject({
      type: "documentReady",
      url: expect.stringContaining("/settings?tab=1"),
    });

    // Nothing moved since: the next pick goes without another report.
    document.getElementById("first")!.click();
    expect(ofType("documentReady")).toHaveLength(2);
  });

  it("resolves hover once per animation frame, and only when the element changes", () => {
    start();
    pointAt(document.getElementById("first")!);
    pointAt(document.getElementById("list")!);
    pointAt(document.getElementById("second")!);
    expect(ofType("hoverChanged")).toHaveLength(0);

    runFrames();
    const hovers = ofType("hoverChanged");
    expect(hovers).toHaveLength(1);
    expect(hovers[0]?.observation?.label).toBe("a#second");

    pointAt(document.getElementById("second")!);
    runFrames();
    expect(ofType("hoverChanged")).toHaveLength(1);
  });

  it("asks the extractors once per frame, and only about where the pointer ended", () => {
    const asked: Array<{ phase: unknown; target: EventTarget | undefined }> = [];
    document.addEventListener(
      channelEvent(CHANNEL, "extract"),
      (event) => {
        const { phase } = JSON.parse((event as CustomEvent<string>).detail) as { phase: unknown };
        asked.push({ phase, target: event.composedPath()[0] });
      },
      { capture: true, signal: testListeners.signal }
    );
    start();
    for (const id of ["first", "list", "main", "first", "second"]) {
      pointAt(document.getElementById(id)!);
    }
    expect(asked).toEqual([]);

    runFrames();
    expect(asked).toEqual([{ phase: "hover", target: document.getElementById("second") }]);

    pointAt(document.getElementById("second")!);
    pointAt(document.getElementById("second")!);
    runFrames();
    expect(asked).toHaveLength(1);
  });

  it("reads no computed style and fetches nothing on hover, where a selection does read styles", () => {
    const styles = vi.spyOn(window, "getComputedStyle");
    const fetches = vi.fn();
    vi.stubGlobal("fetch", fetches);
    const requests = vi.spyOn(XMLHttpRequest.prototype, "open");
    start();
    for (const id of ["first", "list", "second", "field", "main"]) {
      pointAt(document.getElementById(id)!);
      runFrames();
    }
    expect(ofType("hoverChanged")).toHaveLength(5);
    expect(styles).not.toHaveBeenCalled();
    expect(fetches).not.toHaveBeenCalled();
    expect(requests).not.toHaveBeenCalled();

    // Not a vacuous pass: the spy sees the reads a selection's context makes.
    document.getElementById("second")!.click();
    expect(ofType("selectionChanged")).toHaveLength(1);
    expect(styles).toHaveBeenCalled();
    expect(fetches).not.toHaveBeenCalled();
  });

  it("does no work while the page and the pointer are idle", async () => {
    // Before the picker starts, so a timer it sets up then is one it is seen to own.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const flush = async () => {
      for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
    };
    const settle = async (rounds: number) => {
      for (let round = 0; round < rounds; round += 1) {
        runFrames();
        // Mutation records arrive as microtasks; a frame that set off its own
        // records would schedule the next one here.
        await flush();
      }
    };
    start();
    await settle(5);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    const posted = events.length;
    const sweeps = [
      vi.spyOn(document, "querySelectorAll"),
      vi.spyOn(document, "getElementsByTagName"),
      vi.spyOn(document, "createTreeWalker"),
    ];
    vi.advanceTimersByTime(60_000);
    await settle(10);
    expect(frames.size).toBe(0);
    expect(events).toHaveLength(posted);
    for (const sweep of sweeps) expect(sweep).not.toHaveBeenCalled();

    // Not a vacuous pass: the same picker answers the pointer, then goes quiet again.
    pointAt(document.getElementById("first")!);
    expect(frames.size).toBe(1);
    await settle(5);
    expect(ofType("hoverChanged")).toHaveLength(1);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps one element id per element for the life of the document", () => {
    start();
    const second = document.getElementById("second")!;
    pointAt(second);
    runFrames();
    second.click();
    document.getElementById("first")!.click();
    const hoverId = ofType("hoverChanged")[0]?.observation?.elementId;
    const [secondSelection, firstSelection] = ofType("selectionChanged");
    expect(secondSelection?.observations[0]?.elementId).toBe(hoverId);
    expect(firstSelection?.observations[0]?.elementId).not.toBe(hoverId);
  });

  it("selects on click without letting the page see the click", () => {
    start();
    let pageClicks = 0;
    const link = document.getElementById("first")!;
    link.addEventListener("click", () => {
      pageClicks += 1;
    });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true });
    link.dispatchEvent(click);
    expect(pageClicks).toBe(0);
    expect(click.defaultPrevented).toBe(true);
    expect(ofType("selectionChanged")).toEqual([
      expect.objectContaining({ cause: "user", scope: { kind: "element" } }),
    ]);
    expect(selectedTag()).toBe("a");
  });

  it("walks the rendered tree with the arrows and lets go on Escape", () => {
    start();
    document.getElementById("first")!.click();
    press("ArrowRight");
    expect(ofType("selectionChanged").at(-1)?.observations[0]?.label).toBe("a#second");
    press("ArrowUp");
    expect(ofType("selectionChanged").at(-1)?.observations[0]?.label).toBe("section#list");
    press("ArrowDown");
    expect(ofType("selectionChanged").at(-1)?.observations[0]?.label).toBe("a#first");

    const escape = press("Escape");
    expect(escape.defaultPrevented).toBe(true);
    expect(ofType("selectionChanged").at(-1)).toMatchObject({ observations: [], cause: "user" });
    // Nothing left to clear: Escape is the host's again.
    expect(press("Escape").defaultPrevented).toBe(false);
  });

  it("leaves keys to an IME composition and to a focused page control", () => {
    start();
    document.getElementById("first")!.click();
    const before = ofType("selectionChanged").length;
    press("ArrowRight", { isComposing: true });
    const typed = press("ArrowRight", {}, document.getElementById("field")!);
    expect(typed.defaultPrevented).toBe(false);
    expect(ofType("selectionChanged")).toHaveLength(before);
  });

  it("listens to nothing in browse mode", () => {
    start("browse");
    let pageClicks = 0;
    const link = document.getElementById("first")!;
    link.addEventListener("click", () => {
      pageClicks += 1;
    });
    link.click();
    pointAt(link);
    runFrames();
    expect(pageClicks).toBe(1);
    expect(ofType("selectionChanged")).toHaveLength(0);
    expect(ofType("hoverChanged")).toHaveLength(0);
  });

  it("cancels a pending frame when switched to browse or disposed, so nothing lands after", () => {
    const toBrowse = start();
    pointAt(document.getElementById("first")!);
    expect(frames.size).toBe(1);
    toBrowse.setMode("browse");
    expect(frames.size).toBe(0);
    toBrowse.dispose();

    events = [];
    const disposed = start();
    pointAt(document.getElementById("second")!);
    expect(frames.size).toBe(1);
    disposed.dispose();
    expect(frames.size).toBe(0);
    expect(ofType("hoverChanged")).toHaveLength(0);
  });

  it("walks into and along a shadow tree, not past it", () => {
    document.body.innerHTML = '<div id="host"><span id="light">slotted</span></div>';
    const hostElement = document.getElementById("host")!;
    const root = hostElement.attachShadow({ mode: "open" });
    root.innerHTML = '<b id="one">1</b><i id="two">2</i><slot></slot>';
    start();
    root.getElementById("one")!.click();
    press("ArrowRight");
    expect(ofType("selectionChanged").at(-1)?.observations[0]?.label).toBe("i#two");
    press("ArrowUp");
    expect(ofType("selectionChanged").at(-1)?.observations[0]?.label).toBe("div#host");
    press("ArrowDown");
    expect(ofType("selectionChanged").at(-1)?.observations[0]?.label).toBe("b#one");
  });

  it("stops listening in browse, outlining only the selection it still holds", () => {
    const handle = start();
    document.getElementById("first")!.click();
    runFrames();
    expect(handle.getOverlayRoot()?.host.isConnected).toBe(true);

    handle.setMode("browse");
    const selections = ofType("selectionChanged").length;
    let pageClicks = 0;
    document.getElementById("second")!.addEventListener("click", () => {
      pageClicks += 1;
    });
    document.getElementById("second")!.click();
    expect(pageClicks).toBe(1);
    expect(ofType("selectionChanged")).toHaveLength(selections);

    runFrames();
    expect(handle.getOverlayRoot()?.host.isConnected).toBe(true);
    // With nothing held, browse leaves nothing behind.
    handle.clearSelection();
    expect(handle.getOverlayRoot()).toBeNull();
  });

  it("reports a framework the selection's markup names, once per document", () => {
    document.body.innerHTML =
      '<app-root ng-version="22.0.0"><button id="a">A</button><button id="b">B</button></app-root>';
    start();
    document.getElementById("a")!.click();
    document.getElementById("b")!.click();
    const detected = ofType("frameworksDetected");
    expect(detected).toHaveLength(1);
    expect(detected[0]?.detections).toEqual([
      { framework: "angular", signals: [{ via: "attribute", name: "ng-version" }] },
    ]);
    // The selection carries the same evidence; a hover never pays for the walk.
    expect(ofType("selectionChanged")[0]?.observations[0]?.detections).toEqual(
      detected[0]?.detections
    );
    pointAt(document.getElementById("a")!);
    runFrames();
    expect(ofType("hoverChanged")[0]?.observation?.detections).toEqual([]);
  });

  it("takes the first extractor answer that matches its request", () => {
    const chain = {
      nearestId: "c1",
      components: [
        {
          componentId: "c1",
          framework: "vue",
          name: { value: "Card", extraction: { kind: "runtime-field", field: "type.__name" } },
          environment: "client",
          rootElementIds: [],
          rootsComplete: true,
          sourceCandidates: [],
        },
      ],
      truncated: false,
    };
    const phases: string[] = [];
    // Stands in for the main-world registry, and for a page forging replies.
    document.addEventListener(
      channelEvent(CHANNEL, "extract"),
      (event) => {
        const request = JSON.parse((event as CustomEvent<string>).detail) as {
          id: number;
          phase: string;
        };
        phases.push(request.phase);
        const reply = (body: unknown) =>
          document.dispatchEvent(
            new CustomEvent(channelEvent(CHANNEL, "extracted"), { detail: JSON.stringify(body) })
          );
        reply({ id: request.id + 1, contributions: [{ framework: "react", data: {} }] });
        reply({
          id: request.id,
          contributions: [
            { framework: "not-a-framework", data: {} },
            { framework: "vue", data: { componentChain: chain } },
          ],
        });
      },
      { capture: true, signal: testListeners.signal }
    );
    start();
    const target = document.getElementById("first")!;
    pointAt(target);
    runFrames();
    target.click();

    expect(phases).toEqual(["hover", "selection"]);
    expect(ofType("hoverChanged")[0]?.observation?.componentChain).toEqual(chain);
    expect(ofType("selectionChanged")[0]?.observations[0]?.componentChain).toEqual(chain);
  });

  it("keeps the neutral fields where an extractor's answer is malformed", () => {
    document.addEventListener(
      channelEvent(CHANNEL, "extract"),
      (event) => {
        const { id } = JSON.parse((event as CustomEvent<string>).detail) as { id: number };
        document.dispatchEvent(
          new CustomEvent(channelEvent(CHANNEL, "extracted"), {
            detail: JSON.stringify({
              id,
              contributions: [
                {
                  framework: "react",
                  data: {
                    capabilities: {},
                    componentChain: { components: "not a list" },
                    sourceCandidates: [1, 2],
                  },
                },
              ],
            }),
          })
        );
      },
      { capture: true, signal: testListeners.signal }
    );
    start();
    // The schema check in `post` is the assertion: a malformed field would throw.
    document.getElementById("first")!.click();
    const observation = ofType("selectionChanged")[0]?.observations[0];
    expect(observation?.componentChain.components).toEqual([]);
    expect(observation?.capabilities.names).toEqual({ state: "unknown" });
    expect(observation?.sourceCandidates).toEqual([]);
  });

  describe("element roots", () => {
    const record = (rootElementIds: string[]) => ({
      componentId: "c1",
      framework: "react",
      name: null,
      environment: "client",
      rootElementIds,
      rootsComplete: true,
      sourceCandidates: [],
    });

    /** Stands in for the main-world registry: names elements by event, then replies. */
    function answerWith(
      reply: (id: number, name: (node: Element, message: unknown) => void) => unknown
    ): void {
      document.addEventListener(
        channelEvent(CHANNEL, "extract"),
        (event) => {
          const { id } = JSON.parse((event as CustomEvent<string>).detail) as { id: number };
          const name = (node: Element, message: unknown) =>
            node.dispatchEvent(
              new CustomEvent(channelEvent(CHANNEL, "element"), {
                detail: JSON.stringify(message),
                composed: true,
              })
            );
          const body = reply(id, name);
          document.dispatchEvent(
            new CustomEvent(channelEvent(CHANNEL, "extracted"), { detail: JSON.stringify(body) })
          );
        },
        { capture: true, signal: testListeners.signal }
      );
    }

    function selectedChain() {
      return ofType("selectionChanged").at(-1)?.observations[0]?.componentChain;
    }

    it("turns a reply's root tokens into the picker's own element ids", () => {
      const first = document.getElementById("first")!;
      const second = document.getElementById("second")!;
      answerWith((id, name) => {
        name(first, { id, ref: 0 });
        name(second, { id, ref: 1 });
        return {
          id,
          contributions: [
            {
              framework: "react",
              data: {
                componentChain: {
                  nearestId: "c1",
                  components: [record(["ref-0", "ref-1", "ref-0"])],
                  truncated: false,
                },
              },
            },
          ],
        };
      });
      start();
      second.click();
      const secondId = ofType("selectionChanged").at(-1)?.observations[0]?.elementId;
      first.click();
      const firstId = ofType("selectionChanged").at(-1)?.observations[0]?.elementId;

      expect(selectedChain()?.components[0]).toMatchObject({
        rootElementIds: [firstId, secondId],
        rootsComplete: true,
      });
    });

    it("drops what it cannot resolve and says the roots are no longer complete", () => {
      const first = document.getElementById("first")!;
      const second = document.getElementById("second")!;
      answerWith((id, name) => {
        // One token claimed for two nodes names neither; a stale request's names nothing.
        name(first, { id, ref: 0 });
        name(second, { id, ref: 0 });
        name(first, { id: id - 1, ref: 1 });
        name(second, { id, ref: 2 });
        second.remove();
        return {
          id,
          contributions: [
            {
              framework: "react",
              data: {
                componentChain: {
                  nearestId: "c1",
                  // A page-world reader cannot know an element id, so a literal one names nothing.
                  components: [record(["ref-0", "ref-1", "ref-2", "el-1"])],
                  truncated: false,
                },
              },
            },
          ],
        };
      });
      start();
      first.click();

      expect(selectedChain()?.components[0]).toMatchObject({
        rootElementIds: [],
        rootsComplete: false,
      });
    });

    it("stops taking names past what one reply could hold, and takes them again for the next", () => {
      const first = document.getElementById("first")!;
      let flood = true;
      answerWith((id, name) => {
        if (flood) {
          // Page noise on the channel: malformed, out of range, for another request.
          for (let index = 0; index < 600; index += 1) {
            name(
              first,
              index % 3 === 0 ? "noise" : { id: index % 3 === 1 ? id : id + 9, ref: 999 }
            );
          }
        }
        name(first, { id, ref: 0 });
        return {
          id,
          contributions: [
            {
              framework: "react",
              data: {
                componentChain: {
                  nearestId: "c1",
                  components: [record(["ref-0"])],
                  truncated: false,
                },
              },
            },
          ],
        };
      });
      start();
      first.click();
      expect(selectedChain()?.components[0]).toMatchObject({
        rootElementIds: [],
        rootsComplete: false,
      });

      flood = false;
      first.click();
      const observation = ofType("selectionChanged").at(-1)?.observations[0];
      expect(observation?.componentChain.components[0]).toMatchObject({
        rootElementIds: [observation?.elementId],
        rootsComplete: true,
      });
    });

    it("gives a selection set off inside another's dispatch no answer of its own", () => {
      const first = document.getElementById("first")!;
      const second = document.getElementById("second")!;
      let nested = false;
      answerWith((id, name) => {
        if (!nested) {
          nested = true;
          // Page code running inside the dispatch selects something else.
          second.click();
        }
        name(first, { id, ref: 0 });
        return {
          id,
          contributions: [
            {
              framework: "react",
              data: {
                componentChain: {
                  nearestId: "c1",
                  components: [record(["ref-0"])],
                  truncated: false,
                },
              },
            },
          ],
        };
      });
      start();
      first.click();

      // The nested click is refused outright, and the outer reply keeps its names.
      const selections = ofType("selectionChanged");
      expect(selections).toHaveLength(1);
      const [outer] = selections;
      expect(outer?.observations[0]?.label).toBe("a#first");
      expect(outer?.observations[0]?.componentChain.components[0]?.rootElementIds).toEqual([
        outer?.observations[0]?.elementId,
      ]);
    });
  });

  describe("with several frameworks answering", () => {
    const evidence = (framework: string, note: string) => ({
      kind: "generic",
      framework,
      fields: [{ name: "note", value: note }],
    });
    const capabilitiesWith = (names: "available" | "unknown") => ({
      names: { state: names },
      chain: { state: "unknown" },
      componentSelection: { state: "unknown" },
      file: { state: "unknown" },
      line: { state: "unknown" },
      exactRange: { state: "unknown" },
    });

    function answerWith(contributions: Array<{ framework: string; data: unknown }>): void {
      document.addEventListener(
        channelEvent(CHANNEL, "extract"),
        (event) => {
          const { id } = JSON.parse((event as CustomEvent<string>).detail) as { id: number };
          document.dispatchEvent(
            new CustomEvent(channelEvent(CHANNEL, "extracted"), {
              detail: JSON.stringify({ id, contributions }),
            })
          );
        },
        { capture: true, signal: testListeners.signal }
      );
    }

    function selected() {
      start();
      document.getElementById("first")!.click();
      return ofType("selectionChanged")[0]!.observations[0]!;
    }

    it("lets the best-ranked describing answer describe, and gathers every framework's evidence", () => {
      const direct = { ...capabilitiesWith("available"), line: { state: "available" } };
      answerWith([
        { framework: "vue", data: { frameworkEvidence: [evidence("vue", "around")] } },
        {
          framework: "react",
          data: {
            ownership: "fallback",
            capabilities: capabilitiesWith("unknown"),
            frameworkEvidence: [evidence("react", "fallback")],
          },
        },
        {
          framework: "svelte",
          data: {
            capabilities: capabilitiesWith("available"),
            frameworkEvidence: [evidence("svelte", "unmarked")],
          },
        },
        {
          framework: "astro",
          data: {
            ownership: "direct",
            capabilities: direct,
            frameworkEvidence: [evidence("astro", "direct")],
          },
        },
      ]);
      const observation = selected();
      expect(observation.capabilities).toEqual(direct);
      expect(
        observation.frameworkEvidence.map((entry) =>
          entry.kind === "generic" ? entry.framework : entry.kind
        )
      ).toEqual(["astro", "vue", "react", "svelte"]);
    });

    it("never lets evidence alone describe the element", () => {
      answerWith([
        { framework: "astro", data: { frameworkEvidence: [evidence("astro", "island")] } },
        { framework: "svelte", data: { ownership: "direct", frameworkEvidence: [] } },
      ]);
      const observation = selected();
      expect(observation.capabilities.names).toEqual({ state: "unknown" });
      expect(observation.frameworkEvidence).toEqual([evidence("astro", "island")]);
    });

    const rankings: Array<{
      ownerships: [string | undefined, string | undefined];
      describedBy: "first" | "second";
    }> = [
      // Equal to unmarked: the first installed of the two describes.
      { ownerships: ["constructor", undefined], describedBy: "first" },
      { ownerships: [undefined, "constructor"], describedBy: "first" },
      // Above fallback, wherever it sits.
      { ownerships: ["fallback", "constructor"], describedBy: "second" },
    ];
    it.each(rankings)(
      "ranks an ownership it does not know as unmarked: $ownerships",
      ({ ownerships, describedBy }) => {
        answerWith(
          ownerships.map((ownership, index) => ({
            framework: index === 0 ? "react" : "vue",
            data: {
              ...(ownership === undefined ? {} : { ownership }),
              capabilities: capabilitiesWith(index === 0 ? "available" : "unknown"),
            },
          }))
        );
        expect(selected().capabilities.names).toEqual({
          state: describedBy === "first" ? "available" : "unknown",
        });
      }
    );

    it("drops evidence the host would refuse, keeping the rest and the description", () => {
      answerWith([
        {
          framework: "react",
          data: {
            capabilities: capabilitiesWith("available"),
            frameworkEvidence: [
              null,
              {},
              { kind: "generic", framework: "react", fields: [], extra: 1 },
            ],
          },
        },
        {
          framework: "astro",
          data: {
            frameworkEvidence: [
              { kind: "generic", framework: "astro", fields: [{ name: "", value: "x" }] },
              { kind: "generic", framework: "qwik", fields: [] },
              // Only the describing framework sends its own variant.
              { kind: "svelte", ancestry: [{}], sameLocCount: 0, unmapped: false },
              evidence("astro", "kept"),
            ],
          },
        },
      ]);
      // The schema check in `post` is the assertion that what is left is admissible.
      const observation = selected();
      expect(observation.capabilities.names).toEqual({ state: "available" });
      expect(observation.frameworkEvidence).toEqual([evidence("astro", "kept")]);
    });

    it("gathers evidence only up to what the host admits", () => {
      const many = (framework: string) =>
        Array.from({ length: 5 }, (_, index) => evidence(framework, String(index)));
      answerWith([
        { framework: "react", data: { frameworkEvidence: many("react") } },
        { framework: "astro", data: { frameworkEvidence: many("astro") } },
      ]);
      // The schema check in `post` holds the total to the wire's limit.
      expect(selected().frameworkEvidence).toHaveLength(8);
    });
  });

  it("describes the selection again when the host's account changes it, and reports one the document removed", () => {
    const handle = start();
    const target = document.getElementById("first")!;
    target.click();
    handle.setAvailability(SETTLED);
    // The same account again says nothing new about the element.
    handle.setAvailability(SETTLED);
    target.remove();
    runFrames();
    expect(ofType("selectionChanged").map((event) => event.cause)).toEqual([
      "user",
      "reselect",
      "document",
    ]);
    expect(ofType("selectionChanged").at(-1)?.observations).toEqual([]);
  });

  it("reports nothing as unavailable until the host's first look at the page finished", () => {
    const handle = start();
    document.getElementById("first")!.click();
    expect(selectedCapabilities()).toEqual(every({ state: "unknown" }));

    handle.setAvailability(SETTLED);
    expect(selectedCapabilities()).toEqual(every({ state: "unavailable", reason: "no-framework" }));
    pointAt(document.getElementById("second")!);
    runFrames();
    expect(ofType("hoverChanged")[0]?.observation?.capabilities).toEqual(
      every({ state: "unavailable", reason: "no-framework" })
    );
  });

  it.each([
    ["still loading", "pending", { state: "unknown" }],
    ["one this build does not ship", "unavailable", { state: "unknown" }],
    ["one that failed to install", "failed", { state: "unknown" }],
    [
      "one that ran and found nothing",
      "installed",
      { state: "unavailable", reason: "not-exposed" },
    ],
  ] as const)(
    "leaves capabilities for a framework whose reader is %s at %j",
    (_label, state, expected) => {
      answerEmpty("solid");
      const handle = start();
      handle.setAvailability({ detection: "settled", extractors: { solid: state } });
      document.getElementById("first")!.click();
      expect(selectedCapabilities()).toEqual(every(expected));
    }
  );

  it("keeps the answer open for a framework the selection names that the host has not heard of yet", () => {
    document.body.innerHTML = '<div data-hk="0"><button id="hydrated">Go</button></div>';
    answerEmpty("solid");
    const handle = start();
    handle.setAvailability(SETTLED);
    document.getElementById("hydrated")!.click();
    expect(ofType("selectionChanged")[0]?.observations[0]?.detections).toEqual([
      { framework: "solid", signals: [{ via: "attribute", name: "data-hk" }] },
    ]);
    expect(selectedCapabilities()).toEqual(every({ state: "unknown" }));

    handle.setAvailability({ detection: "settled", extractors: { solid: "installed" } });
    expect(selectedCapabilities()).toEqual(every({ state: "unavailable", reason: "not-exposed" }));
  });

  it.each([
    ["said nothing at all", null],
    ["threw, so is in neither list", { contributions: [] }],
    ["answered for another framework", { contributions: [], empty: ["vue"] }],
  ])("keeps an installed reader that %s from becoming a claim about the page", (_label, reply) => {
    if (reply !== null) answerWith((id) => ({ id, ...reply }));
    const handle = start();
    handle.setAvailability({ detection: "settled", extractors: { solid: "installed" } });
    document.getElementById("first")!.click();
    expect(selectedCapabilities()).toEqual(every({ state: "unknown" }));
  });

  it("keeps the answer open for a reader that answered before the host recorded it", () => {
    answerEmpty("solid");
    const handle = start();
    handle.setAvailability(SETTLED);
    document.getElementById("first")!.click();
    expect(selectedCapabilities()).toEqual(every({ state: "unknown" }));
  });

  it("keeps a reader's word for its own framework open while another's reader could still answer", () => {
    const solid = {
      names: { state: "unavailable", reason: "not-exposed" },
      chain: { state: "unavailable", reason: "not-exposed" },
      componentSelection: { state: "unavailable", reason: "not-exposed" },
      file: { state: "available" },
      line: { state: "available" },
      exactRange: { state: "unavailable", reason: "not-exposed" },
    } as const;
    answerWith((id) => ({
      id,
      contributions: [{ framework: "solid", data: { capabilities: solid } }],
      empty: [],
    }));
    const handle = start();
    // An Astro page with a Solid island, where Astro's reader is not available.
    handle.setAvailability({
      detection: "settled",
      extractors: { astro: "unavailable", solid: "installed" },
    });
    document.getElementById("first")!.click();
    expect(selectedCapabilities()).toEqual({
      ...every({ state: "unknown" }),
      file: { state: "available" },
      line: { state: "available" },
    });

    handle.setAvailability({ detection: "settled", extractors: { solid: "installed" } });
    expect(selectedCapabilities()).toEqual(solid);
  });

  it("leaves capabilities open when an extractor answers without saying what it offers", () => {
    answerWith((id) => ({ id, contributions: [{ framework: "solid", data: {} }] }));
    const handle = start();
    handle.setAvailability({ detection: "settled", extractors: { solid: "installed" } });
    document.getElementById("first")!.click();
    expect(selectedCapabilities()).toEqual(every({ state: "unknown" }));
  });

  it("takes an outranked reader's answer as its look, so the describing reader's word holds", () => {
    const astro = {
      ...every({ state: "unavailable", reason: "not-exposed" }),
      file: { state: "available" },
      line: { state: "available" },
    } as const;
    answerWith((id) => ({
      id,
      contributions: [
        { framework: "react", data: { capabilities: every({ state: "available" }) } },
        { framework: "astro", data: { ownership: "direct", capabilities: astro } },
      ],
      empty: ["svelte"],
    }));
    const handle = start();
    const installed = { astro: "installed", react: "installed", svelte: "installed" } as const;
    handle.setAvailability({ detection: "settled", extractors: installed });
    document.getElementById("first")!.click();
    expect(selectedCapabilities()).toEqual(astro);

    // A reader the host has not confirmed has not looked, whatever it answered.
    handle.setAvailability({
      detection: "settled",
      extractors: { ...installed, react: "pending" },
    });
    expect(selectedCapabilities()).toEqual({
      ...every({ state: "unknown" }),
      file: { state: "available" },
      line: { state: "available" },
    });
  });

  it("keeps the answer open beside a reader that sent evidence alone", () => {
    const island = {
      kind: "generic",
      framework: "astro",
      fields: [{ name: "islandRenderer", value: "svelte" }],
    };
    answerWith((id) => ({
      id,
      contributions: [{ framework: "astro", data: { frameworkEvidence: [island] } }],
      empty: ["svelte"],
    }));
    const handle = start();
    handle.setAvailability({
      detection: "settled",
      extractors: { astro: "installed", svelte: "installed" },
    });
    document.getElementById("first")!.click();
    expect(selectedCapabilities()).toEqual(every({ state: "unknown" }));
    expect(ofType("selectionChanged").at(-1)?.observations[0]?.frameworkEvidence).toEqual([island]);
  });

  it("describes a hover again when the host's account changes what it says, without the pointer moving", () => {
    const handle = start();
    pointAt(document.getElementById("second")!);
    runFrames();
    handle.setAvailability(SETTLED);
    handle.setAvailability(SETTLED);
    const hovers = ofType("hoverChanged");
    expect(hovers).toHaveLength(2);
    expect(hovers[1]?.observation?.capabilities).toEqual(
      every({ state: "unavailable", reason: "no-framework" })
    );
  });

  it("reports a selection the page removed while it was being described again", () => {
    const handle = start();
    const target = document.getElementById("first")!;
    target.click();
    runFrames();
    // The page's own listener on the extract request takes the element away.
    answerWith((id) => {
      target.remove();
      return { id, contributions: [], empty: [] };
    });
    handle.setAvailability(SETTLED);
    runFrames();
    expect(target.isConnected).toBe(false);
    expect(ofType("selectionChanged").at(-1)).toMatchObject({
      cause: "document",
      observations: [],
    });
  });

  it("reports a selection the page removed while described again in browse mode, where no frame runs", () => {
    const handle = start();
    const target = document.getElementById("first")!;
    target.click();
    handle.setMode("browse");
    answerWith((id) => {
      target.remove();
      return { id, contributions: [], empty: [] };
    });
    handle.setAvailability(SETTLED);
    expect(ofType("selectionChanged").at(-1)).toMatchObject({
      cause: "document",
      observations: [],
    });
  });

  it("describes a selection from the DOM, and never pays for that on hover", () => {
    start();
    const target = document.getElementById("second")!;
    pointAt(target);
    runFrames();
    target.click();
    expect(ofType("hoverChanged")[0]?.observation).not.toHaveProperty("context");
    expect(ofType("selectionChanged")[0]?.observations[0]?.context).toMatchObject({
      selector: "#second",
      markup: '<a id="second">Two</a>',
      shadowHosts: [],
    });
  });

  it("names the hosts of the shadow roots around a selection, innermost first", () => {
    document.body.innerHTML = '<app-shell id="shell"></app-shell>';
    const shell = document.getElementById("shell")!;
    const outer = shell.attachShadow({ mode: "open" });
    outer.innerHTML = '<x-card class="hero"></x-card>';
    const card = outer.querySelector("x-card")!;
    card.attachShadow({ mode: "open" }).innerHTML = '<button class="action">Open</button>';
    start();
    card.shadowRoot!.querySelector("button")!.click();
    const context = ofType("selectionChanged").at(-1)?.observations[0]?.context;
    expect(context?.selector).toBe("button.action");
    expect(context?.shadowHosts?.map(({ tagName, label }) => ({ tagName, label }))).toEqual([
      { tagName: "x-card", label: "x-card.hero" },
      { tagName: "app-shell", label: "app-shell#shell" },
    ]);
    expect(context).not.toHaveProperty("shadowHostsTruncated");

    // The host's id is the one the picker gives it when it is selected itself.
    press("ArrowUp");
    expect(ofType("selectionChanged").at(-1)?.observations[0]?.elementId).toBe(
      context?.shadowHosts?.[0]?.elementId
    );
  });

  it("says when more shadow roots enclose a selection than it names, keeping the innermost", () => {
    document.body.innerHTML = '<x-level id="level-0"></x-level>';
    let host = document.getElementById("level-0")!;
    const limit = OBSERVATION_LIMITS.shadowHosts;
    for (let level = 1; level <= limit + 1; level += 1) {
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<x-level id="level-${level}"></x-level>`;
      host = root.getElementById(`level-${level}`)!;
    }
    start();
    host.click();
    const context = ofType("selectionChanged").at(-1)?.observations[0]?.context;
    expect(context?.shadowHosts).toHaveLength(limit);
    expect(context?.shadowHosts?.[0]?.label).toBe(`x-level#level-${limit}`);
    expect(context?.shadowHostsTruncated).toBe(true);
  });

  it("walks no further into a slot that has only text assigned to it", () => {
    document.body.innerHTML = '<x-label id="label">Just text</x-label>';
    const root = document.getElementById("label")!.attachShadow({ mode: "open" });
    root.innerHTML = '<slot id="slot"><b id="hidden">fallback</b></slot>';
    start();
    root.getElementById("slot")!.click();
    const before = ofType("selectionChanged").length;
    press("ArrowDown");
    // The fallback is not rendered while the text is, so there is nothing to walk into.
    expect(ofType("selectionChanged")).toHaveLength(before);
  });

  it("walks a slot's assigned elements as its children, and a slotted element's slot as its parent", () => {
    document.body.innerHTML =
      '<x-list id="list"><p id="a">A</p><p id="b">B</p></x-list><x-empty id="empty"></x-empty>';
    const root = document.getElementById("list")!.attachShadow({ mode: "open" });
    root.innerHTML = '<ul id="frame"><slot id="slot"><i>fallback</i></slot></ul>';
    document.getElementById("empty")!.attachShadow({ mode: "open" }).innerHTML =
      '<slot id="spare"><i id="shown">fallback</i></slot>';
    start();
    root.getElementById("slot")!.click();
    press("ArrowDown");
    expect(selectedLabel()).toBe("p#a");
    press("ArrowRight");
    expect(selectedLabel()).toBe("p#b");
    press("ArrowUp");
    expect(selectedLabel()).toBe("slot#slot");

    // Nothing assigned: the fallback content is what renders.
    document.getElementById("empty")!.shadowRoot!.getElementById("spare")!.click();
    press("ArrowDown");
    expect(selectedLabel()).toBe("i#shown");
  });

  it("answers the handshake on its own channel only", () => {
    start();
    const ours = new CustomEvent(channelEvent(CHANNEL, "handshake"), { cancelable: true });
    const theirs = new CustomEvent(channelEvent("other", "handshake"), { cancelable: true });
    document.dispatchEvent(ours);
    document.dispatchEvent(theirs);
    expect(ours.defaultPrevented).toBe(true);
    expect(theirs.defaultPrevented).toBe(false);
  });

  it("leaves nothing behind on dispose, and tells the extractors to go", () => {
    const handle = start();
    document.getElementById("first")!.click();
    runFrames();
    const overlayHost = handle.getOverlayRoot()?.host;
    expect(overlayHost?.isConnected).toBe(true);
    let disposals = 0;
    document.addEventListener(
      channelEvent(CHANNEL, "dispose"),
      () => {
        disposals += 1;
      },
      { signal: testListeners.signal }
    );

    handle.dispose();
    expect(disposals).toBe(1);
    expect(overlayHost?.isConnected).toBe(false);
    const handshake = new CustomEvent(channelEvent(CHANNEL, "handshake"), { cancelable: true });
    document.dispatchEvent(handshake);
    expect(handshake.defaultPrevented).toBe(false);

    const count = events.length;
    document.getElementById("second")!.click();
    expect(events).toHaveLength(count);
  });
});

describe("the bridge's element exchanges", () => {
  function installReact(extractor: Parameters<typeof installExtractor>[1]): void {
    installExtractor({ channel: CHANNEL, framework: "react", installed: false }, extractor);
  }

  const record = {
    componentId: "c1",
    framework: "react" as const,
    name: { value: "List", extraction: { kind: "runtime-field" as const, field: "type.name" } },
    environment: "client" as const,
    rootElementIds: [],
    rootsComplete: false,
    sourceCandidates: [
      {
        kind: "component-invocation" as const,
        candidateId: "call",
        framework: "react" as const,
        extraction: { kind: "runtime-field" as const, field: "_debugSource" },
        file: "src/List.tsx",
        location: {
          lineBase: 1 as const,
          columnBase: 1 as const,
          columnUnit: "utf16" as const,
          line: 3,
          column: 1,
        },
      },
    ],
  };

  it("selects the element an extractor's pick names, and takes no forged name", () => {
    const first = document.getElementById("first")!;
    const list = document.getElementById("list")!;
    installReact({
      extract: () => ({}),
      pick: (hit) => ({ target: hit === first ? list : hit, data: {} }),
    });
    // A page naming something during the exchange: under the wrong request,
    // and under a token the reply does not use.
    document.addEventListener(
      channelEvent(CHANNEL, "extract"),
      (event) => {
        const { id } = JSON.parse((event as CustomEvent<string>).detail) as { id: number };
        const field = document.getElementById("field")!;
        for (const message of [
          { id: 999, ref: 0 },
          { id, ref: 7 },
        ]) {
          field.dispatchEvent(
            new CustomEvent(channelEvent(CHANNEL, "element"), {
              detail: JSON.stringify(message),
              composed: true,
            })
          );
        }
      },
      { capture: true, signal: testListeners.signal }
    );
    start();

    first.click();
    expect(selectedTag()).toBe("section");
    // A plain walk selects what it reaches; only a pick is stood in for.
    press("ArrowDown");
    expect(selectedTag()).toBe("a");
  });

  it("judges what is absent about the element a pick stands for, not the one it landed on", () => {
    const react = {
      ...every({ state: "unavailable", reason: "not-exposed" }),
      names: { state: "available" },
    } as const;
    let standIn: Element = document.getElementById("first")!;
    installReact({
      extract: () => ({}),
      pick: () => ({ target: standIn, data: { capabilities: react } }),
    });
    installExtractor(
      { channel: CHANNEL, framework: "solid", installed: false },
      { extract: () => null }
    );
    const handle = start();
    const settled = {
      detection: "settled",
      extractors: { react: "installed", solid: "installed" },
    } as const;
    handle.setAvailability(settled);
    document.getElementById("first")!.click();
    expect(selectedCapabilities()).toEqual(react);

    // Solid looked only at the hit, so what React calls unavailable on the list stays open.
    standIn = document.getElementById("list")!;
    handle.setAvailability(settled);
    expect(selectedTag()).toBe("section");
    expect(selectedCapabilities()).toEqual({
      ...every({ state: "unknown" }),
      names: { state: "available" },
    });
  });

  it("gathers evidence only from frameworks that saw the element a pick stands for", () => {
    const first = document.getElementById("first")!;
    const list = document.getElementById("list")!;
    let standIn: Element = first;
    const note = (framework: "react" | "astro") => ({
      kind: "generic" as const,
      framework,
      fields: [{ name: "saw", value: framework }],
    });
    installReact({
      extract: () => ({}),
      pick: () => ({ target: standIn, data: { frameworkEvidence: [note("react")] } }),
    });
    installExtractor(
      { channel: CHANNEL, framework: "astro", installed: false },
      { extract: () => ({ frameworkEvidence: [note("astro")] }) }
    );
    const handle = start();
    const gathered = () =>
      ofType("selectionChanged")
        .at(-1)
        ?.observations[0]?.frameworkEvidence.map((entry) =>
          entry.kind === "generic" ? entry.framework : entry.kind
        );

    first.click();
    expect(selectedTag()).toBe("a");
    expect(gathered()).toEqual(["react", "astro"]);

    // React's pick now stands for the list; Astro only looked at the hit.
    standIn = list;
    handle.setAvailability(SETTLED);
    expect(selectedTag()).toBe("section");
    expect(gathered()).toEqual(["react"]);
  });

  it("stays on the hit when page code claims a pick's token for another node", () => {
    const first = document.getElementById("first")!;
    const list = document.getElementById("list")!;
    // Ahead of the registry: the page claims the token the pick is about to use.
    document.addEventListener(
      channelEvent(CHANNEL, "extract"),
      (event) => {
        const { id } = JSON.parse((event as CustomEvent<string>).detail) as { id: number };
        document.getElementById("field")!.dispatchEvent(
          new CustomEvent(channelEvent(CHANNEL, "element"), {
            detail: JSON.stringify({ id, ref: 0 }),
            composed: true,
          })
        );
      },
      { capture: true, signal: testListeners.signal }
    );
    installReact({
      extract: () => ({}),
      pick: () => ({
        target: list,
        data: { componentChain: { nearestId: "c1", components: [record], truncated: false } },
      }),
    });
    start();

    first.click();
    // On the hit, and without the description of the element the pick stood for.
    const observation = ofType("selectionChanged").at(-1)?.observations[0];
    expect(observation?.label).toBe("a#first");
    expect(observation?.componentChain.components).toEqual([]);
  });

  it("widens to the component's roots and back to the element on the next click", () => {
    const first = document.getElementById("first")!;
    const second = document.getElementById("second")!;
    installReact({
      extract: () => ({
        componentChain: { nearestId: "c1", components: [record], truncated: false },
      }),
      locate: (query) =>
        (query as { kind?: string }).kind === "roots"
          ? { elements: [first, second], data: { complete: true } }
          : null,
    });
    start();
    first.click();

    expect(press("ArrowUp", { altKey: true }).defaultPrevented).toBe(true);
    const widened = ofType("selectionChanged").at(-1)!;
    expect(widened.scope).toEqual({ kind: "component", componentId: "c1" });
    const ids = widened.observations.map((observation) => observation.elementId);
    expect(ids).toHaveLength(2);
    for (const observation of widened.observations) {
      expect(observation.componentChain.components[0]).toMatchObject({
        rootElementIds: ids,
        rootsComplete: true,
      });
    }

    second.click();
    expect(ofType("selectionChanged").at(-1)?.scope).toEqual({ kind: "element" });
  });

  it("widens to a named component the page never placed, past one it cannot name", () => {
    const first = document.getElementById("first")!;
    const second = document.getElementById("second")!;
    const anonymous = { ...record, componentId: "c0", name: null, sourceCandidates: [] };
    const unplaced = { ...record, sourceCandidates: [] };
    const asked: string[] = [];
    installReact({
      extract: () => ({
        componentChain: {
          nearestId: "c0",
          components: [{ ...anonymous, renderParentId: "c1" }, unplaced],
          truncated: false,
        },
      }),
      locate: (query) => {
        asked.push((query as { componentId?: string }).componentId ?? "");
        return { elements: [first, second], data: { complete: true } };
      },
    });
    start();
    first.click();

    press("ArrowUp", { altKey: true });
    expect(asked).toEqual(["c1"]);
    expect(ofType("selectionChanged").at(-1)?.scope).toEqual({
      kind: "component",
      componentId: "c1",
    });
  });

  it("stops calling a widened component's roots complete once the document drops one", () => {
    const first = document.getElementById("first")!;
    const second = document.getElementById("second")!;
    installReact({
      extract: () => ({
        componentChain: { nearestId: "c1", components: [record], truncated: false },
      }),
      locate: () => ({ elements: [first, second], data: { complete: true } }),
    });
    start();
    first.click();
    press("ArrowUp", { altKey: true });
    expect(
      ofType("selectionChanged").at(-1)?.observations[0]?.componentChain.components[0]
    ).toMatchObject({ rootsComplete: true });

    second.remove();
    runFrames();

    const latest = ofType("selectionChanged").at(-1)!;
    expect(latest.cause).toBe("document");
    expect(latest.scope).toEqual({ kind: "component", componentId: "c1" });
    expect(latest.observations).toHaveLength(1);
    expect(latest.observations[0]?.componentChain.components[0]).toMatchObject({
      rootElementIds: [latest.observations[0]?.elementId],
      rootsComplete: false,
    });
  });

  it("keeps the old selection when the new one cannot fit one envelope", () => {
    const first = document.getElementById("first")!;
    const second = document.getElementById("second")!;
    // Three UTF-8 bytes a character: each answer fits the bridge and one
    // envelope on its own, and two of them fit neither however shortened.
    const wide = "€".repeat(2048);
    const heavy = {
      componentChain: { nearestId: "c1", components: [record], truncated: false },
      sourceCandidates: Array.from({ length: 16 }, (_, index) => ({
        ...record.sourceCandidates[0]!,
        kind: "element-creation" as const,
        candidateId: "e" + index,
        file: wide,
      })),
      frameworkEvidence: Array.from({ length: 8 }, () => ({
        kind: "generic" as const,
        framework: "react" as const,
        fields: Array.from({ length: 16 }, (_, index) => ({
          name: "f" + index,
          value: "€".repeat(256),
        })),
      })),
    };
    installReact({
      extract: () => heavy,
      locate: () => ({ elements: [first, second], data: { complete: true } }),
    });
    start();
    first.click();
    const before = ofType("selectionChanged").length;

    press("ArrowUp", { altKey: true });

    expect(ofType("selectionChanged")).toHaveLength(before);
    expect(ofType("runtimeIssue").at(-1)).toMatchObject({
      code: "capacity",
      detail: expect.stringContaining("selection left unchanged"),
    });
    // Still the click's selection, so the next walk starts from it.
    press("ArrowRight");
    expect(ofType("selectionChanged").at(-1)?.observations[0]?.label).toBe("a#second");
  });

  it("lets page code inside an exchange start no selection of its own", () => {
    const first = document.getElementById("first")!;
    const list = document.getElementById("list")!;
    installReact({
      extract: (element, phase) => {
        // The page, running inside the bootstrap's dispatch, clicks elsewhere.
        if (element === first && phase === "selection") list.click();
        return {};
      },
    });
    start();

    first.click();

    expect(ofType("selectionChanged").map((event) => event.observations[0]?.label)).toEqual([
      "a#first",
    ]);
    // The guest is on the selection the host was told about.
    press("ArrowRight");
    expect(ofType("selectionChanged").at(-1)?.observations[0]?.label).toBe("a#second");
  });

  it("takes a locate's answer only from a locate reply, and only the elements it names", () => {
    const first = document.getElementById("first")!;
    const second = document.getElementById("second")!;
    document.addEventListener(
      channelEvent(CHANNEL, "locate"),
      (event) => {
        const { id } = JSON.parse((event as CustomEvent<string>).detail) as { id: number };
        const name = (node: Element, ref: number) =>
          node.dispatchEvent(
            new CustomEvent(channelEvent(CHANNEL, "element"), {
              detail: JSON.stringify({ id, ref }),
              composed: true,
            })
          );
        name(first, 0);
        // Shaped like an extract reply: not the answer a locate waits for.
        document.dispatchEvent(
          new CustomEvent(channelEvent(CHANNEL, "extracted"), {
            detail: JSON.stringify({
              id,
              contributions: [],
              elements: ["ref-0", "ref-1"],
              data: {},
            }),
          })
        );
        document.dispatchEvent(
          new CustomEvent(channelEvent(CHANNEL, "located"), {
            detail: JSON.stringify({ id, elements: ["ref-0"], data: {}, truncated: false }),
          })
        );
        name(second, 1);
      },
      { capture: true, signal: testListeners.signal }
    );
    const handle = start();

    expect(handle.reselect({ framework: "react", locator: {} })).toBe(true);
    expect(
      ofType("selectionChanged")
        .at(-1)
        ?.observations.map((entry) => entry.label)
    ).toEqual(["a#first"]);
  });

  it("does not call a component's roots complete when some were never shown to it", () => {
    const list = document.getElementById("list")!;
    list.innerHTML = Array.from({ length: 33 }, (_, index) => `<b id="b${index}"></b>`).join("");
    const roots = Array.from(list.children);
    installReact({
      extract: () => ({
        componentChain: { nearestId: "c1", components: [record], truncated: false },
      }),
      locate: () => ({ elements: roots, data: { complete: true } }),
    });
    start();
    roots[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    press("ArrowUp", { altKey: true });

    const widened = ofType("selectionChanged").at(-1)!;
    expect(widened.observations).toHaveLength(32);
    expect(widened.observations[0]?.componentChain.components[0]?.rootsComplete).toBe(false);
  });

  it("leaves each root's markup and styles out of a widened selection that cannot fit them", () => {
    const list = document.getElementById("list")!;
    // Three UTF-8 bytes a character: every root's markup is within its own
    // ceiling, and 32 of them are past one envelope.
    const attributes = Array.from(
      { length: 16 },
      (_, index) => `aria-x${index}="${"€".repeat(160)}"`
    ).join(" ");
    list.innerHTML = Array.from(
      { length: 32 },
      (_, index) => `<p id="p${index}" ${attributes}></p>`
    ).join("");
    const roots = Array.from(list.children);
    installReact({
      extract: () => ({
        componentChain: { nearestId: "c1", components: [record], truncated: false },
        frameworkEvidence: [
          {
            kind: "generic",
            framework: "react",
            fields: Array.from({ length: 4 }, (_, index) => ({
              name: "f" + index,
              value: "€".repeat(256),
            })),
          },
        ],
      }),
      locate: () => ({ elements: roots, data: { complete: true } }),
    });
    const handle = start();
    roots[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(ofType("selectionChanged").at(-1)?.observations[0]?.context).toBeDefined();

    press("ArrowUp", { altKey: true });

    const widened = ofType("selectionChanged").at(-1)!;
    expect(widened.scope).toEqual({ kind: "component", componentId: "c1" });
    expect(widened.observations).toHaveLength(32);
    expect(widened.observations.some((observation) => observation.context !== undefined)).toBe(
      false
    );
    expect(ofType("runtimeIssue").at(-1)).toMatchObject({
      code: "capacity",
      detail: expect.stringContaining("markup and styles left out"),
    });

    // A change only to the markup the fit leaves out tells the host nothing new.
    const sent = ofType("selectionChanged").length;
    const notices = ofType("runtimeIssue").length;
    roots[0]!.setAttribute("aria-x0", "€".repeat(159) + "x");
    handle.setAvailability(SETTLED);
    expect(ofType("selectionChanged")).toHaveLength(sent);
    expect(ofType("runtimeIssue")).toHaveLength(notices);
  });

  it("goes back to element scope when the component is no longer described", () => {
    const first = document.getElementById("first")!;
    const second = document.getElementById("second")!;
    let described = true;
    installReact({
      extract: () =>
        described
          ? { componentChain: { nearestId: "c1", components: [record], truncated: false } }
          : {},
      locate: () => ({ elements: [first, second], data: { complete: true } }),
    });
    const handle = start();
    first.click();
    press("ArrowUp", { altKey: true });
    expect(ofType("selectionChanged").at(-1)?.scope.kind).toBe("component");

    described = false;
    handle.setAvailability(SETTLED);
    expect(ofType("selectionChanged").at(-1)?.scope).toEqual({ kind: "element" });

    // Described again, the selection stays what the host was told it is.
    described = true;
    handle.setAvailability(SETTLED);
    expect(ofType("selectionChanged").at(-1)?.scope).toEqual({ kind: "element" });

    // Widening starts again from the innermost component, not past the old scope.
    const before = ofType("selectionChanged").length;
    press("ArrowUp", { altKey: true });
    expect(ofType("selectionChanged")).toHaveLength(before + 1);
    expect(ofType("selectionChanged").at(-1)?.scope).toEqual({
      kind: "component",
      componentId: "c1",
    });
  });

  it("adopts a pick's new answer when described again, and walks on from it", () => {
    const first = document.getElementById("first")!;
    const list = document.getElementById("list")!;
    let standIn: Element = first;
    installReact({ extract: () => ({}), pick: () => ({ target: standIn, data: {} }) });
    const handle = start();
    first.click();
    expect(selectedTag()).toBe("a");

    standIn = list;
    handle.setAvailability(SETTLED);
    expect(selectedTag()).toBe("section");
    press("ArrowRight");
    expect(selectedTag()).toBe("input");
  });

  it("can be asked for an element again after its lookup was let go", () => {
    const list = document.getElementById("list")!;
    list.innerHTML = Array.from({ length: 2_001 }, (_, index) => `<i id="i${index}"></i>`).join("");
    const handle = start();
    const first = document.getElementById("i0")!;
    first.click();
    const id = ofType("selectionChanged")[0]!.observations[0]!.elementId;
    for (let index = 1; index <= 2_000; index += 1) {
      pointAt(document.getElementById("i" + index)!);
      runFrames();
    }
    expect(handle.reselect({ elementId: id })).toBe(false);

    // Reported again, it can be asked for again.
    first.click();
    expect(handle.reselect({ elementId: id })).toBe(true);
  });

  it("selects again by the id it reported, while that is still the same node", () => {
    const handle = start();
    const first = document.getElementById("first")!;
    first.click();
    document.getElementById("second")!.click();
    const id = ofType("selectionChanged")[0]!.observations[0]!.elementId;

    expect(handle.reselect({ elementId: id })).toBe(true);
    expect(ofType("selectionChanged").at(-1)).toMatchObject({
      cause: "reselect",
      observations: [{ elementId: id }],
    });
    expect(handle.reselect({ elementId: "el-999" })).toBe(false);
    first.remove();
    expect(handle.reselect({ elementId: id })).toBe(false);
    expect(handle.reselect("not a request")).toBe(false);
  });

  it("turns an extractor's notice into one issue per document, in its own words", () => {
    start();
    const notify = (detail: unknown) =>
      document.dispatchEvent(
        new CustomEvent(channelEvent(CHANNEL, "notice"), { detail: JSON.stringify(detail) })
      );
    notify({ framework: "svelte", notice: "not-dev-build" });
    notify({ framework: "svelte", notice: "not-dev-build" });
    notify({ framework: "jquery", notice: "not-dev-build" });
    notify({ framework: "svelte", notice: "<b>anything the page likes</b>" });

    expect(ofType("runtimeIssue")).toEqual([
      {
        type: "runtimeIssue",
        code: "not-dev-build",
        framework: "svelte",
        detail: expect.stringContaining("production build"),
      },
    ]);
  });
});
