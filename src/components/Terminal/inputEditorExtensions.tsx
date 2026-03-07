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
import { getLeadingSlashCommand, getAllAtFileTokens, type AtFileToken } from "./hybridInputParsing";

const MAX_TEXTAREA_HEIGHT_PX = 160;
const LINE_HEIGHT_PX = 20;

export const inputTheme = EditorView.theme({
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
    backgroundColor: "color-mix(in oklab, var(--theme-accent-primary) 18%, transparent)",
  },
  "&.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in oklab, var(--theme-accent-primary) 32%, transparent)",
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
});

const slashChipMark = Decoration.mark({ class: "cm-slash-command-chip" });
const invalidChipMark = Decoration.mark({
  class: "cm-slash-command-chip cm-slash-command-chip-invalid",
});

interface SlashChipFieldConfig {
  commandMap: Map<string, SlashCommand>;
}

export function createSlashChipField(config: SlashChipFieldConfig) {
  return StateField.define({
    create(state) {
      const token = getLeadingSlashCommand(state.doc.toString());
      if (!token) return Decoration.none;

      const isValid = config.commandMap.has(token.command);
      const mark = isValid ? slashChipMark : invalidChipMark;

      return Decoration.set([mark.range(token.start, token.end)]);
    },
    update(deco, tr) {
      if (!tr.docChanged) return deco;

      const token = getLeadingSlashCommand(tr.state.doc.toString());
      if (!token) return Decoration.none;

      const isValid = config.commandMap.has(token.command);
      const mark = isValid ? slashChipMark : invalidChipMark;

      return Decoration.set([mark.range(token.start, token.end)]);
    },
    provide: (f) => EditorView.decorations.from(f),
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
    const token = getLeadingSlashCommand(view.state.doc.toString());
    if (!token || pos < token.start || pos >= token.end) return null;

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

function buildFileChipState(text: string): FileChipState {
  const tokens = getAllAtFileTokens(text);
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
          const filePath = (file as unknown as { path?: string })?.path;
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
