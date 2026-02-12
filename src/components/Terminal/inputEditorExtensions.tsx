import { EditorView, Decoration, hoverTooltip, keymap, placeholder } from "@codemirror/view";
import { StateField, Prec, Extension, Compartment } from "@codemirror/state";
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
    caretColor: "var(--color-canopy-accent)",
  },
  "&.cm-focused .cm-cursor": {
    borderLeft: "2px solid var(--color-canopy-accent)",
  },
  "&.cm-focused .cm-selectionBackground": {
    backgroundColor: "rgba(96, 211, 224, 0.22)",
  },
  ".cm-dropCursor": {
    borderLeftColor: "var(--color-canopy-accent)",
  },
  ".cm-placeholder": {
    color: "rgba(255,255,255,0.25)",
  },
  ".cm-scroller": {
    overflow: "hidden",
  },
  ".cm-line": {
    padding: "0",
  },
  ".cm-slash-command-chip": {
    fontWeight: 600,
    color: "var(--color-canopy-accent)",
    textDecoration: "underline dotted 1px",
    textUnderlineOffset: "2px",
  },
  ".cm-slash-command-chip-invalid": {
    color: "rgb(248, 113, 113)",
    textDecoration: "underline wavy 1px",
    textUnderlineOffset: "2px",
  },
  ".cm-file-chip": {
    fontWeight: 600,
    color: "rgb(96, 211, 224)",
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
  description.className = "text-[11px] text-canopy-text/80 leading-snug";
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
          background: rgba(24, 24, 27, 0.95);
          border-radius: 4px;
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

export function computeAutoSize(contentHeight: number, lineHeightPx: number, maxHeightPx: number) {
  // Guard against invalid configuration
  if (lineHeightPx <= 0) {
    return { next: maxHeightPx, shouldScroll: false };
  }

  // Use Math.ceil to avoid clipping the last line when content isn't an exact multiple
  const lines = Math.max(1, Math.ceil(contentHeight / lineHeightPx));
  const snapped = lines * lineHeightPx;
  const next = Math.min(snapped, maxHeightPx);
  return { next, shouldScroll: contentHeight > maxHeightPx };
}

export function createAutoSize(config: AutoSizeConfig = {}) {
  const lineHeightPx = config.lineHeightPx ?? LINE_HEIGHT_PX;
  const maxHeightPx = config.maxHeightPx ?? MAX_TEXTAREA_HEIGHT_PX;
  let lastHeight = 0;

  return EditorView.updateListener.of((update) => {
    if (!update.docChanged && !update.viewportChanged && !update.geometryChanged) return;

    const view = update.view;

    // Use requestMeasure to ensure we read contentHeight after CodeMirror's layout pass
    view.requestMeasure({
      read() {
        // Read phase: measure contentHeight after layout is complete
        return computeAutoSize(view.contentHeight, lineHeightPx, maxHeightPx);
      },
      write(measured) {
        // Write phase: apply DOM updates
        if (measured.next !== lastHeight) {
          lastHeight = measured.next;
          view.dom.style.height = `${measured.next}px`;
        }

        view.scrollDOM.style.overflowY = measured.shouldScroll ? "auto" : "hidden";
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
