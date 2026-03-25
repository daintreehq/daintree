/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import type { ITheme } from "@xterm/xterm";
import {
  buildInputBarTheme,
  computeAutoSize,
  createAutoSize,
  createCustomKeymap,
  createFileChipField,
  fileDropChipField,
  addFileDropChip,
  createFilePasteHandler,
  interimMarkField,
  setInterimRange,
  pendingAIField,
  setPendingAIRanges,
  diffChipField,
  terminalChipField,
  selectionChipField,
  formatFileSize,
} from "../inputEditorExtensions";
import { resolveInputBarColors } from "@/utils/terminalTheme";

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

  it("uses view.defaultLineHeight when no lineHeightPx is configured", () => {
    // Simulates the chip-decorated line bug: when createAutoSize() is called without an
    // explicit lineHeightPx (as in production), it should use view.defaultLineHeight (20px)
    // rather than any DOM-measured value. If a chip made a .cm-line appear 28px tall, the
    // old DOM-measurement approach would have snapped to the wrong height.
    const parent = document.createElement("div");
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "",
        // No lineHeightPx — production call site. defaultLineHeight (mocked to 20) should govern.
        extensions: [createAutoSize({ maxHeightPx: 160 })],
      }),
    });

    // Simulate 4 visual lines at 20px each
    Object.defineProperty(view, "contentHeight", { get: () => 80, configurable: true });
    Object.defineProperty(view, "defaultLineHeight", { get: () => 20, configurable: true });

    const originalRequestMeasure = view.requestMeasure.bind(view);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(view, "requestMeasure").mockImplementation((measure: any) => {
      if (measure?.read && measure?.write) {
        const measured = measure.read();
        measure.write(measured);
      } else {
        originalRequestMeasure(measure);
      }
    });

    view.dispatch({ changes: { from: 0, insert: "wrapped content" } });

    // With defaultLineHeight=20: (80-2)/20 = 3.9 → ceil=4 → 80px (correct)
    expect(view.dom.style.height).toBe("80px");

    view.destroy();
  });

  it("overflowY write is idempotent — same value does not re-write style", () => {
    // Verifies that writing the same overflowY value repeatedly does not trigger
    // unnecessary DOM mutations (which would cause a geometry-changed re-entry loop).
    const parent = document.createElement("div");
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "",
        extensions: [createAutoSize({ lineHeightPx: 20, maxHeightPx: 160 })],
      }),
    });

    Object.defineProperty(view, "contentHeight", { get: () => 40, configurable: true });

    const originalRequestMeasure = view.requestMeasure.bind(view);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(view, "requestMeasure").mockImplementation((measure: any) => {
      if (measure?.read && measure?.write) {
        const measured = measure.read();
        measure.write(measured);
      } else {
        originalRequestMeasure(measure);
      }
    });

    const scrollDOM = view.scrollDOM;
    // Track how many times overflowY is actually written to the DOM
    let overflowWriteCount = 0;
    let currentOverflowY = "";
    Object.defineProperty(scrollDOM.style, "overflowY", {
      get() {
        return currentOverflowY;
      },
      set(val: string) {
        overflowWriteCount++;
        currentOverflowY = val;
      },
      configurable: true,
    });

    // First dispatch — should write overflowY once ("hidden")
    view.dispatch({ changes: { from: 0, insert: "a" } });
    // Confirm the spy captured the first write (validates spy is active)
    expect(overflowWriteCount).toBe(1);

    // Second dispatch with same contentHeight — overflowY value unchanged, should NOT re-write
    view.dispatch({ changes: { from: 1, insert: "b" } });
    expect(overflowWriteCount).toBe(1);

    view.destroy();
  });

  it("near-wrap-boundary: adding exactly one newline snaps height up by one line only", () => {
    // Regression test for the core bug: tests the production code path (no explicit lineHeightPx)
    // where view.defaultLineHeight governs the snap increment. With the old DOM-measurement
    // approach a chip-decorated line could inflate the increment, causing a multi-line jump.
    const parent = document.createElement("div");
    let currentContentHeight = 60; // 3 visual lines at 20px each

    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "",
        // No lineHeightPx — matches the production call site in HybridInputBar.tsx
        extensions: [createAutoSize({ maxHeightPx: 160 })],
      }),
    });

    Object.defineProperty(view, "contentHeight", {
      get: () => currentContentHeight,
      configurable: true,
    });
    // Stub defaultLineHeight to 20px — this is what the production code path uses when no
    // lineHeightPx is explicitly configured. With the old DOM-measurement approach, a chip
    // decoration could make this 28px, causing the snap to wrongly jump to 100px instead of 80px.
    Object.defineProperty(view, "defaultLineHeight", { get: () => 20, configurable: true });

    const originalRequestMeasure = view.requestMeasure.bind(view);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(view, "requestMeasure").mockImplementation((measure: any) => {
      if (measure?.read && measure?.write) {
        const measured = measure.read();
        measure.write(measured);
      } else {
        originalRequestMeasure(measure);
      }
    });

    // Establish baseline: 3 visual lines = 60px (simulates wrapped text before newline)
    view.dispatch({ changes: { from: 0, insert: "line1\nline2" } });
    expect(view.dom.style.height).toBe("60px");

    // User presses Shift+Enter: content grows to 4 visual lines (80px)
    currentContentHeight = 80;
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\n" } });

    // Should snap to exactly 80px (4 lines × 20px), not 100px or 120px
    // Old behavior with chip-inflated lineHeight=28: (80-2)/28=2.79 → ceil=3 → 84px (wrong)
    expect(view.dom.style.height).toBe("80px");

    view.destroy();
  });
});

