/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";

// jsdom does not implement Trusted Types — mock the renderer policy module
// with a pass-through so chip widgets that call setTrustedInnerHTML in
// toDOM() can render under jsdom. See #6392.
vi.mock("@/lib/trustedTypesPolicy", () => ({
  createTrustedHTML: (s: string) => s,
  setTrustedInnerHTML: (el: Element, html: string) => {
    el.innerHTML = html;
  },
}));

import { EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import type { ITheme } from "@xterm/xterm";
import {
  buildInputBarTheme,
  chipEntranceTheme,
  computeAutoSize,
  createAutoSize,
  createCustomKeymap,
  createFileChipField,
  fileDropChipField,
  addFileDropChip,
  createFilePasteHandler,
  interimWidgetField,
  setInterimText,
  pendingAIField,
  setPendingAIRanges,
  diffChipField,
  terminalChipField,
  selectionChipField,
  formatFileSize,
  chipPendingDeleteField,
  setChipPendingDelete,
  createChipBackspaceKeymap,
  isChipSelected,
  createSlashChipField,
} from "../inputEditorExtensions";
import type { SlashCommand } from "@shared/types";

function makeSlashCommand(label: string, description = ""): SlashCommand {
  return {
    id: label.replace(/^\//, ""),
    label,
    description,
    scope: "built-in",
    agentId: "claude",
  };
}
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
    expect(entries[0]!.filePath).toBe("/Users/test/file.ts");
    expect(entries[0]!.fileName).toBe("file.ts");
    expect(entries[0]!.from).toBe(0);
    expect(entries[0]!.to).toBe(20);

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
    expect(entries[0]!.from).toBe(7); // shifted by "prefix " (7 chars)
    expect(entries[0]!.to).toBe(27);

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
    expect(entries[0]!.fileName).toBe("a.ts");
    expect(entries[1]!.fileName).toBe("b.ts");

    view.destroy();
  });

  it("removes the clicked chip when duplicates point at the same file", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc: "", extensions: [fileDropChipField] }),
    });

    const text = "@/Users/test/file.ts @/Users/test/file.ts ";
    view.dispatch({
      changes: { from: 0, insert: text },
      effects: [
        addFileDropChip.of({
          from: 0,
          to: 20,
          filePath: "/Users/test/file.ts",
          fileName: "file.ts",
        }),
        addFileDropChip.of({
          from: 21,
          to: 41,
          filePath: "/Users/test/file.ts",
          fileName: "file.ts",
        }),
      ],
    });

    const removeButtons = view.dom.querySelectorAll(".cm-file-drop-chip .cm-chip-remove");
    expect(removeButtons).toHaveLength(2);

    removeButtons[1]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    const entries = view.state.field(fileDropChipField);
    expect(entries).toHaveLength(1);
    // The first occurrence must survive — only the clicked (second) chip goes.
    expect(entries[0]!.from).toBe(0);
    expect(view.state.doc.toString()).toBe("@/Users/test/file.ts ");

    view.destroy();
    parent.remove();
  });

  it("removes the clicked chip when duplicates are directly adjacent", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc: "", extensions: [fileDropChipField] }),
    });

    // No separator: the first chip's end equals the second chip's start, so a
    // closed-interval containment check would match the first entry.
    const text = "@/Users/test/file.ts@/Users/test/file.ts";
    view.dispatch({
      changes: { from: 0, insert: text },
      effects: [
        addFileDropChip.of({
          from: 0,
          to: 20,
          filePath: "/Users/test/file.ts",
          fileName: "file.ts",
        }),
        addFileDropChip.of({
          from: 20,
          to: 40,
          filePath: "/Users/test/file.ts",
          fileName: "file.ts",
        }),
      ],
    });

    const removeButtons = view.dom.querySelectorAll(".cm-file-drop-chip .cm-chip-remove");
    expect(removeButtons).toHaveLength(2);

    removeButtons[1]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    const entries = view.state.field(fileDropChipField);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.from).toBe(0);
    expect(view.state.doc.toString()).toBe("@/Users/test/file.ts");

    view.destroy();
    parent.remove();
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

