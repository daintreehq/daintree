import { EditorView, Decoration, hoverTooltip, keymap, placeholder } from "@codemirror/view";
import { StateField, Prec, Extension, Compartment } from "@codemirror/state";
import { insertNewline } from "@codemirror/commands";
import type { SlashCommand } from "@shared/types";
import { getLeadingSlashCommand } from "./hybridInputParsing";

const MAX_TEXTAREA_HEIGHT_PX = 160;
const LINE_HEIGHT_PX = 20;

export const inputTheme = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    height: "auto",
  },
  ".cm-content": {
    fontFamily: "var(--font-mono, monospace)",
    fontSize: "12px",
    lineHeight: "20px",
    padding: "0 4px 0 0",
    caretColor: "var(--color-canopy-accent)",
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
    display: "inline-block",
    boxSizing: "border-box",
    height: "20px",
    lineHeight: "18px",
    borderRadius: "2px",
    padding: "0 6px",
    fontFamily: "var(--font-mono, monospace)",
    fontSize: "12px",
    fontWeight: 500,
    verticalAlign: "baseline",
    backgroundColor: "rgba(var(--color-canopy-accent-rgb), 0.2)",
    color: "var(--color-canopy-accent)",
    border: "1px solid rgba(var(--color-canopy-accent-rgb), 0.3)",
  },
  ".cm-slash-command-chip-invalid": {
    backgroundColor: "rgba(239, 68, 68, 0.2)",
    color: "rgb(248, 113, 113)",
    border: "1px solid rgba(239, 68, 68, 0.3)",
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

export function createAutoSize() {
  let lastHeight = 0;

  return EditorView.updateListener.of((update) => {
    if (!update.docChanged && !update.viewportChanged) return;

    const view = update.view;
    // Snap to line-height increments to prevent subpixel jitter
    const lines = Math.max(1, Math.round(view.contentHeight / LINE_HEIGHT_PX));
    const snapped = lines * LINE_HEIGHT_PX;
    const next = Math.min(snapped, MAX_TEXTAREA_HEIGHT_PX);

    // Only update if the computed height actually changed
    if (next !== lastHeight) {
      lastHeight = next;
      view.dom.style.height = `${next}px`;
    }

    view.scrollDOM.style.overflowY =
      view.contentHeight > MAX_TEXTAREA_HEIGHT_PX ? "auto" : "hidden";
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