describe("createCustomKeymap", () => {
  function makeView(onEnter: () => boolean) {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    return new EditorView({
      parent,
      state: EditorState.create({
        doc: "hello",
        extensions: [
          createCustomKeymap({
            onEnter,
            onEscape: () => false,
            onArrowUp: () => false,
            onArrowDown: () => false,
            onArrowLeft: () => false,
            onArrowRight: () => false,
            onTab: () => false,
            onCtrlC: () => false,
            onStash: () => false,
            onPopStash: () => false,
            onExpand: () => false,
            onHistorySearch: () => false,
          }),
        ],
      }),
    });
  }

  it("Enter calls onEnter and does not insert newline", () => {
    const onEnter = vi.fn(() => true);
    const view = makeView(onEnter);

    runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Enter" }), "editor");

    expect(onEnter).toHaveBeenCalledOnce();
    expect(view.state.doc.toString()).toBe("hello");
    view.destroy();
  });

  it("Shift+Enter inserts newline without calling onEnter", () => {
    const onEnter = vi.fn(() => true);
    const view = makeView(onEnter);

    runScopeHandlers(
      view,
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: true }),
      "editor"
    );

    expect(onEnter).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toContain("\n");
    view.destroy();
  });

  it("Alt+Enter inserts newline without calling onEnter", () => {
    const onEnter = vi.fn(() => true);
    const view = makeView(onEnter);

    runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Enter", altKey: true }), "editor");

    expect(onEnter).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toContain("\n");
    view.destroy();
  });
});

