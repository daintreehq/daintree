import { EditorView, Decoration, keymap, placeholder } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { StateField, StateEffect, Prec } from "@codemirror/state";
import { insertNewline } from "@codemirror/commands";
import type { ITheme } from "@xterm/xterm";
import { resolveInputBarColors } from "@/utils/terminalTheme";

const MAX_TEXTAREA_HEIGHT_PX = 160;
const LINE_HEIGHT_PX = 20;

export const TERMINAL_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/></svg>`;

const INLINE_CHIP_BASE = {
  display: "inline-flex",
  alignItems: "center",
  height: "20px",
  verticalAlign: "bottom",
  whiteSpace: "nowrap",
  gap: "4px",
  padding: "0 5px",
  fontWeight: 600,
  borderRadius: "3px",
} as const;

const CHIP_SVG_SIZE = {
  height: "14px",
  width: "14px",
  flexShrink: "0",
} as const;

export function buildInputBarTheme(theme: ITheme): Extension {
  const c = resolveInputBarColors(theme);

  const chipStyle = {
    ...INLINE_CHIP_BASE,
    color: c.accent,
    background: `color-mix(in oklab, ${c.chipColor} 10%, transparent)`,
  };

  return EditorView.theme(
    {
      "&": {
        backgroundColor: "transparent",
        height: "auto",
      },
      "&.cm-focused": {
        outline: "none",
      },
      ".cm-content": {
        fontFamily: "var(--font-mono, monospace)",
        fontSize: "12px",
        lineHeight: "20px",
        padding: "0 4px 0 0",
        caretColor: c.accent,
      },
      "&.cm-focused .cm-cursor": {
        borderLeft: `2px solid ${c.accent}`,
      },
      "& .cm-selectionBackground": {
        backgroundColor: `color-mix(in oklab, ${c.accent} 25%, transparent) !important`,
      },
      "&.cm-focused .cm-selectionBackground": {
        backgroundColor: `color-mix(in oklab, ${c.accent} 45%, transparent) !important`,
      },
      ".cm-dropCursor": {
        borderLeftColor: c.accent,
      },
      ".cm-placeholder": {
        color: `color-mix(in oklab, ${c.foreground} 48%, transparent)`,
      },
      ".cm-scroller": {
        overflow: "hidden",
      },
      ".cm-line": {
        padding: "0",
      },
      ".cm-slash-command-chip": {
        fontWeight: 600,
        color: c.accent,
        textDecoration: "underline dotted 1px",
        textUnderlineOffset: "2px",
      },
      ".cm-slash-command-chip-invalid": {
        color: c.errorColor,
        textDecoration: "underline wavy 1px",
        textUnderlineOffset: "2px",
      },
      ".cm-file-chip": {
        fontWeight: 600,
        color: c.chipColor,
        textDecoration: "underline dotted 1px",
        textUnderlineOffset: "2px",
      },
      ".cm-tooltip": {
        background: "transparent",
        border: "none",
        boxShadow: "none",
      },
      ".cm-tooltip-hover": {
        background: "transparent",
        border: "none",
        boxShadow: "none",
      },
      ".cm-image-chip": {
        ...chipStyle,
      },
      ".cm-image-chip img": {
        height: "16px",
        width: "16px",
        objectFit: "cover",
        borderRadius: "2px",
        flexShrink: "0",
      },
      ".cm-file-drop-chip": {
        ...chipStyle,
      },
      ".cm-file-drop-chip svg": CHIP_SVG_SIZE,
      ".cm-chip-remove": {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "14px",
        height: "14px",
        marginLeft: "2px",
        borderRadius: "2px",
        color: `color-mix(in oklab, ${c.foreground} 55%, transparent)`,
        cursor: "pointer",
        flexShrink: "0",
        opacity: "0",
        pointerEvents: "none",
        transition: "opacity 100ms ease-out",
        lineHeight: "1",
        fontSize: "12px",
        border: "none",
        background: "transparent",
        padding: "0",
      },
      ".cm-image-chip:hover .cm-chip-remove, .cm-file-drop-chip:hover .cm-chip-remove": {
        opacity: "1",
        pointerEvents: "auto",
      },
      ".cm-chip-remove:hover": {
        color: c.foreground,
        background: `color-mix(in oklab, ${c.foreground} 10%, transparent)`,
      },
      ".cm-diff-chip": {
        ...chipStyle,
      },
      ".cm-diff-chip svg": CHIP_SVG_SIZE,
      ".cm-terminal-chip": {
        ...chipStyle,
      },
      ".cm-terminal-chip svg": CHIP_SVG_SIZE,
      ".cm-selection-chip": {
        ...chipStyle,
      },
      ".cm-selection-chip svg": CHIP_SVG_SIZE,
      ".cm-voice-interim": {
        opacity: "0.55",
        fontStyle: "italic",
        transition: "opacity 150ms ease-out",
      },
      ".cm-voice-pending-ai": {
        textDecorationLine: "underline",
        textDecorationStyle: "dotted",
        textDecorationColor: `color-mix(in oklab, ${c.successColor} 82%, transparent)`,
        textDecorationThickness: "2px",
        textUnderlineOffset: "3px",
        transition: "text-decoration-color 150ms ease-out",
      },
    },
    { dark: true }
  );
}

const interimMark = Decoration.mark({ class: "cm-voice-interim" });

export const setInterimRange = StateEffect.define<{ from: number; to: number } | null>();

export const interimMarkField = StateField.define({
  create() {
    return Decoration.none;
  },
  update(value, tr) {
    if (tr.docChanged) {
      value = value.map(tr.changes);
    }
    for (const effect of tr.effects) {
      if (effect.is(setInterimRange)) {
        const range = effect.value;
        if (!range) return Decoration.none;
        const docLen = tr.state.doc.length;
        if (range.from >= 0 && range.to <= docLen && range.from < range.to) {
          return Decoration.set([interimMark.range(range.from, range.to)]);
        }
        return Decoration.none;
      }
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const pendingAIMark = Decoration.mark({ class: "cm-voice-pending-ai" });

export const setPendingAIRanges = StateEffect.define<{ from: number; to: number }[]>();

export const pendingAIField = StateField.define({
  create() {
    return Decoration.none;
  },
  update(value, tr) {
    if (tr.docChanged) {
      value = value.map(tr.changes);
    }
    for (const effect of tr.effects) {
      if (effect.is(setPendingAIRanges)) {
        const ranges = effect.value;
        if (ranges.length === 0) return Decoration.none;
        const docLen = tr.state.doc.length;
        const marks = ranges
          .map((r) => ({
            from: Math.max(0, r.from),
            to: Math.min(docLen, r.to),
          }))
          .filter((r) => r.from < r.to)
          .map((r) => pendingAIMark.range(r.from, r.to));
        return marks.length > 0 ? Decoration.set(marks, true) : Decoration.none;
      }
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export interface AutoSizeConfig {
  lineHeightPx?: number;
  maxHeightPx?: number;
}

const EPSILON_PX = 2;

export function computeAutoSize(
  contentHeight: number,
  lineHeightPx: number,
  maxHeightPx: number,
  isEmpty: boolean = false
) {
  if (lineHeightPx <= 0) {
    return { next: maxHeightPx, shouldScroll: false };
  }

  if (isEmpty) {
    return { next: lineHeightPx, shouldScroll: false };
  }

  const adjustedHeight = contentHeight - EPSILON_PX;
  const lines = Math.max(1, Math.ceil(adjustedHeight / lineHeightPx));
  const snapped = lines * lineHeightPx;
  const next = Math.min(snapped, maxHeightPx);
  return { next, shouldScroll: snapped > maxHeightPx };
}

export function createAutoSize(config: AutoSizeConfig = {}) {
  const configLineHeightPx = config.lineHeightPx;
  const maxHeightPx = config.maxHeightPx ?? MAX_TEXTAREA_HEIGHT_PX;
  let lastHeight = 0;
  let lastOverflowY = "";

  return EditorView.updateListener.of((update) => {
    if (!update.docChanged && !update.viewportChanged && !update.geometryChanged) return;

    const view = update.view;

    view.requestMeasure({
      read() {
        const lineHeight =
          configLineHeightPx != null && configLineHeightPx > 0
            ? configLineHeightPx
            : view.defaultLineHeight > 0
              ? view.defaultLineHeight
              : LINE_HEIGHT_PX;
        const isEmpty = view.state.doc.length === 0;
        return computeAutoSize(view.contentHeight, lineHeight, maxHeightPx, isEmpty);
      },
      write(measured) {
        if (measured.next !== lastHeight) {
          lastHeight = measured.next;
          view.dom.style.height = `${measured.next}px`;
        }

        const newOverflowY = measured.shouldScroll ? "auto" : "hidden";
        if (newOverflowY !== lastOverflowY) {
          lastOverflowY = newOverflowY;
          view.scrollDOM.style.overflowY = newOverflowY;
        }
      },
    });
  });
}

interface CustomKeymapConfig {
  onEnter: () => boolean;
  onEscape: () => boolean;
  onArrowUp: () => boolean;
  onArrowDown: () => boolean;
  onArrowLeft: () => boolean;
  onArrowRight: () => boolean;
  onTab: () => boolean;
  onCtrlC: (hasSelection: boolean) => boolean;
  onStash: () => boolean;
  onPopStash: () => boolean;
  onExpand: () => boolean;
  onHistorySearch: () => boolean;
}

export function createCustomKeymap(config: CustomKeymapConfig): Extension {
  return Prec.highest(
    keymap.of([
      {
        key: "Enter",
        run() {
          return config.onEnter();
        },
      },
      {
        key: "Shift-Enter",
        run: insertNewline,
      },
      {
        key: "Alt-Enter",
        run: insertNewline,
      },
      {
        key: "Escape",
        run() {
          return config.onEscape();
        },
      },
      {
        key: "ArrowUp",
        run() {
          return config.onArrowUp();
        },
      },
      {
        key: "ArrowDown",
        run() {
          return config.onArrowDown();
        },
      },
      {
        key: "ArrowLeft",
        run() {
          return config.onArrowLeft();
        },
      },
      {
        key: "ArrowRight",
        run() {
          return config.onArrowRight();
        },
      },
      {
        key: "Tab",
        run() {
          return config.onTab();
        },
      },
      {
        key: "Ctrl-c",
        run(view) {
          const hasSelection = !view.state.selection.main.empty;
          return config.onCtrlC(hasSelection);
        },
      },
      {
        key: "Mod-Shift-s",
        run() {
          return config.onStash();
        },
      },
      {
        key: "Mod-Shift-x",
        run() {
          return config.onPopStash();
        },
      },
      {
        key: "Mod-Shift-e",
        run() {
          return config.onExpand();
        },
      },
      {
        key: "Mod-r",
        run() {
          return config.onHistorySearch();
        },
      },
    ])
  );
}

export function createPlaceholder(text: string): Extension {
  return placeholder(text);
}

export function createContentAttributes(): Extension {
  return EditorView.contentAttributes.of({
    spellcheck: "false",
    autocorrect: "off",
    autocapitalize: "off",
    autocomplete: "off",
  });
}

export function createPlainPasteKeymap(): Extension {
  return Prec.highest(
    keymap.of([
      {
        key: "Mod-Shift-v",
        run(view) {
          navigator.clipboard.readText().then((text) => {
            if (!text) return;
            const { from, to } = view.state.selection.main;
            view.dispatch({
              changes: { from, to, insert: text },
              selection: { anchor: from + text.length },
            });
          });
          return true;
        },
      },
    ])
  );
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function removeChipRange(view: EditorView, from: number, to: number): void {
  const doc = view.state.doc.toString();
  const deleteTo = to < doc.length && doc[to] === " " ? to + 1 : to;
  view.dispatch({ changes: { from, to: deleteTo, insert: "" } });
  view.focus();
}

export function formatChipLabel(filePath: string): string {
  const match = filePath.match(/clipboard-(\d+)-/);
  if (match) {
    const date = new Date(Number(match[1]));
    if (!isNaN(date.getTime())) {
      const hh = String(date.getHours()).padStart(2, "0");
      const mm = String(date.getMinutes()).padStart(2, "0");
      return `Screenshot ${hh}:${mm}`;
    }
  }
  return "Screenshot";
}
