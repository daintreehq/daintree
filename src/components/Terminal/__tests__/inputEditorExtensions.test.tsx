/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, onTestFinished, vi } from "vitest";

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
import { EditorView, WidgetType, runScopeHandlers } from "@codemirror/view";
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
  createPlaceholder,
  pendingAIField,
  setPendingAIRanges,
  diffChipField,
  terminalChipField,
  selectionChipField,
  chipPendingDeleteField,
  setChipPendingDelete,
  createChipBackspaceKeymap,
  isChipSelected,
  createSlashChipField,
  imageChipField,
  addImageChip,
  readImageChipPaths,
  minimalDocChange,
  createComboboxAttributes,
} from "../inputEditorExtensions";
import { formatChipLabel, VOICE_CARET_LEVEL_PROPERTY } from "../inputEditorExtensions/base";
import { appendAgentContextToDraft, formatAgentContextBlock } from "@shared/utils/agentContextDrag";
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

  it("always returns single-line height for empty documents regardless of contentHeight", () => {
    // Even if contentHeight is inflated by zoom, empty doc should be single-line
    const result = computeAutoSize(25, 20, 160, true);
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

  /**
   * Interim dictation is a widget after an empty doc (#9172), so the doc
   * alone says "empty" while wrapped transcript is on screen (#13103).
   */
  describe("interim dictation", () => {
    function mountInterim(initialHeight: number) {
      let contentHeight = initialHeight;
      const parent = document.createElement("div");
      const view = new EditorView({
        parent,
        state: EditorState.create({
          doc: "",
          extensions: [interimWidgetField, createAutoSize({ lineHeightPx: 10, maxHeightPx: 30 })],
        }),
      });
      Object.defineProperty(view, "contentHeight", {
        get: () => contentHeight,
        configurable: true,
      });
      const originalRequestMeasure = view.requestMeasure.bind(view);
      vi.spyOn(view, "requestMeasure").mockImplementation((measure) => {
        if (measure?.write) {
          measure.write(measure.read(view), view);
        } else {
          originalRequestMeasure(measure);
        }
      });
      return {
        view,
        setHeight: (h: number) => {
          contentHeight = h;
        },
      };
    }

    it("grows with wrapped interim text on an empty doc", () => {
      const { view } = mountInterim(25);
      view.dispatch({ effects: setInterimText.of("a long dictated sentence") });

      expect(view.state.doc.length).toBe(0);
      expect(view.dom.style.height).toBe("30px");
      expect(view.scrollDOM.style.overflowY).toBe("hidden");

      view.destroy();
    });

    it("scrolls once interim text passes the max height", () => {
      const { view } = mountInterim(50);
      view.dispatch({ effects: setInterimText.of("a very long dictated passage") });

      expect(view.dom.style.height).toBe("30px");
      expect(view.scrollDOM.style.overflowY).toBe("auto");

      view.destroy();
    });

    it("shrinks back to one line when the interim text is cleared", () => {
      const { view, setHeight } = mountInterim(25);
      view.dispatch({ effects: setInterimText.of("a long dictated sentence") });
      expect(view.dom.style.height).toBe("30px");

      setHeight(0);
      view.dispatch({ effects: setInterimText.of("") });
      expect(view.dom.style.height).toBe("10px");

      view.destroy();
    });

    it("shows a preview placed outside the draft at its end, and takes the next edit (#15716)", () => {
      const { view } = mountInterim(25);
      onTestFinished(() => view.destroy());
      const preview = (pos: number) => setInterimText.of({ text: "next words", pos });
      view.dispatch({ effects: preview(312) });
      expect(view.state.field(interimWidgetField)).toEqual({ text: "next words", pos: null });
      view.dispatch({ effects: preview(-1) });
      expect(view.state.field(interimWidgetField)).toEqual({ text: "next words", pos: null });

      // Measured against the text the same transaction writes, its end included.
      view.dispatch({ changes: { from: 0, insert: "so " }, effects: preview(3) });
      expect(view.state.doc.toString()).toBe("so ");
      expect(view.state.field(interimWidgetField).pos).toBe(3);
      view.dispatch({ effects: preview(0) });
      expect(view.state.field(interimWidgetField).pos).toBe(0);
    });

    it("keeps its height when interim text is committed to the draft", () => {
      const { view } = mountInterim(25);
      view.dispatch({ effects: setInterimText.of("a long dictated sentence") });

      view.dispatch({
        changes: { from: 0, insert: "a long dictated sentence" },
        effects: setInterimText.of(""),
      });

      expect(view.dom.style.height).toBe("30px");

      view.destroy();
    });
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
  function makeView(onEnter: () => boolean, onModEnter: () => boolean = () => false) {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    return new EditorView({
      parent,
      state: EditorState.create({
        doc: "hello",
        extensions: [
          createCustomKeymap({
            onEnter,
            onModEnter,
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

  it.each([true, false])(
    "hands Mod+Enter to onModEnter, apart from Enter, handled as it says (%s)",
    (sends) => {
      const onEnter = vi.fn(() => true);
      const onModEnter = vi.fn(() => sends);
      const view = makeView(onEnter, onModEnter);
      // CodeMirror's Mod is Cmd on a Mac and Ctrl elsewhere, read from the platform.
      const mod = /Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };

      const handled = runScopeHandlers(
        view,
        new KeyboardEvent("keydown", { key: "Enter", ...mod }),
        "editor"
      );

      expect(onModEnter).toHaveBeenCalledOnce();
      expect(onEnter).not.toHaveBeenCalled();
      expect(handled).toBe(sends);
      expect(view.state.doc.toString()).toBe("hello");
      view.destroy();
    }
  );
});

describe("formatChipLabel", () => {
  it("labels a host inbox image by the time in its name, not as epoch milliseconds", () => {
    expect(
      formatChipLabel(
        "/var/folders/x/T/daintree-inbox/clipboard/clipboard-20261012-022831-f6a4458a26c8.png"
      )
    ).toBe("Screenshot 02:28");
  });

  it("labels this machine's pasted image by its epoch timestamp", () => {
    const at = new Date(2026, 9, 12, 14, 5, 0).getTime();
    expect(formatChipLabel(`/tmp/daintree-clipboard/clipboard-${at}-abcd.png`)).toBe(
      "Screenshot 14:05"
    );
  });
});

describe("readImageChipPaths (#12792)", () => {
  function makeEditor(doc: string) {
    return new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({ doc, extensions: [imageChipField] }),
    });
  }

  it("returns chip paths in document order, whatever order they were added in", () => {
    const view = makeEditor("/a/one.png and /a/two.png");
    view.dispatch({
      effects: [
        addImageChip.of({ from: 15, to: 25, filePath: "/a/two.png", thumbnailUrl: "" }),
        addImageChip.of({ from: 0, to: 10, filePath: "/a/one.png", thumbnailUrl: "" }),
      ],
    });

    expect(readImageChipPaths(view)).toEqual(["/a/one.png", "/a/two.png"]);
    view.destroy();
  });

  it("drops a chip once an edit inside it removes it", () => {
    const view = makeEditor("/a/one.png ");
    view.dispatch({
      effects: addImageChip.of({ from: 0, to: 10, filePath: "/a/one.png", thumbnailUrl: "" }),
    });
    view.dispatch({ changes: { from: 3, to: 4, insert: "x" } });

    expect(readImageChipPaths(view)).toEqual([]);
    view.destroy();
  });

  it("returns nothing without a view", () => {
    expect(readImageChipPaths(null)).toEqual([]);
  });

  it("keeps an attached image through a handoff appended to the draft", () => {
    // image → handoff → submit: the input bar syncs an outside write with
    // `minimalDocChange`, and the send reads the attachments off the field.
    const typed = "/a/one.png fix this";
    const view = makeEditor(typed);
    view.dispatch({
      effects: addImageChip.of({ from: 0, to: 10, filePath: "/a/one.png", thumbnailUrl: "" }),
    });
    const draft = appendAgentContextToDraft(
      typed,
      formatAgentContextBlock({ text: "Card body", title: "Card", sourceLabel: "Kanban" })
    );

    view.dispatch({ changes: minimalDocChange(view.state.doc.toString(), draft)! });

    expect(view.state.doc.toString()).toBe(draft);
    expect(readImageChipPaths(view)).toEqual(["/a/one.png"]);
    view.destroy();
  });
});

describe("minimalDocChange", () => {
  it("is an insertion at the end for an append", () => {
    expect(minimalDocChange("abc", "abc\n\nxyz")).toEqual({ from: 3, to: 3, insert: "\n\nxyz" });
  });

  it("replaces only the differing middle", () => {
    expect(minimalDocChange("keep OLD tail", "keep NEW! tail")).toEqual({
      from: 5,
      to: 8,
      insert: "NEW!",
    });
  });

  it("is nothing when the text is unchanged", () => {
    expect(minimalDocChange("same", "same")).toBeNull();
  });

  it("handles a deletion and a full rewrite", () => {
    expect(minimalDocChange("abcdef", "abef")).toEqual({ from: 2, to: 4, insert: "" });
    expect(minimalDocChange("abc", "xyz")).toEqual({ from: 0, to: 3, insert: "xyz" });
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

    removeButtons[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

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

    removeButtons[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

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
      files: {
        getDroppedFilePaths: (files: readonly File[]) =>
          files.map((file) => (file as unknown as { _testPath?: string })._testPath ?? ""),
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
      files: {
        getDroppedFilePaths: (files: readonly File[]) => files.map(() => ""),
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

  it("renders a ghost widget at the end of the doc when text is present", () => {
    const view = makeView("hello world");
    view.dispatch({ effects: setInterimText.of("more") });

    // Locate the ghost span in the rendered DOM.
    const ghost = view.contentDOM.querySelector(".cm-voice-interim");
    expect(ghost).not.toBeNull();
    expect(ghost?.textContent).toBe("more");
    view.destroy();
  });

  it("renders the ghost at its position and keeps it there through edits around it", () => {
    const view = makeView("hello world");
    view.dispatch({ effects: setInterimText.of({ text: " big", pos: 5 }) });
    expect(view.state.field(interimWidgetField)).toEqual({ text: " big", pos: 5 });
    expect(view.contentDOM.querySelector(".cm-line")?.textContent).toBe("hello big world");

    const line = () => view.contentDOM.querySelector(".cm-line")?.textContent;
    view.dispatch({ changes: { from: 0, insert: "Say " } });
    expect(view.state.field(interimWidgetField).pos).toBe(9);
    expect(line()).toBe("Say hello big world");
    view.dispatch({ changes: { from: 9, insert: "!" } });
    // Typed at the preview's own spot: the preview stays after it, as the words will.
    expect(view.state.field(interimWidgetField).pos).toBe(10);
    expect(line()).toBe("Say hello! big world");
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

  it("hides the placeholder while ghost text is showing on an empty doc", () => {
    const parent = document.createElement("div");
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "",
        extensions: [interimWidgetField, createPlaceholder("Ask Claude")],
      }),
    });

    expect(view.contentDOM.querySelector(".cm-placeholder")).not.toBeNull();
    expect(view.contentDOM.classList.contains("cm-voice-interim-active")).toBe(false);

    view.dispatch({ effects: setInterimText.of("dictated words") });
    expect(view.contentDOM.classList.contains("cm-voice-interim-active")).toBe(true);

    view.dispatch({ effects: setInterimText.of("") });
    expect(view.contentDOM.classList.contains("cm-voice-interim-active")).toBe(false);
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

  function spans(view: EditorView) {
    const out: { from: number; to: number; widget: boolean }[] = [];
    const iter = view.state.field(pendingAIField).iter();
    while (iter.value) {
      out.push({ from: iter.from, to: iter.to, widget: iter.value.spec.widget !== undefined });
      iter.next();
    }
    return out;
  }

  it("draws a streamed rewrite over the words it replaced, leaving the doc as dictated", () => {
    const doc = "um so fix the bug";
    const view = makeView(doc);
    view.dispatch({
      effects: setPendingAIRanges.of([{ from: 0, to: 17, rewrite: { to: 9, text: "So fix" } }]),
    });

    expect(spans(view)).toEqual([
      { from: 0, to: 9, widget: true },
      { from: 9, to: 17, widget: false },
    ]);
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.contentDOM.querySelector(".cm-voice-rewrite")?.textContent).toBe("So fix");
    expect(view.contentDOM.textContent).toBe("So fix the bug");
    view.destroy();
  });

  it("draws a rewrite of the whole passage with no underline left after it", () => {
    const view = makeView("fix the bug");
    view.dispatch({
      effects: setPendingAIRanges.of([
        { from: 0, to: 11, rewrite: { to: 11, text: "Fix the bug." } },
      ]),
    });

    expect(spans(view)).toEqual([{ from: 0, to: 11, widget: true }]);
    expect(view.contentDOM.textContent).toBe("Fix the bug.");
    view.destroy();
  });

  function underlined(view: EditorView): string[] {
    return Array.from(view.contentDOM.querySelectorAll(".cm-voice-pending-ai")).map(
      (el) => el.textContent ?? ""
    );
  }

  it("recedes the underline as the rewrite advances, never back under rewritten words", () => {
    const view = makeView("um so fix the bug");
    view.dispatch({ effects: setPendingAIRanges.of([{ from: 0, to: 17, rewrite: undefined }]) });
    expect(underlined(view)).toEqual(["um so fix the bug"]);

    view.dispatch({
      effects: setPendingAIRanges.of([{ from: 0, to: 17, rewrite: { to: 9, text: "So fix" } }]),
    });
    expect(underlined(view)).toEqual([" the bug"]);
    expect(
      view.contentDOM.querySelector(".cm-voice-rewrite")?.classList.contains("cm-voice-pending-ai")
    ).toBe(false);

    view.dispatch({
      effects: setPendingAIRanges.of([
        { from: 0, to: 17, rewrite: { to: 13, text: "So fix the" } },
      ]),
    });
    expect(underlined(view)).toEqual([" bug"]);

    view.dispatch({
      effects: setPendingAIRanges.of([
        { from: 0, to: 17, rewrite: { to: 17, text: "So fix the bug." } },
      ]),
    });
    expect(underlined(view)).toEqual([]);
    view.destroy();
  });

  it("leaves no underline under a finished passage beside one still streaming", () => {
    const view = makeView("fix bug. add test now");
    view.dispatch({
      effects: setPendingAIRanges.of([
        { from: 0, to: 8, rewrite: { to: 8, text: "Fix bug." } },
        { from: 9, to: 21, rewrite: { to: 12, text: "Add" } },
      ]),
    });
    expect(underlined(view)).toEqual([" test now"]);
    view.destroy();
  });

  // #14901: a reply is judged only once it's whole, and lands only with every
  // other passage of its pass, so until it is written into the draft the
  // rewrite never reads as text that landed.
  it("draws a streamed rewrite as words not yet written, until it lands", () => {
    const parent = document.createElement("div");
    // As the shell sets them: the draft's ink, and the ink for words not yet in it.
    parent.style.color = "rgb(205, 214, 244)";
    parent.style.setProperty("--ib-interim", "rgb(150, 155, 170)");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "um so fix the bug. Then ship",
        extensions: [
          buildInputBarTheme({ background: "#1e1e2e", foreground: "#cdd6f4" }),
          interimWidgetField,
          pendingAIField,
        ],
      }),
    });
    const look = (selector: string) => {
      const style = getComputedStyle(view.contentDOM.querySelector(selector)!);
      return { color: style.color, fontStyle: style.fontStyle };
    };
    view.dispatch({
      effects: [
        setInterimText.of(" today"),
        setPendingAIRanges.of([{ from: 0, to: 18, rewrite: { to: 18, text: "So fix the bug." } }]),
      ],
    });
    const rewrite = look(".cm-voice-rewrite");
    const draftText = look(".cm-line");
    expect(rewrite).toEqual(look(".cm-voice-interim"));
    // Neither its ink nor its slant is the draft's.
    expect(rewrite.color).not.toBe(draftText.color);
    expect(rewrite.fontStyle).not.toBe(draftText.fontStyle);

    // Landing writes the cleanup into the draft and takes the rewrite away.
    view.dispatch({
      changes: { from: 0, to: 18, insert: "So fix the bug." },
      effects: [setInterimText.of(""), setPendingAIRanges.of([])],
    });
    expect(view.contentDOM.querySelector(".cm-voice-rewrite")).toBeNull();
    expect(view.contentDOM.textContent).toBe("So fix the bug. Then ship");
    view.destroy();
    parent.remove();
  });

  it("drops the rewrite in the same transaction as typing inside the words it hides", () => {
    const view = makeView("um so fix the bug");
    view.dispatch({
      effects: setPendingAIRanges.of([{ from: 0, to: 17, rewrite: { to: 9, text: "So fix" } }]),
    });
    view.dispatch({ changes: { from: 6, insert: "x" } });

    expect(spans(view).filter((span) => span.widget)).toEqual([]);
    expect(view.contentDOM.textContent).toBe("um so xfix the bug");
    view.destroy();
  });

  it("keeps the rewrite over typing at its edges", () => {
    const view = makeView("um so fix the bug");
    view.dispatch({
      effects: setPendingAIRanges.of([{ from: 0, to: 17, rewrite: { to: 9, text: "So fix" } }]),
    });
    view.dispatch({ changes: { from: 0, insert: "Hey " } });

    expect(spans(view)).toEqual([
      { from: 4, to: 13, widget: true },
      { from: 13, to: 21, widget: false },
    ]);
    view.destroy();
  });

  it("lays a rewritten list out on its own lines", () => {
    const view = makeView("first fix the parser second ship it");
    view.dispatch({
      effects: setPendingAIRanges.of([
        { from: 0, to: 35, rewrite: { to: 27, text: "1. Fix the parser\n2." } },
      ]),
    });

    expect(view.contentDOM.textContent).toBe("1. Fix the parser\n2. ship it");
    const widget: unknown = view.state.field(pendingAIField).iter().value?.spec.widget;
    expect(widget instanceof WidgetType ? widget.lineBreaks : null).toBe(1);
    view.destroy();
  });

  it("shows the dictated words while the caret sits among the words a rewrite hides", () => {
    const doc = "um so fix the bug";
    const rewrite = { from: 0, to: 17, rewrite: { to: 9, text: "So fix" } };
    const view = makeView(doc);
    view.dispatch({ effects: setPendingAIRanges.of([rewrite]) });

    view.dispatch({ selection: { anchor: 7 } });
    expect(view.contentDOM.textContent).toBe(doc);
    expect(spans(view)).toEqual([
      { from: 0, to: 9, widget: false },
      { from: 9, to: 17, widget: false },
    ]);

    // A rewrite that streams on meanwhile doesn't cover the caret again.
    view.dispatch({ effects: setPendingAIRanges.of([rewrite]) });
    expect(view.contentDOM.textContent).toBe(doc);

    view.dispatch({ selection: { anchor: 17 } });
    view.dispatch({ effects: setPendingAIRanges.of([rewrite]) });
    expect(view.contentDOM.textContent).toBe("So fix the bug");
    view.destroy();
  });

  it("covers a file chip inside the words it rewrote, and gives it back after", () => {
    const parent = document.createElement("div");
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "open @src/a.ts now please",
        extensions: [pendingAIField, createFileChipField()],
      }),
    });
    view.dispatch({
      effects: setPendingAIRanges.of([
        { from: 0, to: 25, rewrite: { to: 18, text: "Open @src/a.ts now" } },
      ]),
    });

    expect(view.contentDOM.querySelector(".cm-file-chip")).toBeNull();
    expect(view.contentDOM.textContent).toBe("Open @src/a.ts now please");

    view.dispatch({ effects: setPendingAIRanges.of([]) });
    expect(view.contentDOM.querySelector(".cm-file-chip")?.textContent).toBe("@src/a.ts");
    view.destroy();
  });

  it("drops the rewrite when the correction lands over it", () => {
    const view = makeView("um so fix the bug");
    view.dispatch({
      effects: setPendingAIRanges.of([{ from: 0, to: 17, rewrite: { to: 9, text: "So fix" } }]),
    });
    view.dispatch({
      changes: { from: 0, to: 17, insert: "So fix the bug." },
      effects: setPendingAIRanges.of([]),
    });

    expect(spans(view)).toEqual([]);
    expect(view.contentDOM.textContent).toBe("So fix the bug.");
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

  it("clearing both interim and pending decorations leaves no DOM artifacts", () => {
    const view = makeView("hello world");
    view.dispatch({
      effects: [setInterimText.of("draft"), setPendingAIRanges.of([{ from: 6, to: 11 }])],
    });

    expect(view.state.field(interimWidgetField).text).toBe("draft");
    expect(view.state.field(pendingAIField).iter().value).not.toBeNull();

    view.dispatch({
      effects: [setInterimText.of(""), setPendingAIRanges.of([])],
    });

    expect(view.state.field(interimWidgetField).text).toBe("");
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

  it("finds multiple diff tokens", () => {
    const state = EditorState.create({
      doc: "@diff and @diff:staged and @diff:head",
      extensions: [diffChipField],
    });
    const chipState = state.field(diffChipField);
    expect(chipState.tokens).toHaveLength(3);
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

  it("fits an rgb() palette exactly as it fits the same colours in hex", () => {
    const hex = resolveInputBarColors({ background: "#1e1e2e", foreground: "#cdd6f4" });
    const rgb = resolveInputBarColors({
      background: "rgb(30, 30, 46)",
      foreground: "rgb(205, 214, 244)",
    });
    // 60%/66% are fitted; an unparsed palette falls back to 67%/72%.
    expect(hex.placeholder).toBe("color-mix(in oklab, #cdd6f4 60%, #1e1e2e)");
    expect(rgb.placeholder).toBe("color-mix(in oklab, rgb(205, 214, 244) 60%, rgb(30, 30, 46))");
    expect(hex.placeholderSelected).toBe("color-mix(in oklab, #cdd6f4 66%, #1e1e2e)");
    expect(rgb.placeholderSelected).toBe(
      "color-mix(in oklab, rgb(205, 214, 244) 66%, rgb(30, 30, 46))"
    );
    expect(rgb.isDark).toBe(true);
  });

  it("composites a translucent rgba() foreground over the background before mixing", () => {
    for (const foreground of ["rgba(255, 255, 255, 0.5)", "rgb(255 255 255 / 50%)"]) {
      const colors = resolveInputBarColors({ background: "#000", foreground });
      expect(colors.shellSelectedBg, foreground).toBe("color-mix(in oklab, #808080 3%, #000)");
      expect(colors.placeholder, foreground).toBe("color-mix(in oklab, #808080 95%, #000)");
    }
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

  it("draws the dictation caret as a level meter clear of the text", () => {
    const css = readGeneratedCss([buildInputBarTheme(theme)]);
    const colors = resolveInputBarColors(theme);
    // Every base rule whose selector list names the selector, merged in order;
    // media blocks aside.
    const base = withoutMediaBlocks(css);
    const rule = (selector: string) => {
      const bodies = [...base.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) =>
        (m[1] ?? "").split(",").some((s) => s.trim().replace(/^\.ͼ\w+ /, "") === selector)
      );
      if (bodies.length === 0) throw new Error(`selector ${selector} not found in CSS`);
      return Object.assign({}, ...bodies.map((m) => parseDeclarations(m[2] ?? "")));
    };
    // The meter takes no width of its own, so the text after it never moves.
    expect(rule(".cm-voice-caret")["padding-left"]).toBeUndefined();
    const track = rule(".cm-voice-caret::before");
    const fill = rule(".cm-voice-caret::after");
    for (const part of [track, fill]) {
      expect(part.position).toBe("absolute");
      expect(part.width).toBe("3px");
    }
    expect(track["background-color"]).toContain("color-mix");
    expect(fill["background-color"]).toBe(colors.voiceSignal.toLowerCase());
    expect(fill["transform-origin"]).toBe("bottom");
    expect(fill.transform).toBe("scaley(0)");

    const live = rule('.cm-voice-caret[data-phase="live"]::after');
    expect(live.transform).toContain(`var(${VOICE_CARET_LEVEL_PROPERTY}, 1)`);
    expect(live.transition).toContain("transform");

    const held = rule('.cm-voice-caret[data-phase="held"]::after');
    expect(held["background-color"]).toBe(colors.voiceHeld.toLowerCase());
    expect(held.transform).toBe("scaley(0.25)");

    // Reduced motion holds the fill full, over the live rule, and lets its
    // opacity carry the voice.
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*\.cm-content \.cm-voice-caret\[data-phase="live"\]::after\s*\{\s*transform:\s*none[^}]*opacity:\s*calc\(0\.55 \+/
    );
    expect(css).toMatch(
      /@media \(forced-colors: active\)\s*\{[^@]*\.cm-voice-caret::after\s*\{[^}]*border-left:\s*3px solid Highlight/
    );
    expect(css).toMatch(
      /@media \(forced-colors: active\)\s*\{[^@]*\.cm-voice-caret\[data-phase="held"\]::after\s*\{[^}]*border-left-color:\s*GrayText/
    );
  });

  it("fits the live caret's quietest opacity to read at 3:1", () => {
    // A cursor that reads at 55% keeps the floor; a dim one raises it.
    expect(resolveInputBarColors(theme).voiceCaretFloor).toBe(0.55);
    const dim = resolveInputBarColors({
      background: "#110f0e",
      foreground: "#c5beb2",
      cursor: "#918a7f",
    });
    expect(dim.voiceCaretFloor).toBeGreaterThan(0.55);
    expect(dim.voiceCaretFloor).toBeLessThanOrEqual(1);
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

  it("floors chip pills so pill and margin fill the content line, without pinning a height", () => {
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
      // The floor plus the vertical margin preserves the single-line size, so
      // it has to track the editor's line-height instead of drifting from it;
      // the margin is the channel between pills on adjacent rows.
      const marginBlock = parseFloat((decls["margin"] ?? "0").split(/\s+/)[0]!);
      expect(marginBlock, `${selector} should leave a channel between rows`).toBeGreaterThan(0);
      expect(
        parseFloat(decls["min-height"]!) + 2 * marginBlock,
        `${selector} should fill the content line-height with its margin`
      ).toBe(parseFloat(contentLineHeight!));
      expect(decls["line-height"], `${selector} should set its own line at the floor`).toBe(
        decls["min-height"]
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

  // Reduced motion keeps the fade and drops the rise: the override swaps to a
  // keyframe that animates opacity alone, never to `animation: none`.
  function expectFadeOnly(rule: string, label: string) {
    const name = /animation:\s*([\w-]+)/.exec(rule)?.[1];
    expect(name, `${label} keeps an animation`).toBeTruthy();
    expect(name).not.toBe("none");
    const css = readGeneratedCss([chipEntranceTheme]);
    const keyframes = extractAtRuleBody(css, `@keyframes ${name}`);
    expect(keyframes, `${label} keyframe`).toContain("opacity");
    expect(keyframes, `${label} keyframe moves`).not.toMatch(/transform|translate|scale/);
  }

  it("keeps only the fade under prefers-reduced-motion", () => {
    const css = readGeneratedCss([chipEntranceTheme]);
    const reducedBlock = extractAtRuleBody(css, "@media (prefers-reduced-motion: reduce)");
    for (const selector of ALL_CHIP_SELECTORS) {
      expectFadeOnly(
        extractRuleBody(reducedBlock, selector),
        `${selector} reduced-motion override`
      );
    }
  });

  it("keeps only the fade under body[data-reduce-animations='true']", () => {
    const css = readGeneratedCss([chipEntranceTheme]);
    for (const selector of ALL_CHIP_SELECTORS) {
      const composed = `body[data-reduce-animations="true"] ${selector}`;
      expectFadeOnly(extractRuleBody(css, composed), `${composed} override`);
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

function withoutMediaBlocks(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf("@media", i);
    if (at === -1) return out + css.slice(i);
    out += css.slice(i, at);
    let depth = 0;
    let j = css.indexOf("{", at);
    for (; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}" && --depth === 0) break;
    }
    i = j + 1;
  }
  return out;
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
  // `text-wrap` is itself a shorthand (`<mode> <style>`, e.g. `nowrap pretty`).
  return [decls["text-wrap"], decls["text-wrap-mode"]].some(
    (v) => v?.split(/\s+/).includes("nowrap") ?? false
  );
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
const UNCAPPED_SIZES = new Set([
  "auto",
  "100%",
  "fit-content",
  "stretch",
  "-webkit-fill-available",
]);

// A max-* cap only constrains when it can resolve below the content's width, so
// `none` and `max-content` leave the chip free where a definite `width` would not.
const UNCAPPED_MAX_SIZES = new Set([...UNCAPPED_SIZES, "none", "max-content"]);

function capsInlineSize(decls: Record<string, string>): boolean {
  const capped = (prop: string, uncapped: Set<string>) => {
    const value = decls[prop];
    return value !== undefined && !uncapped.has(value);
  };
  return (
    capped("width", UNCAPPED_SIZES) ||
    capped("inline-size", UNCAPPED_SIZES) ||
    capped("max-width", UNCAPPED_MAX_SIZES) ||
    capped("max-inline-size", UNCAPPED_MAX_SIZES)
  );
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
  it("returns true when pending matches range", () => {
    expect(isChipSelected({ from: 0, to: 5 }, 0, 5)).toBe(true);
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

describe("createComboboxAttributes", () => {
  const attrsFor = (attrs: Parameters<typeof createComboboxAttributes>[0]) => {
    const state = EditorState.create({ extensions: [createComboboxAttributes(attrs)] });
    return Object.assign({}, ...state.facet(EditorView.contentAttributes)) as Record<
      string,
      string
    >;
  };

  it("points at the list and its active row only while the list is showing", () => {
    const open = attrsFor({ listboxId: "lb", expanded: true, activeOptionId: "lb-option-2" });
    expect(open.role).toBe("combobox");
    expect(open["aria-expanded"]).toBe("true");
    expect(open["aria-controls"]).toBe("lb");
    expect(open["aria-activedescendant"]).toBe("lb-option-2");

    const closed = attrsFor({ listboxId: "lb", expanded: false, activeOptionId: "lb-option-2" });
    expect(closed.role).toBe("combobox");
    expect(closed["aria-expanded"]).toBe("false");
    expect(closed["aria-controls"]).toBeUndefined();
    expect(closed["aria-activedescendant"]).toBeUndefined();
  });

  it("adds nothing before the composer has a list to point at", () => {
    expect(attrsFor(null).role).toBeUndefined();
  });
});