describe("fileDropChipField", () => {
  function makeEditorWithFileChip() {
    const parent = document.createElement("div");
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "",
        extensions: [fileDropChipField],
      }),
    });
    return view;
  }

  it("adds a file chip entry via addFileDropChip effect", () => {
    const view = makeEditorWithFileChip();

    view.dispatch({
      changes: { from: 0, insert: "@/Users/test/file.ts " },
      effects: addFileDropChip.of({
        from: 0,
        to: 20,
        filePath: "/Users/test/file.ts",
        fileName: "file.ts",
      }),
    });

    const entries = view.state.field(fileDropChipField);
    expect(entries).toHaveLength(1);
    expect(entries[0].filePath).toBe("/Users/test/file.ts");
    expect(entries[0].fileName).toBe("file.ts");
    expect(entries[0].from).toBe(0);
    expect(entries[0].to).toBe(20);

    view.destroy();
  });

  it("maps chip positions through document changes before the chip", () => {
    const view = makeEditorWithFileChip();

    view.dispatch({
      changes: { from: 0, insert: "@/Users/test/file.ts " },
      effects: addFileDropChip.of({
        from: 0,
        to: 20,
        filePath: "/Users/test/file.ts",
        fileName: "file.ts",
      }),
    });

    // Insert text before the chip
    view.dispatch({
      changes: { from: 0, insert: "prefix " },
    });

    const entries = view.state.field(fileDropChipField);
    expect(entries).toHaveLength(1);
    expect(entries[0].from).toBe(7); // shifted by "prefix " (7 chars)
    expect(entries[0].to).toBe(27);

    view.destroy();
  });

  it("discards chip when its range is edited", () => {
    const view = makeEditorWithFileChip();

    view.dispatch({
      changes: { from: 0, insert: "@/Users/test/file.ts " },
      effects: addFileDropChip.of({
        from: 0,
        to: 20,
        filePath: "/Users/test/file.ts",
        fileName: "file.ts",
      }),
    });

    // Edit within the chip range
    view.dispatch({
      changes: { from: 5, to: 10, insert: "X" },
    });

    const entries = view.state.field(fileDropChipField);
    expect(entries).toHaveLength(0);

    view.destroy();
  });

  it("supports multiple file chip entries", () => {
    const view = makeEditorWithFileChip();

    const text = "@/Users/test/a.ts @/Users/test/b.ts ";
    view.dispatch({
      changes: { from: 0, insert: text },
      effects: [
        addFileDropChip.of({
          from: 0,
          to: 17,
          filePath: "/Users/test/a.ts",
          fileName: "a.ts",
        }),
        addFileDropChip.of({
          from: 18,
          to: 35,
          filePath: "/Users/test/b.ts",
          fileName: "b.ts",
        }),
      ],
    });

    const entries = view.state.field(fileDropChipField);
    expect(entries).toHaveLength(2);
    expect(entries[0].fileName).toBe("a.ts");
    expect(entries[1].fileName).toBe("b.ts");

    view.destroy();
  });

  it("removes file chips when the entire document is cleared", () => {
    const view = makeEditorWithFileChip();

    view.dispatch({
      changes: { from: 0, insert: "@/Users/test/file.ts " },
      effects: addFileDropChip.of({
        from: 0,
        to: 20,
        filePath: "/Users/test/file.ts",
        fileName: "file.ts",
      }),
    });

    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "" },
    });

    expect(view.state.doc.length).toBe(0);
    expect(view.state.field(fileDropChipField)).toHaveLength(0);

    view.destroy();
  });

  it("preserves raw @path text in document for agent consumption", () => {
    const view = makeEditorWithFileChip();

    view.dispatch({
      changes: { from: 0, insert: "@/Users/test/file.ts " },
      effects: addFileDropChip.of({
        from: 0,
        to: 20,
        filePath: "/Users/test/file.ts",
        fileName: "file.ts",
      }),
    });

    expect(view.state.doc.toString()).toBe("@/Users/test/file.ts ");

    view.destroy();
  });
});

