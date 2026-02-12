/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { computeAutoSize, createAutoSize } from "../inputEditorExtensions";

describe("computeAutoSize", () => {
  it("snaps height to line height increments with epsilon tolerance", () => {
    // 45px content with 20px line height = (45-2)/20 = 2.15 lines → ceils to 3 lines = 60px
    const result = computeAutoSize(45, 20, 160, false);
    expect(result.next).toBe(60);
    expect(result.shouldScroll).toBe(false);
  });

  it("ensures minimum of one line height for empty documents", () => {
    const result = computeAutoSize(0, 20, 160, true);
    expect(result.next).toBe(20);
  });

  it("always returns single-line height for empty documents regardless of contentHeight", () => {
    // Even if contentHeight is inflated by zoom, empty doc should be single-line
    const result = computeAutoSize(25, 20, 160, true);
    expect(result.next).toBe(20);
    expect(result.shouldScroll).toBe(false);
  });

  it("handles fractional zoom-inflated heights near single-line boundary", () => {
    // 20.5px content (zoom-inflated single line) with 20px line height
    // (20.5 - 2) / 20 = 0.925 lines → ceils to 1 line = 20px
    const result = computeAutoSize(20.5, 20, 160, false);
    expect(result.next).toBe(20);
    expect(result.shouldScroll).toBe(false);
  });

  it("handles fractional zoom-inflated heights near two-line boundary", () => {
    // 21.5px content (zoom-inflated, just over one line) with 20px line height
    // (21.5 - 2) / 20 = 0.975 lines → ceils to 1 line = 20px
    const result = computeAutoSize(21.5, 20, 160, false);
    expect(result.next).toBe(20);
    expect(result.shouldScroll).toBe(false);
  });

  it("correctly rounds up to two lines when epsilon-adjusted height exceeds one line", () => {
    // 23px content with 20px line height
    // (23 - 2) / 20 = 1.05 lines → ceils to 2 lines = 40px
    const result = computeAutoSize(23, 20, 160, false);
    expect(result.next).toBe(40);
    expect(result.shouldScroll).toBe(false);
  });

  it("caps height at maxHeightPx", () => {
    const result = computeAutoSize(200, 20, 80, false);
    expect(result.next).toBe(80); // Capped at 80px
    expect(result.shouldScroll).toBe(true); // Content exceeds max
  });

  it("respects custom line height", () => {
    const result = computeAutoSize(50, 25, 160, false);
    expect(result.next).toBe(50); // (50-2)/25 = 1.92 → ceil to 2 lines = 50px
  });

  it("indicates scrolling when content exceeds max", () => {
    const result = computeAutoSize(100, 20, 80, false);
    expect(result.shouldScroll).toBe(true);
  });

  it("hides scrolling when content is below max", () => {
    const result = computeAutoSize(40, 20, 160, false);
    expect(result.shouldScroll).toBe(false);
  });

  it("handles edge case where contentHeight equals maxHeightPx", () => {
    const result = computeAutoSize(80, 20, 80, false);
    expect(result.next).toBe(80);
    expect(result.shouldScroll).toBe(false);
  });

  it("does not enable scroll for zoom-inflated height at max boundary", () => {
    // 161px content with maxHeight=160: epsilon-adjusted (161-2)/20 = 7.95 → 8 lines = 160px
    // Should not show scrollbar since snapped height (160) doesn't exceed max
    const result = computeAutoSize(161, 20, 160, false);
    expect(result.next).toBe(160);
    expect(result.shouldScroll).toBe(false);
  });

  it("handles edge case where maxHeightPx is less than lineHeightPx", () => {
    const result = computeAutoSize(50, 30, 20, false);
    expect(result.next).toBe(20); // Capped at max
    expect(result.shouldScroll).toBe(true);
  });

  it("guards against invalid lineHeightPx", () => {
    const result = computeAutoSize(50, 0, 100, false);
    expect(result.next).toBe(100);
    expect(result.shouldScroll).toBe(false);
  });
});

