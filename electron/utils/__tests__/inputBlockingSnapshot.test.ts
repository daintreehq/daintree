// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  captureInputBlockingSnapshot,
  parseInputBlockingSnapshot,
} from "../inputBlockingSnapshot.js";

// jsdom has no layout: hit-testing, rects and computed pointer-events are
// supplied here, while attributes and selectors come from the real document.
function capture(options: {
  hit?: Element | null;
  hitRect?: { width: number; height: number };
  pointerEvents?: string;
}) {
  const hit = options.hit === undefined ? document.body : options.hit;
  if (hit) {
    hit.getBoundingClientRect = () =>
      ({ ...(options.hitRect ?? { width: 10, height: 10 }) }) as DOMRect;
  }
  const doc = Object.assign(Object.create(document) as Document, {
    elementFromPoint: () => hit,
    querySelectorAll: (selector: string) => document.querySelectorAll(selector),
    hasFocus: () => true,
  });
  Object.defineProperty(doc, "documentElement", { value: document.documentElement });
  Object.defineProperty(doc, "body", { value: document.body });
  Object.defineProperty(doc, "visibilityState", { value: "visible" });
  return captureInputBlockingSnapshot(doc, {
    innerWidth: 1000,
    innerHeight: 800,
    getComputedStyle: () => ({ pointerEvents: options.pointerEvents ?? "auto" }),
  });
}

afterEach(() => {
  document.body.innerHTML = "";
  for (const el of [document.documentElement, document.body]) {
    for (const name of ["inert", "data-dragging", "data-overlay-claims", "data-scroll-locked"]) {
      el.removeAttribute(name);
    }
  }
});

describe("captureInputBlockingSnapshot", () => {
  it("reports a page nothing is blocking", () => {
    const snapshot = capture({});
    expect(snapshot).toMatchObject({
      bodyPointerEvents: "auto",
      rootInert: false,
      inertCount: 0,
      scrollLocked: false,
      modalCount: 0,
      overlayClaims: 0,
      dragging: false,
    });
  });

  it("sees the marks a modal Radix layer leaves on the page", () => {
    document.body.setAttribute("data-scroll-locked", "1");
    document.body.innerHTML =
      '<div role="dialog" aria-modal="true"></div><main inert></main><aside inert></aside>';
    const snapshot = capture({ pointerEvents: "none" });
    expect(snapshot.bodyPointerEvents).toBe("none");
    expect(snapshot.scrollLocked).toBe(true);
    expect(snapshot.modalCount).toBe(1);
    expect(snapshot.inertCount).toBe(2);
    expect(snapshot.rootInert).toBe(false);
  });

  it("flags inert on the root and reads the drag and overlay-claim markers", () => {
    document.body.setAttribute("inert", "");
    document.documentElement.dataset.dragging = "true";
    document.documentElement.dataset.overlayClaims = "3";
    const snapshot = capture({});
    expect(snapshot.rootInert).toBe(true);
    expect(snapshot.dragging).toBe(true);
    expect(snapshot.overlayClaims).toBe(3);
  });

  it("treats a malformed overlay-claim marker as none", () => {
    document.documentElement.dataset.overlayClaims = "lots";
    expect(capture({}).overlayClaims).toBe(0);
  });

  it("names the element under the centre by tag and role only", () => {
    const overlay = document.createElement("div");
    overlay.setAttribute("role", "presentation");
    overlay.setAttribute("aria-label", "secret label");
    overlay.textContent = "prompt text";
    document.body.appendChild(overlay);
    const snapshot = capture({ hit: overlay, hitRect: { width: 1000, height: 800 } });
    expect(snapshot.centerHit).toEqual({ tag: "div", role: "presentation", coversViewport: true });
    expect(JSON.stringify(snapshot)).not.toContain("secret");
    expect(JSON.stringify(snapshot)).not.toContain("prompt");
  });

  it("never carries an authored tag or role across", () => {
    const widget = document.createElement("customer-acme-board");
    widget.setAttribute("role", "private-project");
    document.body.appendChild(widget);
    const snapshot = capture({ hit: widget });
    expect(snapshot.centerHit).toEqual({ tag: "custom-element", coversViewport: false });
    expect(JSON.stringify(snapshot)).not.toContain("acme");
    expect(JSON.stringify(snapshot)).not.toContain("private");
  });

  it("maps an unexpected pointer-events value onto the fixed vocabulary", () => {
    expect(capture({ pointerEvents: "visiblePainted" }).bodyPointerEvents).toBe("other");
  });

  it("does not call a small element under the centre viewport-covering", () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    expect(capture({ hit: button }).centerHit).toEqual({ tag: "button", coversViewport: false });
  });

  it("reports no hit when the centre hits nothing", () => {
    expect(capture({ hit: null }).centerHit).toBeNull();
  });

  it("produces a snapshot the main-side parser accepts unchanged", () => {
    document.body.innerHTML = '<div role="dialog" aria-modal="true"></div>';
    const snapshot = capture({ pointerEvents: "none" });
    expect(parseInputBlockingSnapshot(snapshot)).toEqual(snapshot);
  });
});

describe("parseInputBlockingSnapshot", () => {
  const valid = {
    bodyPointerEvents: "none",
    rootInert: false,
    inertCount: 1,
    scrollLocked: true,
    modalCount: 1,
    overlayClaims: 2,
    dragging: false,
    visibility: "visible",
    focused: true,
    centerHit: { tag: "div", role: "dialog", coversViewport: true },
  };

  it("rebuilds the snapshot without fields the renderer added", () => {
    const parsed = parseInputBlockingSnapshot({
      ...valid,
      extra: "terminal output",
      centerHit: { ...valid.centerHit, text: "prompt body" },
    });
    expect(parsed).toEqual(valid);
  });

  it.each([
    ["a non-object", "nope"],
    ["an array", []],
    ["a negative count", { ...valid, inertCount: -1 }],
    ["a fractional count", { ...valid, modalCount: 1.5 }],
    ["a non-string token field", { ...valid, visibility: 1 }],
    ["a missing boolean", { ...valid, dragging: undefined }],
    ["a centre hit without a tag", { ...valid, centerHit: { coversViewport: true } }],
    ["a centre hit that is not an object", { ...valid, centerHit: "div" }],
  ])("rejects %s", (_label, value) => {
    expect(parseInputBlockingSnapshot(value)).toBeNull();
  });

  it("re-maps every string onto the capture vocabulary instead of trusting it", () => {
    const parsed = parseInputBlockingSnapshot({
      ...valid,
      bodyPointerEvents: "none; content: x",
      visibility: "customer acme",
      centerHit: { tag: "customer-acme", role: "private-project", coversViewport: false },
    });
    expect(parsed).toMatchObject({
      bodyPointerEvents: "other",
      visibility: "other",
      centerHit: { tag: "custom-element", coversViewport: false },
    });
    expect(JSON.stringify(parsed)).not.toMatch(/acme|private|content/);
  });

  it("re-maps a tag that is not a standard tag name", () => {
    const parsed = parseInputBlockingSnapshot({
      ...valid,
      centerHit: { tag: "x".repeat(40), coversViewport: false },
    });
    expect(parsed?.centerHit).toEqual({ tag: "other", coversViewport: false });
  });

  it("caps an implausible count", () => {
    expect(parseInputBlockingSnapshot({ ...valid, inertCount: 1e9 })?.inertCount).toBe(10_000);
  });

  it("accepts a page with no body", () => {
    expect(parseInputBlockingSnapshot({ ...valid, bodyPointerEvents: "" })?.bodyPointerEvents).toBe(
      ""
    );
  });
});