describe("createFilePasteHandler", () => {
  function makeMockClipboardData(items: { kind: string; type: string; file: File | null }[]) {
    const mockItems = items.map((item) => ({
      kind: item.kind,
      type: item.type,
      getAsFile: () => item.file,
    }));
    return {
      clipboardData: {
        items: mockItems,
        getData: () => "",
        types: [] as string[],
      },
    };
  }

  function makePasteEvent(clipboardData: unknown): ClipboardEvent {
    const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", { value: clipboardData });
    return event;
  }

  it("calls onFilePaste for non-image file items with a path", () => {
    const originalElectron = window.electron;
    (window as unknown as Record<string, unknown>).electron = {
      ...window.electron,
      webUtils: {
        getPathForFile: (file: File) => (file as unknown as { _testPath?: string })._testPath ?? "",
      },
    };

    const onFilePaste = vi.fn();
    const parent = document.createElement("div");
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "",
        extensions: [createFilePasteHandler(onFilePaste)],
      }),
    });

    const file = new File(["content"], "test.pdf", { type: "application/pdf" });
    Object.defineProperty(file, "_testPath", { value: "/Users/test/test.pdf" });

    const mockData = makeMockClipboardData([{ kind: "file", type: "application/pdf", file }]);
    const pasteEvent = makePasteEvent(mockData.clipboardData);

    view.contentDOM.dispatchEvent(pasteEvent);

    expect(onFilePaste).toHaveBeenCalledOnce();
    expect(onFilePaste).toHaveBeenCalledWith(view, [
      { path: "/Users/test/test.pdf", name: "test.pdf", size: 7 },
    ]);

    view.destroy();
    (window as unknown as Record<string, unknown>).electron = originalElectron;
  });

  it("does not call onFilePaste for image file items", () => {
    const onFilePaste = vi.fn();
    const parent = document.createElement("div");
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "",
        extensions: [createFilePasteHandler(onFilePaste)],
      }),
    });

    const file = new File(["imagedata"], "screenshot.png", { type: "image/png" });
    Object.defineProperty(file, "path", { value: "/Users/test/screenshot.png" });

    const mockData = makeMockClipboardData([{ kind: "file", type: "image/png", file }]);
    const pasteEvent = makePasteEvent(mockData.clipboardData);

    view.contentDOM.dispatchEvent(pasteEvent);

    expect(onFilePaste).not.toHaveBeenCalled();

    view.destroy();
  });

  it("does not call onFilePaste for files without a path", () => {
    const originalElectron = window.electron;
    (window as unknown as Record<string, unknown>).electron = {
      ...window.electron,
      webUtils: {
        getPathForFile: () => "",
      },
    };

    const onFilePaste = vi.fn();
    const parent = document.createElement("div");
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "",
        extensions: [createFilePasteHandler(onFilePaste)],
      }),
    });

    const file = new File(["content"], "test.txt", { type: "text/plain" });

    const mockData = makeMockClipboardData([{ kind: "file", type: "text/plain", file }]);
    const pasteEvent = makePasteEvent(mockData.clipboardData);

    view.contentDOM.dispatchEvent(pasteEvent);

    expect(onFilePaste).not.toHaveBeenCalled();

    view.destroy();
    (window as unknown as Record<string, unknown>).electron = originalElectron;
  });
});

