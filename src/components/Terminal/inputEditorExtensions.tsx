import {
  EditorView,
  Decoration,
  WidgetType,
  hoverTooltip,
  keymap,
  placeholder,
} from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { StateField, StateEffect, Prec, Compartment } from "@codemirror/state";
import { insertNewline } from "@codemirror/commands";
import type { SlashCommand } from "@shared/types";
import {
  getAllSlashCommandTokens,
  getAllAtFileTokens,
  getAllAtDiffTokens,
  getAllAtTerminalTokens,
  getAllAtSelectionTokens,
  type AtFileToken,
  type AtDiffToken,
  type AtTerminalToken,
  type AtSelectionToken,
  type SlashCommandToken,
  type DiffContextType,
} from "./hybridInputParsing";

const MAX_TEXTAREA_HEIGHT_PX = 160;
const LINE_HEIGHT_PX = 20;

export const inputTheme = EditorView.theme(
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
      caretColor: "var(--theme-accent-primary)",
    },
    "&.cm-focused .cm-cursor": {
      borderLeft: "2px solid var(--theme-accent-primary)",
    },
    "& .cm-selectionBackground": {
      backgroundColor:
        "color-mix(in oklab, var(--theme-accent-primary) 25%, transparent) !important",
    },
    "&.cm-focused .cm-selectionBackground": {
      backgroundColor:
        "color-mix(in oklab, var(--theme-accent-primary) 45%, transparent) !important",
    },
    ".cm-dropCursor": {
      borderLeftColor: "var(--theme-accent-primary)",
    },
    ".cm-placeholder": {
      color: "color-mix(in oklab, var(--theme-text-primary) 25%, transparent)",
    },
    ".cm-scroller": {
      overflow: "hidden",
    },
    ".cm-line": {
      padding: "0",
    },
    ".cm-slash-command-chip": {
      fontWeight: 600,
      color: "var(--theme-accent-primary)",
      textDecoration: "underline dotted 1px",
      textUnderlineOffset: "2px",
    },
    ".cm-slash-command-chip-invalid": {
      color: "var(--theme-terminal-red)",
      textDecoration: "underline wavy 1px",
      textUnderlineOffset: "2px",
    },
    ".cm-file-chip": {
      fontWeight: 600,
      color: "var(--theme-syntax-chip)",
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
      display: "inline-flex",
      alignItems: "center",
      height: "20px",
      verticalAlign: "bottom",
      whiteSpace: "nowrap",
      gap: "4px",
      padding: "0 5px",
      color: "var(--theme-accent-primary)",
      fontWeight: 600,
      background: "color-mix(in oklab, var(--theme-syntax-chip) 10%, transparent)",
      borderRadius: "3px",
    },
    ".cm-image-chip img": {
      height: "16px",
      width: "16px",
      objectFit: "cover",
      borderRadius: "2px",
      flexShrink: "0",
    },
    ".cm-file-drop-chip": {
      display: "inline-flex",
      alignItems: "center",
      height: "20px",
      verticalAlign: "bottom",
      whiteSpace: "nowrap",
      gap: "4px",
      padding: "0 5px",
      color: "var(--theme-accent-primary)",
      fontWeight: 600,
      background: "color-mix(in oklab, var(--theme-syntax-chip) 10%, transparent)",
      borderRadius: "3px",
    },
    ".cm-file-drop-chip svg": {
      height: "14px",
      width: "14px",
      flexShrink: "0",
    },
    ".cm-diff-chip": {
      display: "inline-flex",
      alignItems: "center",
      height: "20px",
      verticalAlign: "bottom",
      whiteSpace: "nowrap",
      gap: "4px",
      padding: "0 5px",
      color: "var(--theme-accent-primary)",
      fontWeight: 600,
      background: "color-mix(in oklab, var(--theme-syntax-chip) 10%, transparent)",
      borderRadius: "3px",
    },
    ".cm-diff-chip svg": {
      height: "14px",
      width: "14px",
      flexShrink: "0",
    },
    ".cm-terminal-chip": {
      display: "inline-flex",
      alignItems: "center",
      height: "20px",
      verticalAlign: "bottom",
      whiteSpace: "nowrap",
      gap: "4px",
      padding: "0 5px",
      color: "var(--theme-accent-primary)",
      fontWeight: 600,
      background: "color-mix(in oklab, var(--theme-syntax-chip) 10%, transparent)",
      borderRadius: "3px",
    },
    ".cm-terminal-chip svg": {
      height: "14px",
      width: "14px",
      flexShrink: "0",
    },
    ".cm-selection-chip": {
      display: "inline-flex",
      alignItems: "center",
      height: "20px",
      verticalAlign: "bottom",
      whiteSpace: "nowrap",
      gap: "4px",
      padding: "0 5px",
      color: "var(--theme-accent-primary)",
      fontWeight: 600,
      background: "color-mix(in oklab, var(--theme-syntax-chip) 10%, transparent)",
      borderRadius: "3px",
    },
    ".cm-selection-chip svg": {
      height: "14px",
      width: "14px",
      flexShrink: "0",
    },
    ".cm-url-fetch-btn": {
      display: "inline-flex",
      alignItems: "center",
      height: "16px",
      verticalAlign: "text-bottom",
      padding: "0 4px",
      marginLeft: "2px",
      fontSize: "10px",
      fontWeight: 600,
      color: "var(--theme-accent-primary)",
      background: "color-mix(in oklab, var(--theme-accent-primary) 12%, transparent)",
      borderRadius: "3px",
      cursor: "pointer",
      border: "none",
      outline: "none",
      lineHeight: "16px",
      whiteSpace: "nowrap" as const,
    },
    ".cm-url-fetch-btn:hover": {
      background: "color-mix(in oklab, var(--theme-accent-primary) 22%, transparent)",
    },
    ".cm-url-fetch-btn.loading": {
      opacity: "0.6",
      cursor: "default",
    },
    ".cm-url-fetch-btn.error": {
      color: "var(--theme-terminal-red)",
      background: "color-mix(in oklab, var(--theme-terminal-red) 12%, transparent)",
    },
    ".cm-url-context-chip": {
      display: "inline-flex",
      alignItems: "center",
      height: "20px",
      verticalAlign: "bottom",
      whiteSpace: "nowrap",
      gap: "4px",
      padding: "0 5px",
      color: "var(--theme-accent-primary)",
      fontWeight: 600,
      background: "color-mix(in oklab, var(--theme-syntax-chip) 10%, transparent)",
      borderRadius: "3px",
      maxWidth: "300px",
      overflow: "hidden",
    },
    ".cm-url-context-chip .chip-title": {
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    },
    ".cm-url-context-chip .chip-tokens": {
      fontSize: "10px",
      opacity: "0.7",
      flexShrink: "0",
    },
    ".cm-voice-interim": {
      opacity: "0.55",
      fontStyle: "italic",
      transition: "opacity 150ms ease-out",
    },
    ".cm-voice-pending-ai": {
      textDecorationLine: "underline",
      textDecorationStyle: "dotted",
      textDecorationColor: "color-mix(in oklab, var(--theme-terminal-green) 82%, transparent)",
      textDecorationThickness: "2px",
      textUnderlineOffset: "3px",
      transition: "text-decoration-color 150ms ease-out",
    },
  },
  { dark: true }
);

