// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { getElementBoundsAsDip, getSidecarPlaceholderBounds } from "../sidecarBounds";

describe("sidecarBounds", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, "electron", {
      value: { window: { getZoomFactor: vi.fn(() => 1) } },
      configurable: true,
      writable: true,
    });
  });

  describe("getElementBoundsAsDip", () => {
    it("returns null for null element", () => {
      expect(getElementBoundsAsDip(null)).toBeNull();
    });

    it("returns rounded bounds at zoom=1", () => {
      const el = mockElement(10.4, 20.6, 300.2, 400.8);
      const result = getElementBoundsAsDip(el);
      expect(result).toEqual({ x: 10, y: 21, width: 301, height: 401 });
    });

    it("scales bounds by zoom factor 1.5", () => {
      (
        window.electron as { window: { getZoomFactor: ReturnType<typeof vi.fn> } }
      ).window.getZoomFactor.mockReturnValue(1.5);
      const el = mockElement(10, 20, 300, 400);
      const result = getElementBoundsAsDip(el);
      expect(result).toEqual({ x: 15, y: 30, width: 450, height: 600 });
    });

    it("scales bounds by zoom factor 0.5", () => {
      (
        window.electron as { window: { getZoomFactor: ReturnType<typeof vi.fn> } }
      ).window.getZoomFactor.mockReturnValue(0.5);
      const el = mockElement(10, 20, 300, 400);
      const result = getElementBoundsAsDip(el);
      expect(result).toEqual({ x: 5, y: 10, width: 150, height: 200 });
    });

    it("uses Math.round for x/y and Math.ceil for width/height", () => {
      (
        window.electron as { window: { getZoomFactor: ReturnType<typeof vi.fn> } }
      ).window.getZoomFactor.mockReturnValue(1.5);
      const el = mockElement(10.4, 20.6, 300.2, 400.8);
      const result = getElementBoundsAsDip(el);
      expect(result).toEqual({
        x: Math.round(10.4 * 1.5),
        y: Math.round(20.6 * 1.5),
        width: Math.ceil(300.2 * 1.5),
        height: Math.ceil(400.8 * 1.5),
      });
    });

    it("falls back to zoom=1 when getZoomFactor is missing", () => {
      Object.defineProperty(window, "electron", {
        value: { window: {} },
        configurable: true,
        writable: true,
      });
      const el = mockElement(10, 20, 300, 400);
      const result = getElementBoundsAsDip(el);
      expect(result).toEqual({ x: 10, y: 20, width: 300, height: 400 });
    });

    it("falls back to zoom=1 when getZoomFactor returns NaN", () => {
      (
        window.electron as { window: { getZoomFactor: ReturnType<typeof vi.fn> } }
      ).window.getZoomFactor.mockReturnValue(NaN);
      const el = mockElement(10, 20, 300, 400);
      const result = getElementBoundsAsDip(el);
      expect(result).toEqual({ x: 10, y: 20, width: 300, height: 400 });
    });

    it("falls back to zoom=1 when getZoomFactor returns negative", () => {
      (
        window.electron as { window: { getZoomFactor: ReturnType<typeof vi.fn> } }
      ).window.getZoomFactor.mockReturnValue(-1);
      const el = mockElement(10, 20, 300, 400);
      const result = getElementBoundsAsDip(el);
      expect(result).toEqual({ x: 10, y: 20, width: 300, height: 400 });
    });

    it("falls back to zoom=1 when window.electron is undefined", () => {
      Object.defineProperty(window, "electron", {
        value: undefined,
        configurable: true,
        writable: true,
      });
      const el = mockElement(10, 20, 300, 400);
      const result = getElementBoundsAsDip(el);
      expect(result).toEqual({ x: 10, y: 20, width: 300, height: 400 });
    });

    it("falls back to zoom=1 when getZoomFactor throws", () => {
      (
        window.electron as { window: { getZoomFactor: ReturnType<typeof vi.fn> } }
      ).window.getZoomFactor.mockImplementation(() => {
        throw new Error("not available");
      });
      const el = mockElement(10, 20, 300, 400);
      const result = getElementBoundsAsDip(el);
      expect(result).toEqual({ x: 10, y: 20, width: 300, height: 400 });
    });

    it("handles zero-dimension elements", () => {
      const el = mockElement(50, 60, 0, 0);
      const result = getElementBoundsAsDip(el);
      expect(result).toEqual({ x: 50, y: 60, width: 0, height: 0 });
    });
  });

  describe("getSidecarPlaceholderBounds", () => {
    it("returns null when placeholder is not in DOM", () => {
      expect(getSidecarPlaceholderBounds()).toBeNull();
    });

    it("returns bounds when placeholder exists", () => {
      const placeholder = document.createElement("div");
      placeholder.id = "sidecar-placeholder";
      document.body.appendChild(placeholder);
      vi.spyOn(placeholder, "getBoundingClientRect").mockReturnValue(
        makeDOMRect(100, 200, 500, 600)
      );
      const result = getSidecarPlaceholderBounds();
      expect(result).toEqual({ x: 100, y: 200, width: 500, height: 600 });
      document.body.removeChild(placeholder);
    });

    it("applies zoom factor to placeholder bounds", () => {
      (
        window.electron as { window: { getZoomFactor: ReturnType<typeof vi.fn> } }
      ).window.getZoomFactor.mockReturnValue(1.5);
      const placeholder = document.createElement("div");
      placeholder.id = "sidecar-placeholder";
      document.body.appendChild(placeholder);
      vi.spyOn(placeholder, "getBoundingClientRect").mockReturnValue(
        makeDOMRect(100, 200, 500, 600)
      );
      const result = getSidecarPlaceholderBounds();
      expect(result).toEqual({ x: 150, y: 300, width: 750, height: 900 });
      document.body.removeChild(placeholder);
    });
  });
});

function mockElement(x: number, y: number, width: number, height: number): Element {
  return {
    getBoundingClientRect: () => makeDOMRect(x, y, width, height),
  } as unknown as Element;
}

function makeDOMRect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  };
}