describe("interimMarkField", () => {
  function makeView(doc = "") {
    const parent = document.createElement("div");
    return new EditorView({
      parent,
      state: EditorState.create({ doc, extensions: [interimMarkField] }),
    });
  }

  it("applies interim mark decoration for the given range", () => {
    const view = makeView("hello world");
    view.dispatch({ effects: setInterimRange.of({ from: 6, to: 11 }) });

    const decos = view.state.field(interimMarkField);
    const iter = decos.iter();
    expect(iter.value).not.toBeNull();
    expect(iter.from).toBe(6);
    expect(iter.to).toBe(11);
    view.destroy();
  });

  it("clears interim mark when null is dispatched", () => {
    const view = makeView("hello world");
    view.dispatch({ effects: setInterimRange.of({ from: 0, to: 5 }) });
    view.dispatch({ effects: setInterimRange.of(null) });

    const decos = view.state.field(interimMarkField);
    const iter = decos.iter();
    expect(iter.value).toBeNull();
    view.destroy();
  });

  it("does not expand mark past boundary on insert at the end", () => {
    const view = makeView("hello");
    view.dispatch({ effects: setInterimRange.of({ from: 0, to: 5 }) });
    // Insert text at the end of the marked range
    view.dispatch({ changes: { from: 5, insert: " world" } });

    const decos = view.state.field(interimMarkField);
    const iter = decos.iter();
    expect(iter.value).not.toBeNull();
    // Mark should still end at 5 (mapped through change), not expand to include " world"
    expect(iter.from).toBe(0);
    expect(iter.to).toBe(5);
    view.destroy();
  });

  it("maps mark range through document changes", () => {
    const view = makeView("hello world");
    view.dispatch({ effects: setInterimRange.of({ from: 6, to: 11 }) });
    // Insert "XX" at position 0
    view.dispatch({ changes: { from: 0, insert: "XX" } });

    const decos = view.state.field(interimMarkField);
    const iter = decos.iter();
    expect(iter.value).not.toBeNull();
    expect(iter.from).toBe(8); // shifted by 2
    expect(iter.to).toBe(13);
    view.destroy();
  });

  it("handles simultaneous doc change and clear effect correctly (map-before-effect)", () => {
    const view = makeView("hello");
    view.dispatch({ effects: setInterimRange.of({ from: 0, to: 5 }) });

    // Single transaction: insert text AND clear the mark
    view.dispatch({
      changes: { from: 5, insert: " world" },
      effects: setInterimRange.of(null),
    });

    const decos = view.state.field(interimMarkField);
    const iter = decos.iter();
    expect(iter.value).toBeNull();
    view.destroy();
  });

  it("returns Decoration.none for invalid range (from >= to)", () => {
    const view = makeView("hello");
    view.dispatch({ effects: setInterimRange.of({ from: 5, to: 5 }) });

    const decos = view.state.field(interimMarkField);
    const iter = decos.iter();
    expect(iter.value).toBeNull();
    view.destroy();
  });
});

describe("pendingAIField", () => {
  function makeView(doc = "") {
    const parent = document.createElement("div");
    return new EditorView({
      parent,
      state: EditorState.create({ doc, extensions: [pendingAIField] }),
    });
  }

  it("applies mark decoration spanning the given range", () => {
    const view = makeView("hello world");
    view.dispatch({ effects: setPendingAIRanges.of([{ from: 0, to: 5 }]) });

    const decos = view.state.field(pendingAIField);
    const iter = decos.iter();
    expect(iter.value).not.toBeNull();
    expect(iter.from).toBe(0);
    expect(iter.to).toBe(5);
    view.destroy();
  });

  it("mark range shifts when text is inserted before it", () => {
    const view = makeView("hello");
    view.dispatch({ effects: setPendingAIRanges.of([{ from: 0, to: 5 }]) });
    view.dispatch({ changes: { from: 0, insert: "say " } });

    const decos = view.state.field(pendingAIField);
    const iter = decos.iter();
    expect(iter.value).not.toBeNull();
    expect(iter.from).toBe(4);
    expect(iter.to).toBe(9);
    view.destroy();
  });

  it("clears cleanly when empty ranges dispatched", () => {
    const view = makeView("hello");
    view.dispatch({ effects: setPendingAIRanges.of([{ from: 0, to: 5 }]) });
    view.dispatch({ effects: setPendingAIRanges.of([]) });

    const decos = view.state.field(pendingAIField);
    const iter = decos.iter();
    expect(iter.value).toBeNull();
    view.destroy();
  });

  it("supports multiple concurrent ranges", () => {
    const view = makeView("hello world");
    view.dispatch({
      effects: setPendingAIRanges.of([
        { from: 0, to: 5 },
        { from: 6, to: 11 },
      ]),
    });

    const decos = view.state.field(pendingAIField);
    const ranges: { from: number; to: number }[] = [];
    const iter = decos.iter();
    while (iter.value) {
      ranges.push({ from: iter.from, to: iter.to });
      iter.next();
    }
    expect(ranges).toEqual([
      { from: 0, to: 5 },
      { from: 6, to: 11 },
    ]);
    view.destroy();
  });

  it("handles simultaneous doc change and clear effect correctly (no flash)", () => {
    const view = makeView("hello");
    view.dispatch({ effects: setPendingAIRanges.of([{ from: 0, to: 5 }]) });

    view.dispatch({
      changes: { from: 0, to: 5, insert: "world" },
      effects: setPendingAIRanges.of([]),
    });

    const decos = view.state.field(pendingAIField);
    const iter = decos.iter();
    expect(iter.value).toBeNull();
    view.destroy();
  });

  it("clamps out-of-bounds ranges to document length", () => {
    const view = makeView("hi");
    view.dispatch({ effects: setPendingAIRanges.of([{ from: 0, to: 100 }]) });

    const decos = view.state.field(pendingAIField);
    const iter = decos.iter();
    expect(iter.value).not.toBeNull();
    expect(iter.from).toBe(0);
    expect(iter.to).toBe(2);
    view.destroy();
  });

  it("clamps negative from to zero", () => {
    const view = makeView("hello");
    view.dispatch({ effects: setPendingAIRanges.of([{ from: -5, to: 3 }]) });

    const decos = view.state.field(pendingAIField);
    const iter = decos.iter();
    expect(iter.value).not.toBeNull();
    expect(iter.from).toBe(0);
    expect(iter.to).toBe(3);
    view.destroy();
  });

  it("filters ranges where clamped from >= clamped to", () => {
    const view = makeView("hi");
    view.dispatch({ effects: setPendingAIRanges.of([{ from: 50, to: 100 }]) });

    const decos = view.state.field(pendingAIField);
    const iter = decos.iter();
    expect(iter.value).toBeNull();
    view.destroy();
  });
});