// --- Interim mark field (character-level, for live delta text in interim phase) ---

const interimMark = Decoration.mark({ class: "cm-voice-interim" });

export const setInterimRange = StateEffect.define<{ from: number; to: number } | null>();

export const interimMarkField = StateField.define({
  create() {
    return Decoration.none;
  },
  update(value, tr) {
    // Always map through document changes first to keep offsets valid
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

const slashChipMark = Decoration.mark({ class: "cm-slash-command-chip" });
const invalidChipMark = Decoration.mark({
  class: "cm-slash-command-chip cm-slash-command-chip-invalid",
});

interface SlashChipFieldConfig {
  commandMap: Map<string, SlashCommand>;
}

interface SlashChipState {
  decorations: ReturnType<typeof Decoration.set>;
  tokens: SlashCommandToken[];
}

function buildSlashChipState(text: string, config: SlashChipFieldConfig): SlashChipState {
  const tokens = getAllSlashCommandTokens(text);
  if (tokens.length === 0) {
    return { decorations: Decoration.none, tokens: [] };
  }

  const ranges = tokens.map((token) => {
    const isValid = config.commandMap.has(token.command);
    const mark = isValid ? slashChipMark : invalidChipMark;
    return mark.range(token.start, token.end);
  });

  return { decorations: Decoration.set(ranges), tokens };
}

export function createSlashChipField(config: SlashChipFieldConfig) {
  return StateField.define<SlashChipState>({
    create(state) {
      return buildSlashChipState(state.doc.toString(), config);
    },
    update(value, tr) {
      if (!tr.docChanged) return value;
      return buildSlashChipState(tr.state.doc.toString(), config);
    },
    provide: (f) => EditorView.decorations.from(f, (state) => state.decorations),
  });
}

function createTooltipContent(command: SlashCommand): HTMLElement {
  const container = document.createElement("div");
  container.className = "max-w-[260px]";

  // Simple one-line description
  const description = document.createElement("p");
  description.className = "text-[11px] text-text-primary/80 leading-snug";
  description.textContent = command.description ?? command.label ?? "";
  container.appendChild(description);

  return container;
}

export function createSlashTooltip(commandMap: Map<string, SlashCommand>) {
  return hoverTooltip((view, pos) => {
    const tokens = getAllSlashCommandTokens(view.state.doc.toString());
    const token = tokens.find((t) => pos >= t.start && pos < t.end);
    if (!token) return null;

    const command = commandMap.get(token.command);
    if (!command) return null;

    return {
      pos: token.start,
      end: token.end,
      above: true,
      create() {
        const dom = document.createElement("div");
        dom.className = "px-2 py-1 text-xs";
        dom.style.cssText = `
          background: color-mix(in oklab, var(--theme-surface-canvas) 95%, transparent);
          border-radius: 4px;
          border: 1px solid var(--theme-border-subtle);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        `;

        dom.appendChild(createTooltipContent(command));

        return { dom };
      },
    };
  });
}

const fileChipMark = Decoration.mark({ class: "cm-file-chip" });

interface FileChipState {
  decorations: ReturnType<typeof Decoration.set>;
  tokens: AtFileToken[];
}

const RESERVED_TOKEN_PATHS = new Set(["diff", "diff:staged", "diff:head", "terminal", "selection"]);

function buildFileChipState(text: string): FileChipState {
  const tokens = getAllAtFileTokens(text).filter((t) => !RESERVED_TOKEN_PATHS.has(t.path));
  if (tokens.length === 0) {
    return { decorations: Decoration.none, tokens: [] };
  }

  const decorations = tokens.map((token) => fileChipMark.range(token.start, token.end));
  return { decorations: Decoration.set(decorations), tokens };
}

const fileChipStateField = StateField.define<FileChipState>({
  create(state) {
    return buildFileChipState(state.doc.toString());
  },
  update(value, tr) {
    if (!tr.docChanged) return value;
    return buildFileChipState(tr.state.doc.toString());
  },
  provide: (f) => EditorView.decorations.from(f, (state) => state.decorations),
});

export function createFileChipField() {
  return fileChipStateField;
}

function createFileTooltipContent(token: AtFileToken): HTMLElement {
  const container = document.createElement("div");
  container.className = "max-w-[300px]";

  const pathEl = document.createElement("p");
  pathEl.className = "text-[11px] text-canopy-text/90 leading-snug font-mono break-all";
  pathEl.textContent = token.path;
  container.appendChild(pathEl);

  return container;
}

export function createFileChipTooltip() {
  return hoverTooltip((view, pos) => {
    // Reuse cached tokens from the state field instead of re-parsing
    const chipState = view.state.field(fileChipStateField, false);
    if (!chipState) return null;

    const token = chipState.tokens.find((t) => pos >= t.start && pos < t.end);
    if (!token) return null;

    return {
      pos: token.start,
      end: token.end,
      above: true,
      create() {
        const dom = document.createElement("div");
        dom.className = "px-2 py-1 text-xs";
        dom.style.cssText = `
          background: rgba(24, 24, 27, 0.95);
          border-radius: 4px;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        `;

        dom.appendChild(createFileTooltipContent(token));

        return { dom };
      },
    };
  });
}

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
  // Guard against invalid configuration
  if (lineHeightPx <= 0) {
    return { next: maxHeightPx, shouldScroll: false };
  }

  // Always return single-line height for empty documents
  if (isEmpty) {
    return { next: lineHeightPx, shouldScroll: false };
  }

  // Add epsilon tolerance to prevent zoom-induced fractional rounding from inflating line count
  const adjustedHeight = contentHeight - EPSILON_PX;
  const lines = Math.max(1, Math.ceil(adjustedHeight / lineHeightPx));
  const snapped = lines * lineHeightPx;
  const next = Math.min(snapped, maxHeightPx);
  // Align overflow behavior with epsilon-adjusted snapping to avoid
  // zoom-only fractional overflow toggling scrollbars at the max boundary
  return { next, shouldScroll: snapped > maxHeightPx };
}

export function createAutoSize(config: AutoSizeConfig = {}) {
  const configLineHeightPx = config.lineHeightPx; // undefined = not explicitly set
  const maxHeightPx = config.maxHeightPx ?? MAX_TEXTAREA_HEIGHT_PX;
  let lastHeight = 0;
  let lastOverflowY = "";

  return EditorView.updateListener.of((update) => {
    if (!update.docChanged && !update.viewportChanged && !update.geometryChanged) return;

    const view = update.view;

    // Use requestMeasure to ensure we read contentHeight after CodeMirror's layout pass
    view.requestMeasure({
      read() {
        // Use view.defaultLineHeight as the authoritative line height from CodeMirror's font
        // metrics. It is unaffected by inline chip decorations (which would skew a DOM-measured
        // .cm-line height and cause the snap increment to be wrong on lines without chips).
        // An explicit configLineHeightPx takes priority (used in tests and custom configurations).
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

        // Guard overflowY writes to avoid triggering unnecessary geometry updates that
        // can cause a secondary measure cycle (and visible height oscillation) when
        // the overflow value hasn't actually changed.
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

export function createSlashChipCompartment() {
  return new Compartment();
}

export function createSlashTooltipCompartment() {
  return new Compartment();
}

// --- Image chip (replace widget showing thumbnail + filename for pasted image paths) ---

interface ImageChipEntry {
  from: number;
  to: number;
  filePath: string;
  thumbnailUrl: string;
}

function formatChipLabel(filePath: string): string {
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

class ImageChipWidget extends WidgetType {
  constructor(
    readonly filePath: string,
    readonly thumbnailUrl: string
  ) {
    super();
  }

  eq(other: ImageChipWidget) {
    return this.filePath === other.filePath;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-image-chip";
    span.setAttribute("role", "img");
    span.setAttribute("aria-label", `Image: ${this.filePath}`);

    const img = document.createElement("img");
    img.src = this.thumbnailUrl;
    img.alt = "";
    img.setAttribute("aria-hidden", "true");
    span.appendChild(img);

    const label = document.createElement("span");
    label.setAttribute("aria-hidden", "true");
    label.textContent = formatChipLabel(this.filePath);
    span.appendChild(label);

    return span;
  }

  ignoreEvent() {
    return false;
  }
}

export const addImageChip = StateEffect.define<ImageChipEntry>();

export const imageChipField = StateField.define<ImageChipEntry[]>({
  create() {
    return [];
  },
  update(entries, tr) {
    if (tr.docChanged) {
      const surviving: ImageChipEntry[] = [];
      for (const e of entries) {
        let edited = false;
        tr.changes.iterChangedRanges((fromA, toA) => {
          if (fromA < e.to && toA > e.from) edited = true;
        });
        if (edited) continue;
        const from = tr.changes.mapPos(e.from, 1);
        const to = tr.changes.mapPos(e.to, -1);
        if (from < to) surviving.push({ ...e, from, to });
      }
      entries = surviving;
    }
    for (const effect of tr.effects) {
      if (effect.is(addImageChip)) {
        entries = [...entries, effect.value];
      }
    }
    return entries;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (entries) => {
      if (entries.length === 0) return Decoration.none;
      const ranges = entries.map((e) =>
        Decoration.replace({ widget: new ImageChipWidget(e.filePath, e.thumbnailUrl) }).range(
          e.from,
          e.to
        )
      );
      return Decoration.set(ranges, true);
    }),
    EditorView.atomicRanges.of((view) => {
      const entries = view.state.field(f, false);
      if (!entries || entries.length === 0) return Decoration.none;
      const ranges = entries.map((e) => Decoration.mark({}).range(e.from, e.to));
      return Decoration.set(ranges, true);
    }),
  ],
});

export function createImageChipTooltip() {
  return hoverTooltip((view, pos) => {
    const entries = view.state.field(imageChipField, false);
    if (!entries || entries.length === 0) return null;

    const entry = entries.find((e) => pos >= e.from && pos <= e.to);
    if (!entry) return null;

    return {
      pos: entry.from,
      end: entry.to,
      above: true,
      create() {
        const dom = document.createElement("div");
        dom.className = "px-2 py-2";
        dom.style.cssText = `
          background: rgba(24, 24, 27, 0.95);
          border-radius: 6px;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
        `;

        const img = document.createElement("img");
        img.src = entry.thumbnailUrl;
        img.alt = "Screenshot preview";
        img.style.cssText =
          "max-width: 200px; max-height: 200px; border-radius: 4px; display: block;";
        dom.appendChild(img);

        const pathEl = document.createElement("p");
        pathEl.style.cssText =
          "font-size: 10px; color: rgba(255,255,255,0.45); margin-top: 4px; word-break: break-all; max-width: 200px;";
        pathEl.textContent = entry.filePath;
        dom.appendChild(pathEl);

        return { dom };
      },
    };
  });
}

export function createImagePasteHandler(onImagePaste: (view: EditorView) => void): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const items = event.clipboardData?.items;
      if (!items) return false;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          event.preventDefault();
          onImagePaste(view);
          return true;
        }
      }
      return false;
    },
  });
}

// --- File drop chip (replace widget showing file icon + filename for pasted file paths) ---

interface FileDropChipEntry {
  from: number;
  to: number;
  filePath: string;
  fileName: string;
}

const FILE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>`;

class FileDropChipWidget extends WidgetType {
  constructor(
    readonly filePath: string,
    readonly fileName: string
  ) {
    super();
  }

  eq(other: FileDropChipWidget) {
    return this.filePath === other.filePath;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-file-drop-chip";
    span.setAttribute("role", "img");
    span.setAttribute("aria-label", `File: ${this.filePath}`);

    const icon = document.createElement("span");
    icon.innerHTML = FILE_ICON_SVG;
    icon.style.display = "inline-flex";
    icon.style.alignItems = "center";
    span.appendChild(icon);

    const label = document.createElement("span");
    label.setAttribute("aria-hidden", "true");
    label.textContent = this.fileName;
    span.appendChild(label);

    return span;
  }

  ignoreEvent() {
    return false;
  }
}

export const addFileDropChip = StateEffect.define<FileDropChipEntry>();

export const fileDropChipField = StateField.define<FileDropChipEntry[]>({
  create() {
    return [];
  },
  update(entries, tr) {
    if (tr.docChanged) {
      const surviving: FileDropChipEntry[] = [];
      for (const e of entries) {
        let edited = false;
        tr.changes.iterChangedRanges((fromA, toA) => {
          if (fromA < e.to && toA > e.from) edited = true;
        });
        if (edited) continue;
        const from = tr.changes.mapPos(e.from, 1);
        const to = tr.changes.mapPos(e.to, -1);
        if (from < to) surviving.push({ ...e, from, to });
      }
      entries = surviving;
    }
    for (const effect of tr.effects) {
      if (effect.is(addFileDropChip)) {
        entries = [...entries, effect.value];
      }
    }
    return entries;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (entries) => {
      if (entries.length === 0) return Decoration.none;
      const ranges = entries.map((e) =>
        Decoration.replace({ widget: new FileDropChipWidget(e.filePath, e.fileName) }).range(
          e.from,
          e.to
        )
      );
      return Decoration.set(ranges, true);
    }),
    EditorView.atomicRanges.of((view) => {
      const entries = view.state.field(f, false);
      if (!entries || entries.length === 0) return Decoration.none;
      const ranges = entries.map((e) => Decoration.mark({}).range(e.from, e.to));
      return Decoration.set(ranges, true);
    }),
  ],
});

export function createFileDropChipTooltip() {
  return hoverTooltip((view, pos) => {
    const entries = view.state.field(fileDropChipField, false);
    if (!entries || entries.length === 0) return null;

    const entry = entries.find((e) => pos >= e.from && pos <= e.to);
    if (!entry) return null;

    return {
      pos: entry.from,
      end: entry.to,
      above: true,
      create() {
        const dom = document.createElement("div");
        dom.className = "px-2 py-1 text-xs";
        dom.style.cssText = `
          background: rgba(24, 24, 27, 0.95);
          border-radius: 4px;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        `;

        const pathEl = document.createElement("p");
        pathEl.style.cssText =
          "font-size: 10px; color: rgba(255,255,255,0.7); word-break: break-all; max-width: 300px; font-family: var(--font-mono, monospace);";
        pathEl.textContent = entry.filePath;
        dom.appendChild(pathEl);

        return { dom };
      },
    };
  });
}

export function createFilePasteHandler(
  onFilePaste: (view: EditorView, files: { path: string; name: string }[]) => void
): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const items = event.clipboardData?.items;
      if (!items) return false;

      const files: { path: string; name: string }[] = [];
      for (const item of items) {
        if (item.kind === "file" && !item.type.startsWith("image/")) {
          const file = item.getAsFile();
          const filePath = file ? window.electron.webUtils.getPathForFile(file) : undefined;
          if (file && filePath) {
            const name =
              file.name.trim() || filePath.split(/[/\\]/).filter(Boolean).pop() || filePath;
            files.push({ path: filePath, name });
          }
        }
      }

      if (files.length === 0) return false;

      event.preventDefault();
      onFilePaste(view, files);
      return true;
    },
  });
}

// --- Diff context chip (replace widget showing git-branch icon + diff label) ---

const DIFF_LABELS: Record<DiffContextType, string> = {
  unstaged: "Working tree diff",
  staged: "Staged diff",
  head: "HEAD diff",
};

const GIT_BRANCH_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>`;

interface DiffChipState {
  decorations: ReturnType<typeof Decoration.set>;
  tokens: AtDiffToken[];
}

function buildDiffChipState(text: string): DiffChipState {
  const tokens = getAllAtDiffTokens(text);
  if (tokens.length === 0) {
    return { decorations: Decoration.none, tokens: [] };
  }

  const decorations = tokens.map((token) =>
    Decoration.replace({
      widget: new DiffChipWidget(token.diffType),
    }).range(token.start, token.end)
  );
  return { decorations: Decoration.set(decorations), tokens };
}

class DiffChipWidget extends WidgetType {
  constructor(readonly diffType: DiffContextType) {
    super();
  }

  eq(other: DiffChipWidget) {
    return this.diffType === other.diffType;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-diff-chip";
    span.setAttribute("role", "img");
    span.setAttribute("aria-label", `Diff: ${DIFF_LABELS[this.diffType]}`);

    const icon = document.createElement("span");
    icon.innerHTML = GIT_BRANCH_ICON_SVG;
    icon.style.display = "inline-flex";
    icon.style.alignItems = "center";
    span.appendChild(icon);

    const label = document.createElement("span");
    label.setAttribute("aria-hidden", "true");
    label.textContent = DIFF_LABELS[this.diffType];
    span.appendChild(label);

    return span;
  }

  ignoreEvent() {
    return false;
  }
}

export const diffChipField = StateField.define<DiffChipState>({
  create(state) {
    return buildDiffChipState(state.doc.toString());
  },
  update(value, tr) {
    if (!tr.docChanged) return value;
    return buildDiffChipState(tr.state.doc.toString());
  },
  provide: (f) => [
    EditorView.decorations.from(f, (state) => state.decorations),
    EditorView.atomicRanges.of((view) => {
      const chipState = view.state.field(f, false);
      if (!chipState || chipState.tokens.length === 0) return Decoration.none;
      const ranges = chipState.tokens.map((t) => Decoration.mark({}).range(t.start, t.end));
      return Decoration.set(ranges, true);
    }),
  ],
});

export function createDiffChipTooltip() {
  return hoverTooltip((view, pos) => {
    const chipState = view.state.field(diffChipField, false);
    if (!chipState) return null;

    const token = chipState.tokens.find((t) => pos >= t.start && pos < t.end);
    if (!token) return null;

    return {
      pos: token.start,
      end: token.end,
      above: true,
      create() {
        const dom = document.createElement("div");
        dom.className = "px-2 py-1 text-xs";
        dom.style.cssText = `
          background: color-mix(in oklab, var(--theme-surface-canvas) 95%, transparent);
          border-radius: 4px;
          border: 1px solid var(--theme-border-subtle);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        `;

        const desc = document.createElement("p");
        desc.className = "text-[11px] text-text-primary/80 leading-snug";
        desc.textContent = `Attaches ${DIFF_LABELS[token.diffType].toLowerCase()} as context`;
        dom.appendChild(desc);

        return { dom };
      },
    };
  });
}

// --- Terminal context chip (replace widget showing terminal icon + label) ---

const TERMINAL_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/></svg>`;

interface TerminalChipState {
  decorations: ReturnType<typeof Decoration.set>;
  tokens: AtTerminalToken[];
}

function buildTerminalChipState(text: string): TerminalChipState {
  const tokens = getAllAtTerminalTokens(text);
  if (tokens.length === 0) {
    return { decorations: Decoration.none, tokens: [] };
  }

  const decorations = tokens.map((token) =>
    Decoration.replace({
      widget: new TerminalBufferChipWidget(),
    }).range(token.start, token.end)
  );
  return { decorations: Decoration.set(decorations), tokens };
}

class TerminalBufferChipWidget extends WidgetType {
  eq() {
    return true;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-terminal-chip";
    span.setAttribute("role", "img");
    span.setAttribute("aria-label", "Terminal output");

    const icon = document.createElement("span");
    icon.innerHTML = TERMINAL_ICON_SVG;
    icon.style.display = "inline-flex";
    icon.style.alignItems = "center";
    span.appendChild(icon);

    const label = document.createElement("span");
    label.setAttribute("aria-hidden", "true");
    label.textContent = "Terminal output";
    span.appendChild(label);

    return span;
  }

  ignoreEvent() {
    return false;
  }
}

export const terminalChipField = StateField.define<TerminalChipState>({
  create(state) {
    return buildTerminalChipState(state.doc.toString());
  },
  update(value, tr) {
    if (!tr.docChanged) return value;
    return buildTerminalChipState(tr.state.doc.toString());
  },
  provide: (f) => [
    EditorView.decorations.from(f, (state) => state.decorations),
    EditorView.atomicRanges.of((view) => {
      const chipState = view.state.field(f, false);
      if (!chipState || chipState.tokens.length === 0) return Decoration.none;
      const ranges = chipState.tokens.map((t) => Decoration.mark({}).range(t.start, t.end));
      return Decoration.set(ranges, true);
    }),
  ],
});

export function createTerminalChipTooltip() {
  return hoverTooltip((view, pos) => {
    const chipState = view.state.field(terminalChipField, false);
    if (!chipState) return null;

    const token = chipState.tokens.find((t) => pos >= t.start && pos < t.end);
    if (!token) return null;

    return {
      pos: token.start,
      end: token.end,
      above: true,
      create() {
        const dom = document.createElement("div");
        dom.className = "px-2 py-1 text-xs";
        dom.style.cssText = `
          background: color-mix(in oklab, var(--theme-surface-canvas) 95%, transparent);
          border-radius: 4px;
          border: 1px solid var(--theme-border-subtle);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        `;

        const desc = document.createElement("p");
        desc.className = "text-[11px] text-text-primary/80 leading-snug";
        desc.textContent = "Attaches last 100 lines of terminal output as context";
        dom.appendChild(desc);

        return { dom };
      },
    };
  });
}

// --- Selection context chip (replace widget showing selection icon + label) ---

interface SelectionChipState {
  decorations: ReturnType<typeof Decoration.set>;
  tokens: AtSelectionToken[];
}

function buildSelectionChipState(text: string): SelectionChipState {
  const tokens = getAllAtSelectionTokens(text);
  if (tokens.length === 0) {
    return { decorations: Decoration.none, tokens: [] };
  }

  const decorations = tokens.map((token) =>
    Decoration.replace({
      widget: new SelectionChipWidget(),
    }).range(token.start, token.end)
  );
  return { decorations: Decoration.set(decorations), tokens };
}

class SelectionChipWidget extends WidgetType {
  eq() {
    return true;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-selection-chip";
    span.setAttribute("role", "img");
    span.setAttribute("aria-label", "Terminal selection");

    const icon = document.createElement("span");
    icon.innerHTML = TERMINAL_ICON_SVG;
    icon.style.display = "inline-flex";
    icon.style.alignItems = "center";
    span.appendChild(icon);

    const label = document.createElement("span");
    label.setAttribute("aria-hidden", "true");
    label.textContent = "Terminal selection";
    span.appendChild(label);

    return span;
  }

  ignoreEvent() {
    return false;
  }
}

export const selectionChipField = StateField.define<SelectionChipState>({
  create(state) {
    return buildSelectionChipState(state.doc.toString());
  },
  update(value, tr) {
    if (!tr.docChanged) return value;
    return buildSelectionChipState(tr.state.doc.toString());
  },
  provide: (f) => [
    EditorView.decorations.from(f, (state) => state.decorations),
    EditorView.atomicRanges.of((view) => {
      const chipState = view.state.field(f, false);
      if (!chipState || chipState.tokens.length === 0) return Decoration.none;
      const ranges = chipState.tokens.map((t) => Decoration.mark({}).range(t.start, t.end));
      return Decoration.set(ranges, true);
    }),
  ],
});

export function createSelectionChipTooltip() {
  return hoverTooltip((view, pos) => {
    const chipState = view.state.field(selectionChipField, false);
    if (!chipState) return null;

    const token = chipState.tokens.find((t) => pos >= t.start && pos < t.end);
    if (!token) return null;

    return {
      pos: token.start,
      end: token.end,
      above: true,
      create() {
        const dom = document.createElement("div");
        dom.className = "px-2 py-1 text-xs";
        dom.style.cssText = `
          background: color-mix(in oklab, var(--theme-surface-canvas) 95%, transparent);
          border-radius: 4px;
          border: 1px solid var(--theme-border-subtle);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        `;

        const desc = document.createElement("p");
        desc.className = "text-[11px] text-text-primary/80 leading-snug";
        desc.textContent = "Attaches current terminal text selection as context";
        dom.appendChild(desc);

        return { dom };
      },
    };
  });
}

// --- URL paste detection and context resolution ---

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;

let nextUrlEntryId = 0;

export interface UrlPasteEntry {
  id: number;
  from: number;
  to: number;
  url: string;
  status: "idle" | "loading" | "error";
  errorMessage?: string;
}

export const addUrlPasteEntry = StateEffect.define<UrlPasteEntry>();
export const updateUrlPasteStatus = StateEffect.define<{
  id: number;
  status: UrlPasteEntry["status"];
  errorMessage?: string;
}>();
export const removeUrlPasteEntry = StateEffect.define<{ id: number }>();

interface UrlContextChipEntry {
  from: number;
  to: number;
  title: string;
  tokenEstimate: number;
  sourceUrl: string;
}

export const addUrlContextChip = StateEffect.define<UrlContextChipEntry>();

class UrlFetchAffordanceWidget extends WidgetType {
  constructor(
    readonly entryId: number,
    readonly url: string,
    readonly status: UrlPasteEntry["status"],
    readonly errorMessage: string | undefined,
    readonly onFetch: (entryId: number, url: string) => void
  ) {
    super();
  }

  eq(other: UrlFetchAffordanceWidget) {
    return this.entryId === other.entryId && this.status === other.status;
  }

  toDOM() {
    const btn = document.createElement("span");
    btn.className = "cm-url-fetch-btn";
    btn.setAttribute("contenteditable", "false");

    if (this.status === "loading") {
      btn.classList.add("loading");
      btn.textContent = "Fetching…";
    } else if (this.status === "error") {
      btn.classList.add("error");
      btn.textContent = "Error";
      if (this.errorMessage) {
        btn.title = this.errorMessage;
      }
    } else {
      btn.textContent = "Fetch";
    }

    const onFetch = this.onFetch;
    const entryId = this.entryId;
    const url = this.url;
    const status = this.status;
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (status !== "loading") {
        onFetch(entryId, url);
      }
    });

    return btn;
  }

  ignoreEvent() {
    return true;
  }
}

class UrlContextChipWidget extends WidgetType {
  constructor(
    readonly title: string,
    readonly tokenEstimate: number,
    readonly sourceUrl: string
  ) {
    super();
  }

  eq(other: UrlContextChipWidget) {
    return this.sourceUrl === other.sourceUrl;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-url-context-chip";
    span.setAttribute("role", "link");
    span.setAttribute("aria-label", `URL context: ${this.title}`);
    span.title = this.sourceUrl;

    const LINK_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
    const icon = document.createElement("span");
    icon.innerHTML = LINK_ICON_SVG;
    icon.style.display = "inline-flex";
    icon.style.alignItems = "center";
    icon.style.flexShrink = "0";
    span.appendChild(icon);

    const titleEl = document.createElement("span");
    titleEl.className = "chip-title";
    titleEl.textContent = this.title;
    span.appendChild(titleEl);

    const tokens = document.createElement("span");
    tokens.className = "chip-tokens";
    tokens.textContent = `~${this.tokenEstimate.toLocaleString()}tk`;
    span.appendChild(tokens);

    return span;
  }

  ignoreEvent() {
    return false;
  }
}

export function createUrlPasteField(
  onFetch: (entryId: number, url: string) => void
): StateField<UrlPasteEntry[]> {
  return StateField.define<UrlPasteEntry[]>({
    create() {
      return [];
    },
    update(entries, tr) {
      if (tr.docChanged) {
        const surviving: UrlPasteEntry[] = [];
        for (const e of entries) {
          let edited = false;
          tr.changes.iterChangedRanges((fromA, toA) => {
            if (fromA < e.to && toA > e.from) edited = true;
          });
          if (edited) continue;
          const from = tr.changes.mapPos(e.from, 1);
          const to = tr.changes.mapPos(e.to, -1);
          if (from < to) surviving.push({ ...e, from, to });
        }
        entries = surviving;
      }

      for (const effect of tr.effects) {
        if (effect.is(addUrlPasteEntry)) {
          entries = [...entries, effect.value];
        }
        if (effect.is(updateUrlPasteStatus)) {
          entries = entries.map((e) =>
            e.id === effect.value.id
              ? { ...e, status: effect.value.status, errorMessage: effect.value.errorMessage }
              : e
          );
        }
        if (effect.is(removeUrlPasteEntry)) {
          entries = entries.filter((e) => e.id !== effect.value.id);
        }
      }
      return entries;
    },
    provide: (f) =>
      EditorView.decorations.from(f, (entries) => {
        if (entries.length === 0) return Decoration.none;
        const ranges = entries.map((e) =>
          Decoration.widget({
            widget: new UrlFetchAffordanceWidget(e.id, e.url, e.status, e.errorMessage, onFetch),
            side: 1,
          }).range(e.to)
        );
        return Decoration.set(ranges, true);
      }),
  });
}

export const urlContextChipField = StateField.define<UrlContextChipEntry[]>({
  create() {
    return [];
  },
  update(entries, tr) {
    if (tr.docChanged) {
      const surviving: UrlContextChipEntry[] = [];
      for (const e of entries) {
        let edited = false;
        tr.changes.iterChangedRanges((fromA, toA) => {
          if (fromA < e.to && toA > e.from) edited = true;
        });
        if (edited) continue;
        const from = tr.changes.mapPos(e.from, 1);
        const to = tr.changes.mapPos(e.to, -1);
        if (from < to) surviving.push({ ...e, from, to });
      }
      entries = surviving;
    }
    for (const effect of tr.effects) {
      if (effect.is(addUrlContextChip)) {
        entries = [...entries, effect.value];
      }
    }
    return entries;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (entries) => {
      if (entries.length === 0) return Decoration.none;
      const ranges = entries.map((e) =>
        Decoration.replace({
          widget: new UrlContextChipWidget(e.title, e.tokenEstimate, e.sourceUrl),
        }).range(e.from, e.to)
      );
      return Decoration.set(ranges, true);
    }),
    EditorView.atomicRanges.of((view) => {
      const entries = view.state.field(f, false);
      if (!entries || entries.length === 0) return Decoration.none;
      const ranges = entries.map((e) => Decoration.mark({}).range(e.from, e.to));
      return Decoration.set(ranges, true);
    }),
  ],
});

export function createUrlPasteDetector(): Extension {
  return EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;

    const pastedRanges: { from: number; to: number }[] = [];
    for (const tr of update.transactions) {
      if (tr.isUserEvent("input.paste")) {
        tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
          pastedRanges.push({ from: fromB, to: toB });
        });
      }
    }
    if (pastedRanges.length === 0) return;

    const effects: ReturnType<typeof addUrlPasteEntry.of>[] = [];
    const doc = update.state.doc.toString();

    for (const range of pastedRanges) {
      const pastedText = doc.slice(range.from, range.to);
      let match: RegExpExecArray | null;
      const regex = new RegExp(URL_REGEX.source, "g");
      while ((match = regex.exec(pastedText)) !== null) {
        const url = match[0];
        const from = range.from + match.index;
        const to = from + url.length;
        effects.push(
          addUrlPasteEntry.of({
            id: nextUrlEntryId++,
            from,
            to,
            url,
            status: "idle",
          })
        );
      }
    }

    if (effects.length > 0) {
      update.view.dispatch({ effects });
    }
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