describe("createAutoSize integration", () => {
  it("sets height and hides overflow for small content", () => {
    const parent = document.createElement("div");
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "",
        extensions: [createAutoSize({ lineHeightPx: 10, maxHeightPx: 30 })],
      }),
    });

    // Stub contentHeight and requestMeasure to be synchronous
    Object.defineProperty(view, "contentHeight", { get: () => 25, configurable: true });
    const originalRequestMeasure = view.requestMeasure.bind(view);
    vi.spyOn(view, "requestMeasure").mockImplementation((measure: any) => {
      if (measure?.read && measure?.write) {
        const measured = measure.read();
        measure.write(measured);
      } else {
        originalRequestMeasure(measure);
      }
    });

    // Trigger update
    view.dispatch({ changes: { from: 0, insert: "hello" } });

    // 25px - 2 (epsilon) = 23px, 23/10 = 2.3 lines → rounds to 3 lines = 30px
    expect(view.dom.style.height).toBe("30px");
    expect(view.scrollDOM.style.overflowY).toBe("hidden");

    view.destroy();
  });

  it("caps height and shows overflow for large content", () => {
    const parent = document.createElement("div");
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "",
        extensions: [createAutoSize({ lineHeightPx: 10, maxHeightPx: 30 })],
      }),
    });

    // Stub contentHeight and requestMeasure
    Object.defineProperty(view, "contentHeight", { get: () => 50, configurable: true });
    const originalRequestMeasure = view.requestMeasure.bind(view);
    vi.spyOn(view, "requestMeasure").mockImplementation((measure: any) => {
      if (measure?.read && measure?.write) {
        const measured = measure.read();
        measure.write(measured);
      } else {
        originalRequestMeasure(measure);
      }
    });

    // Trigger update
    view.dispatch({ changes: { from: 0, insert: "hello world" } });

    // 50px / 10px = 5 lines = 50px, but capped at 30px
    expect(view.dom.style.height).toBe("30px");
    expect(view.scrollDOM.style.overflowY).toBe("auto");

    view.destroy();
  });

  it("updates height when content changes", () => {
    const parent = document.createElement("div");
    let currentHeight = 20;
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "",
        extensions: [createAutoSize({ lineHeightPx: 20, maxHeightPx: 160 })],
      }),
    });

    // Stub contentHeight and requestMeasure
    Object.defineProperty(view, "contentHeight", {
      get: () => currentHeight,
      configurable: true,
    });
    const originalRequestMeasure = view.requestMeasure.bind(view);
    vi.spyOn(view, "requestMeasure").mockImplementation((measure: any) => {
      if (measure?.read && measure?.write) {
        const measured = measure.read();
        measure.write(measured);
      } else {
        originalRequestMeasure(measure);
      }
    });

    // Initial update
    view.dispatch({ changes: { from: 0, insert: "line1" } });
    expect(view.dom.style.height).toBe("20px");

    // Increase content
    currentHeight = 60;
    view.dispatch({ changes: { from: 5, insert: "\nline2\nline3" } });
    expect(view.dom.style.height).toBe("60px");

    // Decrease content
    currentHeight = 40;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "short" } });
    expect(view.dom.style.height).toBe("40px");

    view.destroy();
  });

  it("handles scroll state flip when snapped height exceeds max", () => {
    const parent = document.createElement("div");
    let currentHeight = 29;
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "",
        extensions: [createAutoSize({ lineHeightPx: 10, maxHeightPx: 30 })],
      }),
    });

    Object.defineProperty(view, "contentHeight", {
      get: () => currentHeight,
      configurable: true,
    });
    const originalRequestMeasure = view.requestMeasure.bind(view);
    vi.spyOn(view, "requestMeasure").mockImplementation((measure: any) => {
      if (measure?.read && measure?.write) {
        const measured = measure.read();
        measure.write(measured);
      } else {
        originalRequestMeasure(measure);
      }
    });

    // Initial: 29px, (29-2)/10 = 2.7 → 3 lines = 30px, no scroll (snapped = 30, max = 30)
    view.dispatch({ changes: { from: 0, insert: "a" } });
    expect(view.dom.style.height).toBe("30px");
    expect(view.scrollDOM.style.overflowY).toBe("hidden");

    // Grow to 33px: (33-2)/10 = 3.1 → 4 lines = 40px > max, should scroll
    currentHeight = 33;
    view.dispatch({ changes: { from: 1, insert: "b" } });
    expect(view.dom.style.height).toBe("30px"); // Capped at max
    expect(view.scrollDOM.style.overflowY).toBe("auto"); // Now scrolling (snapped > max)

    view.destroy();
  });

  it("handles empty content (contentHeight = 0)", () => {
    const parent = document.createElement("div");
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "test",
        extensions: [createAutoSize({ lineHeightPx: 20, maxHeightPx: 160 })],
      }),
    });

    Object.defineProperty(view, "contentHeight", { get: () => 0, configurable: true });
    const originalRequestMeasure = view.requestMeasure.bind(view);
    vi.spyOn(view, "requestMeasure").mockImplementation((measure: any) => {
      if (measure?.read && measure?.write) {
        const measured = measure.read();
        measure.write(measured);
      } else {
        originalRequestMeasure(measure);
      }
    });

    // Delete all content to trigger update with contentHeight = 0
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });

    // Should enforce minimum of one line height for empty documents
    expect(view.dom.style.height).toBe("20px");
    expect(view.scrollDOM.style.overflowY).toBe("hidden");

    view.destroy();
  });

  it("handles zoom-inflated empty content", () => {
    const parent = document.createElement("div");
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "x",
        extensions: [createAutoSize({ lineHeightPx: 20, maxHeightPx: 160 })],
      }),
    });

    // Simulate zoom causing empty editor to measure 21px instead of 20px
    Object.defineProperty(view, "contentHeight", { get: () => 21, configurable: true });
    const originalRequestMeasure = view.requestMeasure.bind(view);
    vi.spyOn(view, "requestMeasure").mockImplementation((measure: any) => {
      if (measure?.read && measure?.write) {
        const measured = measure.read();
        measure.write(measured);
      } else {
        originalRequestMeasure(measure);
      }
    });

    // Trigger update by clearing to empty doc
    view.dispatch({ changes: { from: 0, to: 1, insert: "" } });

    // Empty doc should always be single-line, even with zoom-inflated contentHeight
    expect(view.dom.style.height).toBe("20px");
    expect(view.scrollDOM.style.overflowY).toBe("hidden");

    view.destroy();
  });

  it("no layout jump from empty to single character", () => {
    const parent = document.createElement("div");
    let currentHeight = 21; // Zoom-inflated empty height
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "x",
        extensions: [createAutoSize({ lineHeightPx: 20, maxHeightPx: 160 })],
      }),
    });

    Object.defineProperty(view, "contentHeight", {
      get: () => currentHeight,
      configurable: true,
    });
    const originalRequestMeasure = view.requestMeasure.bind(view);
    vi.spyOn(view, "requestMeasure").mockImplementation((measure: any) => {
      if (measure?.read && measure?.write) {
        const measured = measure.read();
        measure.write(measured);
      } else {
        originalRequestMeasure(measure);
      }
    });

    // Clear to empty state: should be 20px
    view.dispatch({ changes: { from: 0, to: 1, insert: "" } });
    expect(view.dom.style.height).toBe("20px");

    // Add one character, still zoom-inflated to 21px
    currentHeight = 21;
    view.dispatch({ changes: { from: 0, insert: "a" } });

    // Single character with 21px height and epsilon: (21-2)/20 = 0.95 → 1 line = 20px
    expect(view.dom.style.height).toBe("20px");

    view.destroy();
  });
});