describe("voice decoration phase integration", () => {
  function makeView(doc = "") {
    const parent = document.createElement("div");
    return new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [interimMarkField, pendingAIField],
      }),
    });
  }

  it("utterance_final phase produces no decorations even when ranges could be set", () => {
    const view = makeView("hello world");
    view.dispatch({
      effects: [setInterimRange.of(null), setPendingAIRanges.of([])],
    });

    const interimDecos = view.state.field(interimMarkField);
    const aiDecos = view.state.field(pendingAIField);
    expect(interimDecos.iter().value).toBeNull();
    expect(aiDecos.iter().value).toBeNull();
    view.destroy();
  });

  it("correctionEnabled=false suppresses both decorations", () => {
    const view = makeView("hello world");
    view.dispatch({
      effects: [
        setInterimRange.of({ from: 0, to: 5 }),
        setPendingAIRanges.of([{ from: 6, to: 11 }]),
      ],
    });

    expect(view.state.field(interimMarkField).iter().value).not.toBeNull();
    expect(view.state.field(pendingAIField).iter().value).not.toBeNull();

    view.dispatch({
      effects: [setInterimRange.of(null), setPendingAIRanges.of([])],
    });

    expect(view.state.field(interimMarkField).iter().value).toBeNull();
    expect(view.state.field(pendingAIField).iter().value).toBeNull();
    view.destroy();
  });
});

describe("diffChipField", () => {
  it("creates decorations for @diff tokens", () => {
    const state = EditorState.create({
      doc: "check @diff please",
      extensions: [diffChipField],
    });
    const chipState = state.field(diffChipField);
    expect(chipState.tokens).toHaveLength(1);
    expect(chipState.tokens[0].diffType).toBe("unstaged");
    expect(chipState.tokens[0].start).toBe(6);
    expect(chipState.tokens[0].end).toBe(11);
  });

  it("creates decorations for @diff:staged tokens", () => {
    const state = EditorState.create({
      doc: "@diff:staged",
      extensions: [diffChipField],
    });
    const chipState = state.field(diffChipField);
    expect(chipState.tokens).toHaveLength(1);
    expect(chipState.tokens[0].diffType).toBe("staged");
  });

  it("creates decorations for @diff:head tokens", () => {
    const state = EditorState.create({
      doc: "@diff:head",
      extensions: [diffChipField],
    });
    const chipState = state.field(diffChipField);
    expect(chipState.tokens).toHaveLength(1);
    expect(chipState.tokens[0].diffType).toBe("head");
  });

  it("finds multiple diff tokens", () => {
    const state = EditorState.create({
      doc: "@diff and @diff:staged and @diff:head",
      extensions: [diffChipField],
    });
    const chipState = state.field(diffChipField);
    expect(chipState.tokens).toHaveLength(3);
  });

  it("returns empty for text without diff tokens", () => {
    const state = EditorState.create({
      doc: "just plain text",
      extensions: [diffChipField],
    });
    const chipState = state.field(diffChipField);
    expect(chipState.tokens).toHaveLength(0);
  });

  it("updates when document changes", () => {
    const state = EditorState.create({
      doc: "@diff",
      extensions: [diffChipField],
    });
    expect(state.field(diffChipField).tokens).toHaveLength(1);

    const tr = state.update({
      changes: { from: 0, to: 5, insert: "hello" },
    });
    expect(tr.state.field(diffChipField).tokens).toHaveLength(0);
  });
});