describe("interimWidgetField", () => {
  function makeView(doc = "") {
    const parent = document.createElement("div");
    return new EditorView({
      parent,
      state: EditorState.create({ doc, extensions: [interimWidgetField] }),
    });
  }

  it("stores the interim text in the field when dispatched", () => {
    const view = makeView("hello world");
    view.dispatch({ effects: setInterimText.of("draft text") });

    expect(view.state.field(interimWidgetField)).toBe("draft text");
    view.destroy();
  });

  it("renders a ghost widget at the end of the doc when text is present", () => {
    const view = makeView("hello world");
    view.dispatch({ effects: setInterimText.of("more") });

    // Locate the ghost span in the rendered DOM.
    const ghost = view.contentDOM.querySelector(".cm-voice-interim");
    expect(ghost).not.toBeNull();
    expect(ghost?.textContent).toBe("more");
    view.destroy();
  });

  it("clears the ghost widget when an empty string is dispatched", () => {
    const view = makeView("hello world");
    view.dispatch({ effects: setInterimText.of("draft") });
    expect(view.contentDOM.querySelector(".cm-voice-interim")).not.toBeNull();

    view.dispatch({ effects: setInterimText.of("") });
    expect(view.contentDOM.querySelector(".cm-voice-interim")).toBeNull();
    view.destroy();
  });

  it("does not mutate the document when interim text is set", () => {
    const view = makeView("hello");
    const before = view.state.doc.toString();
    view.dispatch({ effects: setInterimText.of("interim text not in doc") });

    expect(view.state.doc.toString()).toBe(before);
    expect(view.state.doc.length).toBe(5);
    view.destroy();
  });

  it("interim updates do not enter the undo history (no docChanged)", () => {
    const view = makeView("base");
    view.dispatch({ effects: setInterimText.of("a") });
    view.dispatch({ effects: setInterimText.of("ab") });
    view.dispatch({ effects: setInterimText.of("abc") });

    // None of the interim dispatches touched the document, so the doc
    // is still the original value — and the undo history holds no entries
    // attributable to these effect-only transactions.
    expect(view.state.doc.toString()).toBe("base");
    view.destroy();
  });

  it("ghost widget is suppressed during IME composition", () => {
    const view = makeView("hello");
    // jsdom doesn't expose a composing setter, so stub the property.
    Object.defineProperty(view, "composing", { value: true, configurable: true });
    view.dispatch({ effects: setInterimText.of("ime guard") });

    expect(view.contentDOM.querySelector(".cm-voice-interim")).toBeNull();
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
        extensions: [interimWidgetField, pendingAIField],
      }),
    });
  }

  it("utterance_final phase produces no decorations even when effects could be set", () => {
    const view = makeView("hello world");
    view.dispatch({
      effects: [setInterimText.of(""), setPendingAIRanges.of([])],
    });

    expect(view.state.field(interimWidgetField)).toBe("");
    expect(view.state.field(pendingAIField).iter().value).toBeNull();
    expect(view.contentDOM.querySelector(".cm-voice-interim")).toBeNull();
    view.destroy();
  });

  it("clearing both interim and pending decorations leaves no DOM artifacts", () => {
    const view = makeView("hello world");
    view.dispatch({
      effects: [setInterimText.of("draft"), setPendingAIRanges.of([{ from: 6, to: 11 }])],
    });

    expect(view.state.field(interimWidgetField)).toBe("draft");
    expect(view.state.field(pendingAIField).iter().value).not.toBeNull();

    view.dispatch({
      effects: [setInterimText.of(""), setPendingAIRanges.of([])],
    });

    expect(view.state.field(interimWidgetField)).toBe("");
    expect(view.state.field(pendingAIField).iter().value).toBeNull();
    expect(view.contentDOM.querySelector(".cm-voice-interim")).toBeNull();
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
    expect(chipState.tokens[0]!.diffType).toBe("unstaged");
    expect(chipState.tokens[0]!.start).toBe(6);
    expect(chipState.tokens[0]!.end).toBe(11);
  });

  it("creates decorations for @diff:staged tokens", () => {
    const state = EditorState.create({
      doc: "@diff:staged",
      extensions: [diffChipField],
    });
    const chipState = state.field(diffChipField);
    expect(chipState.tokens).toHaveLength(1);
    expect(chipState.tokens[0]!.diffType).toBe("staged");
  });

  it("creates decorations for @diff:head tokens", () => {
    const state = EditorState.create({
      doc: "@diff:head",
      extensions: [diffChipField],
    });
    const chipState = state.field(diffChipField);
    expect(chipState.tokens).toHaveLength(1);
    expect(chipState.tokens[0]!.diffType).toBe("head");
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
    expect(chipState.tokens[0]!.path).toBe("src/file.ts");
  });

  it("does not treat @diff:staged or @diff:head as file tokens", () => {
    const fileChipStateField = createFileChipField();
    const state = EditorState.create({
      doc: "@diff:staged @diff:head @src/App.tsx",
      extensions: [fileChipStateField],
    });
    const chipState = state.field(fileChipStateField);
    expect(chipState.tokens).toHaveLength(1);
    expect(chipState.tokens[0]!.path).toBe("src/App.tsx");
  });

  it("does not treat @terminal as a file token", () => {
    const fileChipStateField = createFileChipField();
    const state = EditorState.create({
      doc: "@terminal @src/file.ts",
      extensions: [fileChipStateField],
    });
    const chipState = state.field(fileChipStateField);
    expect(chipState.tokens).toHaveLength(1);
    expect(chipState.tokens[0]!.path).toBe("src/file.ts");
  });

  it("does not treat @selection as a file token", () => {
    const fileChipStateField = createFileChipField();
    const state = EditorState.create({
      doc: "@selection @src/file.ts",
      extensions: [fileChipStateField],
    });
    const chipState = state.field(fileChipStateField);
    expect(chipState.tokens).toHaveLength(1);
    expect(chipState.tokens[0]!.path).toBe("src/file.ts");
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
    expect(chipState.tokens[0]!.start).toBe(6);
    expect(chipState.tokens[0]!.end).toBe(15);
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
    expect(chipState.tokens[0]!.start).toBe(6);
    expect(chipState.tokens[0]!.end).toBe(16);
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

  it("resolves voiceCursor from theme.yellow", () => {
    const colors = resolveInputBarColors({ ...fullTheme, yellow: "#e5c07b" });
    expect(colors.voiceCursor).toBe("#e5c07b");
  });

  it("falls back voiceCursor to brightYellow when yellow is missing", () => {
    const colors = resolveInputBarColors({ ...fullTheme, brightYellow: "#f9e2af" });
    expect(colors.voiceCursor).toBe("#f9e2af");
  });

  it("falls back voiceCursor to #e5c07b when both yellow and brightYellow are missing", () => {
    const colors = resolveInputBarColors(fullTheme);
    expect(colors.voiceCursor).toBe("#e5c07b");
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

  it("styles slash chip with chipColor (neutral), not accent", () => {
    const css = readGeneratedCss([buildInputBarTheme(theme)]);
    const colors = resolveInputBarColors(theme);
    expect(colors.chipColor).not.toBe(colors.accent);
    const slashRule = extractRuleBody(css, ".cm-slash-command-chip");
    expect(slashRule).toContain(`color: ${colors.chipColor}`);
    expect(slashRule).not.toContain(`color: ${colors.accent}`);
  });

  it("retains errorColor on the .cm-slash-command-chip-invalid rule", () => {
    const css = readGeneratedCss([buildInputBarTheme(theme)]);
    const colors = resolveInputBarColors(theme);
    const invalidRule = extractRuleBody(css, ".cm-slash-command-chip-invalid");
    expect(invalidRule).toContain(`color: ${colors.errorColor}`);
  });

  it("includes voice-active cursor CSS rules scoped to [data-voice-active]", () => {
    const css = readGeneratedCss([buildInputBarTheme(theme)]);
    const colors = resolveInputBarColors(theme);
    expect(css).toMatch(
      new RegExp(
        `\\[data-voice-active="true"\\]\\s+\\.\\S+\\s+\\.cm-content\\s*\\{[^}]*caret-color:\\s*${colors.voiceCursor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`
      )
    );
    expect(css).toMatch(
      new RegExp(
        `\\[data-voice-active="true"\\]\\s+\\.\\S+\\.cm-focused\\s+\\.cm-cursor\\s*\\{[^}]*border-left:\\s*2px solid ${colors.voiceCursor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`
      )
    );
  });

  it("keeps file paths and chip labels fully visible instead of cropping them", () => {
    const css = readGeneratedCss([buildInputBarTheme(theme)]);
    for (const selector of [".cm-file-chip", ".cm-chip-label"]) {
      const decls = parseDeclarations(extractRuleBody(css, selector));
      expect(clipsText(decls), `${selector} must not clip its text`).toBe(false);
      expect(capsInlineSize(decls), `${selector} must not cap its inline size`).toBe(false);
      expect(
        canBreakUnbrokenToken(decls),
        `${selector} must be able to break an unbroken token`
      ).toBe(true);
    }
  });

  it("preserves whitespace runs so paths differing only by spacing stay distinct", () => {
    const css = readGeneratedCss([buildInputBarTheme(theme)]);
    for (const selector of [".cm-file-chip", ".cm-chip-label"]) {
      const decls = parseDeclarations(extractRuleBody(css, selector));
      // Quoted @tokens can carry runs of spaces; collapsing them renders two
      // different files identically, which is the bug the crop already caused.
      expect(preservesWhitespace(decls), `${selector} must not collapse whitespace`).toBe(true);
    }
  });

  it("floors chip pills at the content line-height rather than pinning a fixed height", () => {
    const css = readGeneratedCss([buildInputBarTheme(theme)]);
    const contentLineHeight = parseDeclarations(extractRuleBody(css, ".cm-content"))["line-height"];
    expect(contentLineHeight).toBeDefined();

    for (const selector of [
      ".cm-file-drop-chip",
      ".cm-image-chip",
      ".cm-diff-chip",
      ".cm-terminal-chip",
      ".cm-selection-chip",
    ]) {
      const decls = parseDeclarations(extractRuleBody(css, selector));
      // Any pinned block size makes a wrapped label spill out of the painted
      // pill, whichever property expresses it.
      for (const prop of ["height", "block-size", "max-height", "max-block-size"]) {
        expect(decls[prop], `${selector} must not pin its block size via ${prop}`).toBeUndefined();
      }
      // The floor preserves the single-line size, so it has to track the
      // editor's line-height instead of drifting from it.
      expect(decls["min-height"], `${selector} should floor at the content line-height`).toBe(
        contentLineHeight
      );
    }
  });
});

const ALL_CHIP_SELECTORS = [
  ".cm-file-chip",
  ".cm-slash-command-chip",
  ".cm-image-chip",
  ".cm-file-drop-chip",
  ".cm-diff-chip",
  ".cm-terminal-chip",
  ".cm-selection-chip",
];

describe("chipEntranceTheme", () => {
  it("is a valid Extension", () => {
    expect(chipEntranceTheme).toBeDefined();
    expect(chipEntranceTheme).not.toBeNull();
  });

  it("can be used to create an EditorState alongside buildInputBarTheme", () => {
    const theme: ITheme = {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#ff79c6",
      cyan: "#8be9fd",
    };
    const state = EditorState.create({
      doc: "hello",
      extensions: [buildInputBarTheme(theme), chipEntranceTheme],
    });
    expect(state.doc.toString()).toBe("hello");
  });

  it("defines a chip-enter @keyframes with opacity + translateY drift", () => {
    const css = readGeneratedCss([chipEntranceTheme]);
    expect(css).toMatch(/@keyframes\s+chip-enter/);
    expect(css).toMatch(/opacity:\s*0/);
    expect(css).toMatch(/translateY\(2px\)/);
  });

  it("applies the chip-enter animation with fill-mode 'both' to all 7 chip classes", () => {
    const css = readGeneratedCss([chipEntranceTheme]);
    for (const selector of ALL_CHIP_SELECTORS) {
      const rule = extractRuleBody(css, selector);
      expect(rule, `${selector} animation rule`).toMatch(/animation:\s*chip-enter/);
      expect(rule, `${selector} fill-mode`).toContain("both");
    }
  });

  it("disables the animation under prefers-reduced-motion", () => {
    const css = readGeneratedCss([chipEntranceTheme]);
    const reducedBlock = extractAtRuleBody(css, "@media (prefers-reduced-motion: reduce)");
    for (const selector of ALL_CHIP_SELECTORS) {
      const rule = extractRuleBody(reducedBlock, selector);
      expect(rule, `${selector} reduced-motion override`).toContain("animation: none");
    }
  });

  it("disables the animation under body[data-reduce-animations='true']", () => {
    const css = readGeneratedCss([chipEntranceTheme]);
    for (const selector of ALL_CHIP_SELECTORS) {
      const composed = `body[data-reduce-animations="true"] ${selector}`;
      const rule = extractRuleBody(css, composed);
      expect(rule, `${composed} override`).toContain("animation: none");
    }
  });
});

function readGeneratedCss(extensions: Extension[]) {
  const state = EditorState.create({ doc: "", extensions });
  const modules = state.facet(EditorView.styleModule);
  return modules.map((m) => m.getRules()).join("\n");
}

function extractRuleBody(css: string, selector: string): string {
  // Match the selector at a brace boundary so ".cm-slash-command-chip" doesn't
  // accidentally capture ".cm-slash-command-chip-invalid".
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|[,}\\s])${escaped}\\s*\\{([^}]*)\\}`));
  if (!match || match[1] === undefined) {
    throw new Error(`selector ${selector} not found in CSS`);
  }
  return match[1];
}

function parseDeclarations(body: string): Record<string, string> {
  const decls: Record<string, string> = {};
  for (const part of body.split(";")) {
    const idx = part.indexOf(":");
    if (idx === -1) continue;
    const prop = part.slice(0, idx).trim().toLowerCase();
    if (prop)
      decls[prop] = part
        .slice(idx + 1)
        .trim()
        .toLowerCase()
        .replace(/\s*!important$/, "");
  }
  return decls;
}

// `pre-wrap`, `pre-line` and `break-spaces` all still wrap — only these refuse.
const NON_WRAPPING_WHITE_SPACE = new Set(["nowrap", "pre"]);

// `white-space` may be a legacy single keyword or the modern
// `<collapse> <text-wrap>` shorthand, and `text-wrap`/`text-wrap-mode` can
// suppress wrapping alone — so tokenize instead of comparing whole values.
function refusesToWrap(decls: Record<string, string>): boolean {
  const whiteSpace = decls["white-space"];
  if (whiteSpace?.split(/\s+/).some((t) => NON_WRAPPING_WHITE_SPACE.has(t))) return true;
  return decls["text-wrap"] === "nowrap" || decls["text-wrap-mode"] === "nowrap";
}

// Collapsing values would render `@"a  b.ts"` and `@"a b.ts"` identically — the
// same indistinguishable-paths failure the cropping caused.
const WHITESPACE_PRESERVING = new Set(["pre", "pre-wrap", "break-spaces", "preserve"]);

function preservesWhitespace(decls: Record<string, string>): boolean {
  return !!decls["white-space"]?.split(/\s+/).some((t) => WHITESPACE_PRESERVING.has(t));
}

// Clipping proper — declarations that hide characters outright.
function clipsText(decls: Record<string, string>): boolean {
  if (/hidden|clip/.test(`${decls["overflow"] ?? ""} ${decls["overflow-x"] ?? ""}`)) return true;
  if ((decls["text-overflow"] ?? "clip") !== "clip") return true;
  return refusesToWrap(decls);
}

// Content- or container-derived sizes let a chip use the width it is given; a
// fixed length or sub-full percentage caps it regardless of available space.
const UNCAPPED_INLINE_SIZES = new Set([
  "none",
  "auto",
  "100%",
  "fit-content",
  "min-content",
  "max-content",
  "stretch",
  "-webkit-fill-available",
]);

function capsInlineSize(decls: Record<string, string>): boolean {
  return ["max-width", "width", "max-inline-size", "inline-size"].some((prop) => {
    const value = decls[prop];
    return value !== undefined && !UNCAPPED_INLINE_SIZES.has(value);
  });
}

// Only these zero the min-content contribution, which is what lets a chip
// shrink inside a narrow pane. `overflow-wrap: break-word` deliberately does
// NOT qualify: it breaks glyphs but still reports the unbroken token's width as
// min-content, so the chip would keep forcing the pane wider. Exact matches
// rather than substring tests, so `var(--break-word-policy)` can't slip past.
const MIN_CONTENT_ZEROING_BREAKS: ReadonlyArray<readonly [string, string]> = [
  ["overflow-wrap", "anywhere"],
  ["word-break", "break-all"],
  ["word-break", "break-word"],
];

// Breaking a slash-free filename needs both a wrapping white-space and an
// explicit break opportunity — neither alone is enough.
function canBreakUnbrokenToken(decls: Record<string, string>): boolean {
  if (refusesToWrap(decls)) return false;
  return MIN_CONTENT_ZEROING_BREAKS.some(([prop, value]) => decls[prop] === value);
}

function extractAtRuleBody(css: string, atRule: string): string {
  const idx = css.indexOf(atRule);
  if (idx === -1) {
    throw new Error(`at-rule ${atRule} not found in CSS`);
  }
  let depth = 0;
  let start = -1;
  for (let i = idx; i < css.length; i++) {
    if (css[i] === "{") {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(start, i);
    }
  }
  throw new Error(`unterminated at-rule ${atRule}`);
}

describe("chipPendingDeleteField", () => {
  function makeView(doc: string, extensions: import("@codemirror/state").Extension[] = []) {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    return new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [chipPendingDeleteField, ...extensions],
      }),
    });
  }

  it("starts null", () => {
    const view = makeView("hello");
    expect(view.state.field(chipPendingDeleteField)).toBeNull();
    view.destroy();
  });

  it("stages a range when setChipPendingDelete effect fires", () => {
    const view = makeView("hello world");
    view.dispatch({ effects: setChipPendingDelete.of({ from: 0, to: 5 }) });
    expect(view.state.field(chipPendingDeleteField)).toEqual({ from: 0, to: 5 });
    view.destroy();
  });

  it("clears when document changes", () => {
    const view = makeView("hello world");
    view.dispatch({ effects: setChipPendingDelete.of({ from: 0, to: 5 }) });
    view.dispatch({ changes: { from: 5, insert: "X" } });
    expect(view.state.field(chipPendingDeleteField)).toBeNull();
    view.destroy();
  });

  it("clears when cursor moves off the staged range", () => {
    const view = makeView("hello world");
    view.dispatch({
      effects: setChipPendingDelete.of({ from: 0, to: 5 }),
      selection: { anchor: 0, head: 5 },
    });
    expect(view.state.field(chipPendingDeleteField)).toEqual({ from: 0, to: 5 });

    view.dispatch({ selection: { anchor: 8 } });
    expect(view.state.field(chipPendingDeleteField)).toBeNull();
    view.destroy();
  });

  it("preserves staged range while cursor remains at boundary", () => {
    const view = makeView("hello world");
    view.dispatch({
      effects: setChipPendingDelete.of({ from: 0, to: 5 }),
      selection: { anchor: 0, head: 5 },
    });
    view.dispatch({ selection: { anchor: 5 } });
    expect(view.state.field(chipPendingDeleteField)).toEqual({ from: 0, to: 5 });
    view.destroy();
  });

  it("explicit null effect clears staging", () => {
    const view = makeView("hello world");
    view.dispatch({ effects: setChipPendingDelete.of({ from: 0, to: 5 }) });
    view.dispatch({ effects: setChipPendingDelete.of(null) });
    expect(view.state.field(chipPendingDeleteField)).toBeNull();
    view.destroy();
  });

  it("clears invalid out-of-bounds range", () => {
    const view = makeView("hi");
    view.dispatch({ effects: setChipPendingDelete.of({ from: 0, to: 100 }) });
    expect(view.state.field(chipPendingDeleteField)).toBeNull();
    view.destroy();
  });
});

describe("isChipSelected helper", () => {
  it("returns false when pending is null", () => {
    expect(isChipSelected(null, 0, 5)).toBe(false);
  });

  it("returns true when pending matches range", () => {
    expect(isChipSelected({ from: 0, to: 5 }, 0, 5)).toBe(true);
  });

  it("returns false when pending range is different", () => {
    expect(isChipSelected({ from: 0, to: 5 }, 6, 11)).toBe(false);
  });

  it("returns false when only one boundary matches", () => {
    expect(isChipSelected({ from: 0, to: 5 }, 0, 6)).toBe(false);
    expect(isChipSelected({ from: 0, to: 5 }, 1, 5)).toBe(false);
  });
});

describe("two-press Backspace on @file chips", () => {
  function makeView(doc: string) {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    return new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [chipPendingDeleteField, createFileChipField(), createChipBackspaceKeymap()],
      }),
    });
  }

  it("first Backspace stages chip and selects it without deleting", () => {
    const view = makeView("@src/App.tsx ");
    // Cursor right after the chip end (position 12: just before the trailing space)
    const chipEnd = "@src/App.tsx".length;
    view.dispatch({ selection: { anchor: chipEnd } });

    runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Backspace" }), "editor");

    expect(view.state.doc.toString()).toBe("@src/App.tsx ");
    const pending = view.state.field(chipPendingDeleteField);
    expect(pending).not.toBeNull();
    expect(pending!.from).toBe(0);
    expect(pending!.to).toBe(chipEnd);
    expect(view.state.selection.main.from).toBe(0);
    expect(view.state.selection.main.to).toBe(chipEnd);
    view.destroy();
  });

  it("second Backspace deletes the chip", () => {
    const view = makeView("@src/App.tsx ");
    const chipEnd = "@src/App.tsx".length;
    view.dispatch({ selection: { anchor: chipEnd } });

    runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Backspace" }), "editor");
    runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Backspace" }), "editor");

    expect(view.state.doc.toString()).toBe(" ");
    expect(view.state.field(chipPendingDeleteField)).toBeNull();
    view.destroy();
  });

  it("Backspace with no chip before cursor returns false and does not stage", () => {
    const view = makeView("plain text");
    view.dispatch({ selection: { anchor: 5 } });

    runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Backspace" }), "editor");

    // Our chip-backspace handler returns false when no chip is before the cursor; default
    // Backspace is not part of this scope so the doc remains unchanged.
    expect(view.state.doc.toString()).toBe("plain text");
    expect(view.state.field(chipPendingDeleteField)).toBeNull();
    view.destroy();
  });

  it("arrow-away after first press clears staging", () => {
    const view = makeView("@src/App.tsx ");
    const chipEnd = "@src/App.tsx".length;
    view.dispatch({ selection: { anchor: chipEnd } });

    runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Backspace" }), "editor");
    expect(view.state.field(chipPendingDeleteField)).not.toBeNull();

    view.dispatch({ selection: { anchor: chipEnd + 1 } });
    expect(view.state.field(chipPendingDeleteField)).toBeNull();
    view.destroy();
  });

  it("range selection covering exactly the chip deletes immediately", () => {
    const view = makeView("@src/App.tsx ");
    const chipEnd = "@src/App.tsx".length;
    view.dispatch({ selection: { anchor: 0, head: chipEnd } });

    runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Backspace" }), "editor");

    expect(view.state.doc.toString()).toBe(" ");
    view.destroy();
  });
});

describe("two-press Backspace on /slash chips", () => {
  function makeView(doc: string, commandMap: Map<string, SlashCommand>) {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    return new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [
          chipPendingDeleteField,
          createSlashChipField({ commandMap }),
          createChipBackspaceKeymap(),
        ],
      }),
    });
  }

  it("first Backspace stages a valid /slash chip", () => {
    const map = new Map<string, SlashCommand>([
      ["/build", makeSlashCommand("/build", "Build the project")],
    ]);
    const view = makeView("/build ", map);
    const chipEnd = "/build".length;
    view.dispatch({ selection: { anchor: chipEnd } });

    runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Backspace" }), "editor");

    expect(view.state.doc.toString()).toBe("/build ");
    expect(view.state.field(chipPendingDeleteField)).toEqual({ from: 0, to: chipEnd });
    view.destroy();
  });

  it("second Backspace deletes a /slash chip", () => {
    const map = new Map<string, SlashCommand>([["/build", makeSlashCommand("/build")]]);
    const view = makeView("/build ", map);
    const chipEnd = "/build".length;
    view.dispatch({ selection: { anchor: chipEnd } });

    runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Backspace" }), "editor");
    runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Backspace" }), "editor");

    expect(view.state.doc.toString()).toBe(" ");
    view.destroy();
  });

  it("does not solidify an invalid /slash command into an atomic chip", () => {
    const map = new Map<string, SlashCommand>();
    const view = makeView("/unknowncmd ", map);
    const chipEnd = "/unknowncmd".length;
    view.dispatch({ selection: { anchor: chipEnd } });

    // A still-draft / mistyped command stays plain editable text: Backspace must
    // NOT stage-and-select the whole token. The chip binding declines (returns
    // false) so the event falls through to the default keymap, which deletes one
    // character in the real editor; the jsdom harness has no default keymap, so
    // we assert the binding declined and nothing was staged.
    const handled = runScopeHandlers(
      view,
      new KeyboardEvent("keydown", { key: "Backspace" }),
      "editor"
    );
    expect(handled).toBe(false);
    expect(view.state.field(chipPendingDeleteField)).toBeNull();
    expect(view.state.selection.main.empty).toBe(true);

    // The invalid token is not registered as an atomic range.
    let covered = false;
    for (const getRanges of view.state.facet(EditorView.atomicRanges)) {
      getRanges(view).between(0, chipEnd, () => {
        covered = true;
        return false;
      });
    }
    expect(covered).toBe(false);

    // It renders as an editable mark (the "no match" hint), not a replace widget.
    expect(view.dom.querySelector('[role="img"]')).toBeNull();
    expect(view.dom.querySelector(".cm-slash-command-chip-invalid")).not.toBeNull();
    view.destroy();
  });

  it("still solidifies a valid /slash command into an atomic chip", () => {
    const map = new Map<string, SlashCommand>([["/build", makeSlashCommand("/build")]]);
    const view = makeView("/build ", map);
    const chipEnd = "/build".length;
    view.dispatch({ selection: { anchor: chipEnd } });

    let covered = false;
    for (const getRanges of view.state.facet(EditorView.atomicRanges)) {
      getRanges(view).between(0, chipEnd, () => {
        covered = true;
        return false;
      });
    }
    expect(covered).toBe(true);
    view.destroy();
  });

  it("renders a mixed valid + invalid doc: widget for valid, editable mark for invalid", () => {
    // Exercises the combined decoration set (a replace widget and a plain mark
    // in the same Decoration.set) plus the atomicRanges split.
    const map = new Map<string, SlashCommand>([["/build", makeSlashCommand("/build")]]);
    const view = makeView("/build /unknowncmd", map);

    // Exactly one solidified chip widget, for the valid command.
    const widgets = view.dom.querySelectorAll('[role="img"]');
    expect(widgets).toHaveLength(1);
    expect(widgets[0]?.textContent).toBe("/build");

    // The invalid token renders as an editable "no match" mark, not a widget.
    expect(view.dom.querySelector(".cm-slash-command-chip-invalid")?.textContent).toBe(
      "/unknowncmd"
    );

    const coversRange = (from: number, to: number) => {
      let covered = false;
      for (const getRanges of view.state.facet(EditorView.atomicRanges)) {
        getRanges(view).between(from, to, (rFrom, rTo) => {
          if (rFrom === from && rTo === to) {
            covered = true;
            return false;
          }
          return undefined;
        });
      }
      return covered;
    };

    // Only the valid command is atomic.
    expect(coversRange(0, "/build".length)).toBe(true);
    const invalidStart = "/build ".length;
    expect(coversRange(invalidStart, invalidStart + "/unknowncmd".length)).toBe(false);
    view.destroy();
  });
});

describe("slashChipField valid/invalid distinction", () => {
  it("preserves isValid metadata for known commands", () => {
    const map = new Map<string, SlashCommand>([["/build", makeSlashCommand("/build")]]);
    const field = createSlashChipField({ commandMap: map });
    const state = EditorState.create({
      doc: "/build /unknowncmd",
      extensions: [field],
    });
    const chipState = state.field(field);
    expect(chipState.tokens).toHaveLength(2);
    const validToken = chipState.tokens.find((t) => t.command === "/build");
    const invalidToken = chipState.tokens.find((t) => t.command === "/unknowncmd");
    expect(validToken?.isValid).toBe(true);
    expect(invalidToken?.isValid).toBe(false);
  });
});

describe("@file chip yields to fileDropChip when ranges overlap", () => {
  it("does not render @file widget over a fileDropChip range", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "@/Users/test/file.ts ",
        extensions: [chipPendingDeleteField, createFileChipField(), fileDropChipField],
      }),
    });

    view.dispatch({
      effects: addFileDropChip.of({
        from: 0,
        to: 20,
        filePath: "/Users/test/file.ts",
        fileName: "file.ts",
      }),
    });

    // The rich file-drop chip should be present and own the range; the simple file chip
    // must not also render a competing widget.
    const dropChip = view.dom.querySelector(".cm-file-drop-chip");
    const fileChip = view.dom.querySelector(".cm-file-chip");
    expect(dropChip).not.toBeNull();
    expect(fileChip).toBeNull();
    view.destroy();
  });
});

describe("middle-of-text chip deletion", () => {
  it("preserves surrounding text after two-press delete", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "run @src/App.tsx now",
        extensions: [chipPendingDeleteField, createFileChipField(), createChipBackspaceKeymap()],
      }),
    });

    const chipEnd = "run @src/App.tsx".length;
    view.dispatch({ selection: { anchor: chipEnd } });

    runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Backspace" }), "editor");
    runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Backspace" }), "editor");

    expect(view.state.doc.toString()).toBe("run  now");
    view.destroy();
  });
});

describe("two-press Backspace edge cases", () => {
  function makeView(doc: string) {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    return new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [chipPendingDeleteField, createFileChipField(), createChipBackspaceKeymap()],
      }),
    });
  }

  it("partial selection that does not exactly cover a chip returns false", () => {
    const view = makeView("@src/App.tsx ");
    const chipEnd = "@src/App.tsx".length;
    view.dispatch({ selection: { anchor: 0, head: chipEnd - 1 } });

    runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Backspace" }), "editor");

    expect(view.state.doc.toString()).toBe("@src/App.tsx ");
    expect(view.state.field(chipPendingDeleteField)).toBeNull();
    view.destroy();
  });

  it("alreadyStaged path: cursor returns to chip edge then second Backspace deletes", () => {
    const view = makeView("@src/App.tsx ");
    const chipEnd = "@src/App.tsx".length;
    view.dispatch({ selection: { anchor: chipEnd } });

    // First press: stages + selects the chip.
    runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Backspace" }), "editor");
    expect(view.state.field(chipPendingDeleteField)).not.toBeNull();
    expect(view.state.selection.main.empty).toBe(false);

    // Collapse the selection back to the chip's right edge — staging must be preserved
    // because the cursor is still at the chip boundary.
    view.dispatch({ selection: { anchor: chipEnd } });
    expect(view.state.field(chipPendingDeleteField)).toEqual({ from: 0, to: chipEnd });
    expect(view.state.selection.main.empty).toBe(true);

    // Second press: alreadyStaged branch deletes via the empty-selection path.
    runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Backspace" }), "editor");
    expect(view.state.doc.toString()).toBe(" ");
    view.destroy();
  });
});

describe("two-press Backspace on diffChip and terminalChip", () => {
  function makeView(doc: string, field: import("@codemirror/state").Extension) {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    return new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [chipPendingDeleteField, field, createChipBackspaceKeymap()],
      }),
    });
  }

  it("diffChip: two-press Backspace deletes @diff token", () => {
    const view = makeView("see @diff please", diffChipField);
    const chipEnd = "see @diff".length;
    view.dispatch({ selection: { anchor: chipEnd } });

    runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Backspace" }), "editor");
    expect(view.state.doc.toString()).toBe("see @diff please");
    expect(view.state.field(chipPendingDeleteField)).not.toBeNull();

    runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Backspace" }), "editor");
    expect(view.state.doc.toString()).toBe("see  please");
    view.destroy();
  });

  it("terminalChip: two-press Backspace deletes @terminal token", () => {
    const view = makeView("see @terminal please", terminalChipField);
    const chipEnd = "see @terminal".length;
    view.dispatch({ selection: { anchor: chipEnd } });

    runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Backspace" }), "editor");
    runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Backspace" }), "editor");

    expect(view.state.doc.toString()).toBe("see  please");
    view.destroy();
  });
});

describe("@file chip widget rendering", () => {
  it("doc text is preserved when chip is rendered as widget", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "@src/App.tsx hello",
        extensions: [chipPendingDeleteField, createFileChipField()],
      }),
    });

    expect(view.state.doc.toString()).toBe("@src/App.tsx hello");
    view.destroy();
  });

  it("renders cm-chip-pending-delete class when chip is staged", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "@src/App.tsx",
        extensions: [chipPendingDeleteField, createFileChipField()],
      }),
    });

    view.dispatch({
      effects: setChipPendingDelete.of({ from: 0, to: 12 }),
      selection: { anchor: 0, head: 12 },
    });

    // Widget DOM should reflect the selected state
    const chipEl = view.dom.querySelector(".cm-file-chip");
    expect(chipEl).not.toBeNull();
    expect(chipEl?.classList.contains("cm-chip-pending-delete")).toBe(true);

    view.destroy();
  });
});
