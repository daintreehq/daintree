// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SCROLLBAR_GUTTER_VAR,
  measureScrollbarGutter,
  publishScrollbarGutter,
  watchScrollbarGutter,
} from "../scrollbarGutter";

/**
 * jsdom has no layout, so the probe's box metrics are stubbed. That is the
 * whole point of these tests: the arithmetic and the DOM bookkeeping around the
 * measurement are what can regress, and both are testable without a real
 * engine. The pixel figure itself is a platform property — no unit test can
 * assert it, and one that hardcoded 11px would be re-asserting the bug #12101
 * was filed for.
 */

const restore: (() => void)[] = [];

function stubProbeBox(read: (probe: HTMLElement) => { offsetWidth: number; clientWidth: number }) {
  const offset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  const client = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth");

  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return read(this).offsetWidth;
    },
  });
  Object.defineProperty(Element.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return read(this).clientWidth;
    },
  });

  restore.push(() => {
    if (offset) Object.defineProperty(HTMLElement.prototype, "offsetWidth", offset);
    if (client) Object.defineProperty(Element.prototype, "clientWidth", client);
  });
}

/** A fixed gutter of `gutter` px, whatever the probe looks like. */
function stubGutter(gutter: number) {
  stubProbeBox(() => ({ offsetWidth: 100, clientWidth: 100 - gutter }));
}

afterEach(() => {
  for (const undo of restore.splice(0)) undo();
  document.documentElement.style.removeProperty(SCROLLBAR_GUTTER_VAR);
  vi.restoreAllMocks();
});

describe("measureScrollbarGutter", () => {
  it("reports the difference between the probe's border box and its content box", () => {
    stubGutter(11);
    expect(measureScrollbarGutter()).toBe(11);
  });

  it("reports 0 under overlay scrollbars, which reserve nothing", () => {
    stubGutter(0);
    expect(measureScrollbarGutter()).toBe(0);
  });

  it("clamps a negative difference to 0", () => {
    stubProbeBox(() => ({ offsetWidth: 100, clientWidth: 120 }));
    expect(measureScrollbarGutter()).toBe(0);
  });

  it("measures a dedicated probe, in the document and configured to reserve a gutter", () => {
    // The stub answers for ANY element, so without pinning down *which* element
    // was read, an implementation that measured `document.body` — or a probe
    // missing `overflow: scroll` and thus reserving nothing — would pass every
    // other test here and still report 0 on Windows.
    const reads: { el: Element; connected: boolean; style: string | null }[] = [];
    stubProbeBox((probe) => {
      reads.push({ el: probe, connected: probe.isConnected, style: probe.getAttribute("style") });
      return { offsetWidth: 100, clientWidth: 89 };
    });

    expect(measureScrollbarGutter()).toBe(11);

    expect(reads.length, "both box metrics must be read").toBeGreaterThanOrEqual(2);
    const probe = reads[0]!.el;
    expect(
      reads.every((read) => read.el === probe),
      "both metrics must come off the same element"
    ).toBe(true);
    expect(probe).not.toBe(document.body);
    expect(probe).not.toBe(document.documentElement);
    expect(probe.tagName).toBe("DIV");

    expect(
      reads.every((read) => read.connected),
      "a detached element has no layout, so the gutter would read as 0 everywhere"
    ).toBe(true);

    const style = reads[0]!.style ?? "";
    // Each of these is load-bearing: drop one and the probe measures nothing.
    expect(style, "must force a scrollbar to be reserved").toMatch(/overflow:\s*scroll/);
    expect(style, "one gutter, not two").toMatch(/scrollbar-gutter:\s*stable(?!\s+both-edges)/);
    expect(style, "must match what dialog bodies inherit").toMatch(/scrollbar-width:\s*thin/);
    expect(style, "needs a real box to put a scrollbar in").toMatch(/width:\s*100px/);
    expect(style, "border and padding would be counted as gutter").toMatch(/border:\s*0/);
    expect(style).toMatch(/padding:\s*0/);

    expect(probe.isConnected, "the probe must not outlive the measurement").toBe(false);
  });

  it("leaves no probe behind", () => {
    stubGutter(11);
    const before = document.body.childElementCount;

    measureScrollbarGutter();

    expect(document.body.childElementCount).toBe(before);
  });

  it("leaves no probe behind when the measurement throws", () => {
    let probe: Element | null = null;
    stubProbeBox((el) => {
      probe = el;
      throw new Error("layout exploded");
    });
    const before = document.body.childElementCount;

    expect(() => measureScrollbarGutter()).toThrow("layout exploded");

    // Not just a body-count check: that would pass if the probe were never
    // appended at all. The element that threw must have been attached, and
    // must have been taken back out by the `finally`.
    expect(probe, "the probe must have been measured").not.toBeNull();
    expect((probe as unknown as Element).isConnected).toBe(false);
    expect(document.body.childElementCount).toBe(before);
  });
});

describe("publishScrollbarGutter", () => {
  it("writes the measured gutter to the document root as px", () => {
    stubGutter(11);

    expect(publishScrollbarGutter()).toBe(11);
    expect(document.documentElement.style.getPropertyValue(SCROLLBAR_GUTTER_VAR)).toBe("11px");
  });

  it("publishes 0px rather than leaving the property unset", () => {
    stubGutter(0);

    publishScrollbarGutter();

    expect(document.documentElement.style.getPropertyValue(SCROLLBAR_GUTTER_VAR)).toBe("0px");
  });

  it("publishes a gutter wider than the dialog column unchanged — CSS owns the clamp", () => {
    stubGutter(30);

    publishScrollbarGutter();

    expect(document.documentElement.style.getPropertyValue(SCROLLBAR_GUTTER_VAR)).toBe("30px");
  });

  it("does not rewrite the property when the figure has not moved", () => {
    stubGutter(11);
    publishScrollbarGutter();

    const setProperty = vi.spyOn(document.documentElement.style, "setProperty");
    publishScrollbarGutter();
    publishScrollbarGutter();

    expect(setProperty).not.toHaveBeenCalled();
  });

  it("rewrites the property when the platform's gutter changes under it", () => {
    stubGutter(0);
    publishScrollbarGutter();
    expect(document.documentElement.style.getPropertyValue(SCROLLBAR_GUTTER_VAR)).toBe("0px");

    for (const undo of restore.splice(0)) undo();
    stubGutter(11);

    expect(publishScrollbarGutter()).toBe(11);
    expect(document.documentElement.style.getPropertyValue(SCROLLBAR_GUTTER_VAR)).toBe("11px");
  });
});

describe("watchScrollbarGutter", () => {
  it("re-publishes on focus, so a dialog that is already open does not stay stale", () => {
    stubGutter(0);
    const stop = watchScrollbarGutter();
    publishScrollbarGutter();
    expect(document.documentElement.style.getPropertyValue(SCROLLBAR_GUTTER_VAR)).toBe("0px");

    for (const undo of restore.splice(0)) undo();
    stubGutter(11);
    window.dispatchEvent(new Event("focus"));

    expect(document.documentElement.style.getPropertyValue(SCROLLBAR_GUTTER_VAR)).toBe("11px");
    stop();
  });

  it("stops measuring once disposed", () => {
    stubGutter(0);
    const stop = watchScrollbarGutter();
    publishScrollbarGutter();
    stop();

    for (const undo of restore.splice(0)) undo();
    stubGutter(11);
    window.dispatchEvent(new Event("focus"));

    expect(document.documentElement.style.getPropertyValue(SCROLLBAR_GUTTER_VAR)).toBe("0px");
  });
});
