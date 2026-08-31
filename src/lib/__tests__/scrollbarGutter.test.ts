// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SCROLLBAR_GUTTER_VAR,
  measureScrollbarGutter,
  publishScrollbarGutter,
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

  it("measures the probe while it is in the document — a detached box has no layout", () => {
    let connectedWhenMeasured: boolean | null = null;
    stubProbeBox((probe) => {
      connectedWhenMeasured = probe.isConnected;
      return { offsetWidth: 100, clientWidth: 89 };
    });

    measureScrollbarGutter();

    expect(connectedWhenMeasured).toBe(true);
  });

  it("leaves no probe behind", () => {
    stubGutter(11);
    const before = document.body.childElementCount;

    measureScrollbarGutter();

    expect(document.body.childElementCount).toBe(before);
  });

  it("leaves no probe behind when the measurement throws", () => {
    stubProbeBox(() => {
      throw new Error("layout exploded");
    });
    const before = document.body.childElementCount;

    expect(() => measureScrollbarGutter()).toThrow("layout exploded");
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
