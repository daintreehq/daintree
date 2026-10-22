// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ElementPickerEventSchema,
  type ElementPickerEvent,
} from "../../../../../shared/elementPicker/protocol.js";
import { channelEvent } from "../../guestChannel.js";
import { createPicker, type PickerHandle } from "../picker.js";
import type { PickerMode } from "../types.js";

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
  vi.unstubAllGlobals();
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

  it("stops listening and drops the overlay when switched to browse", () => {
    const handle = start();
    document.getElementById("first")!.click();
    runFrames();
    expect(handle.getOverlayRoot()?.host.isConnected).toBe(true);

    handle.setMode("browse");
    expect(handle.getOverlayRoot()).toBeNull();
    let pageClicks = 0;
    document.getElementById("second")!.addEventListener("click", () => {
      pageClicks += 1;
    });
    document.getElementById("second")!.click();
    expect(pageClicks).toBe(1);
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

    it("gives a description set off inside another's dispatch no answer of its own", () => {
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

      const [inner, outer] = ofType("selectionChanged");
      expect(inner?.observations[0]?.componentChain.components).toEqual([]);
      expect(outer?.observations[0]?.componentChain.components[0]?.rootElementIds).toEqual([
        outer?.observations[0]?.elementId,
      ]);
    });
  });

  it("describes the selection again when the host asks, and reports one the document removed", () => {
    const handle = start();
    const target = document.getElementById("first")!;
    target.click();
    handle.refresh();
    target.remove();
    runFrames();
    expect(ofType("selectionChanged").map((event) => event.cause)).toEqual([
      "user",
      "reselect",
      "document",
    ]);
    expect(ofType("selectionChanged").at(-1)?.observations).toEqual([]);
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
