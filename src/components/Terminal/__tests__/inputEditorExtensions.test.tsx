/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { computeAutoSize, createAutoSize } from "../inputEditorExtensions";

describe("computeAutoSize", () => {
  it("snaps height to line height increments", () => {
    // 45px content with 20px line height = 2.25 lines → ceils to 3 lines = 60px
    const result = computeAutoSize(45, 20, 160);
    expect(result.next).toBe(60);
    expect(result.shouldScroll).toBe(false);
  });

  it("ensures minimum of one line height", () => {
    const result = computeAutoSize(0, 20, 160);
    expect(result.next).toBe(20);
  });

  it("caps height at maxHeightPx", () => {
    const result = computeAutoSize(200, 20, 80);
    expect(result.next).toBe(80); // Capped at 80px
    expect(result.shouldScroll).toBe(true); // Content exceeds max
  });

  it("respects custom line height", () => {
    const result = computeAutoSize(50, 25, 160);
    expect(result.next).toBe(50); // 50px / 25px = 2 lines exactly
  });

  it("indicates scrolling when content exceeds max", () => {
    const result = computeAutoSize(100, 20, 80);
    expect(result.shouldScroll).toBe(true);
  });

  it("hides scrolling when content is below max", () => {
    const result = computeAutoSize(40, 20, 160);
    expect(result.shouldScroll).toBe(false);
  });

  it("uses Math.ceil to avoid clipping partial lines", () => {
    // 45px with 20px lines = 2.25 lines, should round up to 3 lines = 60px
    const result = computeAutoSize(45, 20, 160);
    expect(result.next).toBe(60); // Ceil to avoid clipping
  });

  it("handles edge case where contentHeight equals maxHeightPx", () => {
    const result = computeAutoSize(80, 20, 80);
    expect(result.next).toBe(80);
    expect(result.shouldScroll).toBe(false);
  });

  it("handles edge case where maxHeightPx is less than lineHeightPx", () => {
    const result = computeAutoSize(50, 30, 20);
    expect(result.next).toBe(20); // Capped at max
    expect(result.shouldScroll).toBe(true);
  });

  it("guards against invalid lineHeightPx", () => {
    const result = computeAutoSize(50, 0, 100);
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

    // 25px / 10px = 2.5 lines → rounds to 3 lines = 30px (but capped at 30)
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

  it("handles scroll state flip when height remains capped", () => {
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

    // Initial: 29px, below max, no scroll
    view.dispatch({ changes: { from: 0, insert: "a" } });
    expect(view.dom.style.height).toBe("30px"); // Ceil(29/10) = 3 lines = 30px
    expect(view.scrollDOM.style.overflowY).toBe("hidden");

    // Grow to 31px, still capped at 30px, but now should scroll
    currentHeight = 31;
    view.dispatch({ changes: { from: 1, insert: "b" } });
    expect(view.dom.style.height).toBe("30px"); // Still capped
    expect(view.scrollDOM.style.overflowY).toBe("auto"); // Now scrolling

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

    // Should enforce minimum of one line height
    expect(view.dom.style.height).toBe("20px");
    expect(view.scrollDOM.style.overflowY).toBe("hidden");

    view.destroy();
  });
});