describe("fileChipField excludes diff tokens", () => {
  it("does not treat @diff as a file token", () => {
    const fileChipStateField = createFileChipField();
    const state = EditorState.create({
      doc: "@diff @src/file.ts",
      extensions: [fileChipStateField],
    });
    const chipState = state.field(fileChipStateField);
    expect(chipState.tokens).toHaveLength(1);
    expect(chipState.tokens[0].path).toBe("src/file.ts");
  });

  it("does not treat @diff:staged or @diff:head as file tokens", () => {
    const fileChipStateField = createFileChipField();
    const state = EditorState.create({
      doc: "@diff:staged @diff:head @src/App.tsx",
      extensions: [fileChipStateField],
    });
    const chipState = state.field(fileChipStateField);
    expect(chipState.tokens).toHaveLength(1);
    expect(chipState.tokens[0].path).toBe("src/App.tsx");
  });

  it("does not treat @terminal as a file token", () => {
    const fileChipStateField = createFileChipField();
    const state = EditorState.create({
      doc: "@terminal @src/file.ts",
      extensions: [fileChipStateField],
    });
    const chipState = state.field(fileChipStateField);
    expect(chipState.tokens).toHaveLength(1);
    expect(chipState.tokens[0].path).toBe("src/file.ts");
  });

  it("does not treat @selection as a file token", () => {
    const fileChipStateField = createFileChipField();
    const state = EditorState.create({
      doc: "@selection @src/file.ts",
      extensions: [fileChipStateField],
    });
    const chipState = state.field(fileChipStateField);
    expect(chipState.tokens).toHaveLength(1);
    expect(chipState.tokens[0].path).toBe("src/file.ts");
  });
});

describe("terminalChipField", () => {
  it("creates decorations for @terminal tokens", () => {
    const state = EditorState.create({
      doc: "check @terminal please",
      extensions: [terminalChipField],
    });
    const chipState = state.field(terminalChipField);
    expect(chipState.tokens).toHaveLength(1);
    expect(chipState.tokens[0].start).toBe(6);
    expect(chipState.tokens[0].end).toBe(15);
  });

  it("returns empty for text without @terminal", () => {
    const state = EditorState.create({
      doc: "just plain text",
      extensions: [terminalChipField],
    });
    const chipState = state.field(terminalChipField);
    expect(chipState.tokens).toHaveLength(0);
  });

  it("updates when document changes", () => {
    const state = EditorState.create({
      doc: "@terminal",
      extensions: [terminalChipField],
    });
    expect(state.field(terminalChipField).tokens).toHaveLength(1);

    const tr = state.update({
      changes: { from: 0, to: 9, insert: "hello" },
    });
    expect(tr.state.field(terminalChipField).tokens).toHaveLength(0);
  });
});

describe("selectionChipField", () => {
  it("creates decorations for @selection tokens", () => {
    const state = EditorState.create({
      doc: "check @selection please",
      extensions: [selectionChipField],
    });
    const chipState = state.field(selectionChipField);
    expect(chipState.tokens).toHaveLength(1);
    expect(chipState.tokens[0].start).toBe(6);
    expect(chipState.tokens[0].end).toBe(16);
  });

  it("returns empty for text without @selection", () => {
    const state = EditorState.create({
      doc: "just plain text",
      extensions: [selectionChipField],
    });
    const chipState = state.field(selectionChipField);
    expect(chipState.tokens).toHaveLength(0);
  });
});

describe("formatFileSize", () => {
  it("formats bytes", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1023)).toBe("1023 B");
  });

  it("formats kilobytes", () => {
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(2048)).toBe("2.0 KB");
    expect(formatFileSize(1536)).toBe("1.5 KB");
  });

  it("formats megabytes", () => {
    expect(formatFileSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatFileSize(5.5 * 1024 * 1024)).toBe("5.5 MB");
  });
});

describe("resolveInputBarColors", () => {
  const fullTheme: ITheme = {
    background: "#1e1e2e",
    foreground: "#cdd6f4",
    cursor: "#f5e0dc",
    selectionBackground: "#585b70",
    red: "#f38ba8",
    green: "#a6e3a1",
    blue: "#89b4fa",
    cyan: "#94e2d5",
    brightCyan: "#b4f9f0",
  };

  it("maps all fields from a full theme", () => {
    const colors = resolveInputBarColors(fullTheme);
    expect(colors.accent).toBe("#f5e0dc");
    expect(colors.foreground).toBe("#cdd6f4");
    expect(colors.background).toBe("#1e1e2e");
    expect(colors.selectionBg).toBe("#585b70");
    expect(colors.chipColor).toBe("#94e2d5");
    expect(colors.errorColor).toBe("#f38ba8");
    expect(colors.successColor).toBe("#a6e3a1");
  });

  it("falls back cursor to blue when cursor is missing", () => {
    const colors = resolveInputBarColors({ ...fullTheme, cursor: undefined });
    expect(colors.accent).toBe("#89b4fa");
  });

  it("falls back chipColor to brightCyan when cyan is missing", () => {
    const colors = resolveInputBarColors({ ...fullTheme, cyan: undefined });
    expect(colors.chipColor).toBe("#b4f9f0");
  });

  it("falls back chipColor to cursor when both cyan and brightCyan are missing", () => {
    const colors = resolveInputBarColors({
      ...fullTheme,
      cyan: undefined,
      brightCyan: undefined,
    });
    expect(colors.chipColor).toBe("#f5e0dc");
  });

  it("returns valid fallback colors for an empty theme", () => {
    const colors = resolveInputBarColors({});
    expect(colors.accent).toBe("#58a6ff");
    expect(colors.foreground).toBe("#cccccc");
    expect(colors.background).toBe("#1e1e1e");
    expect(colors.selectionBg).toBe("#264f78");
    expect(colors.chipColor).toBe("#58a6ff");
    expect(colors.errorColor).toBe("#f44747");
    expect(colors.successColor).toBe("#89d185");
  });
});

describe("buildInputBarTheme", () => {
  const theme: ITheme = {
    background: "#282a36",
    foreground: "#f8f8f2",
    cursor: "#ff79c6",
    red: "#ff5555",
    green: "#50fa7b",
    cyan: "#8be9fd",
  };

  it("produces a valid Extension", () => {
    const ext = buildInputBarTheme(theme);
    expect(ext).toBeDefined();
    expect(ext).not.toBeNull();
  });

  it("does not throw for a partial theme", () => {
    expect(() => buildInputBarTheme({})).not.toThrow();
  });

  it("returns different extensions for different themes", () => {
    const ext1 = buildInputBarTheme(theme);
    const ext2 = buildInputBarTheme({ ...theme, cursor: "#000000" });
    expect(ext1).not.toBe(ext2);
  });

  it("can be used to create an EditorState", () => {
    const state = EditorState.create({
      doc: "test",
      extensions: [buildInputBarTheme(theme)],
    });
    expect(state.doc.toString()).toBe("test");
  });
});
