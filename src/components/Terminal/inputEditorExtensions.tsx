import { EditorView, Decoration, hoverTooltip, keymap, placeholder } from "@codemirror/view";
import { StateField, Prec, Extension, Compartment } from "@codemirror/state";
import { insertNewline } from "@codemirror/commands";
import { createRoot, Root } from "react-dom/client";
import type { SlashCommand } from "@shared/types";
import { getLeadingSlashCommand } from "./hybridInputParsing";
import { SlashCommandTooltipContent } from "./SlashCommandTooltip";

const MAX_TEXTAREA_HEIGHT_PX = 160;

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
    caretColor: "rgb(var(--color-canopy-accent))",
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
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    borderRadius: "2px",
    padding: "2px 6px",
    fontFamily: "var(--font-mono, monospace)",
    fontSize: "12px",
    fontWeight: 500,
    backgroundColor: "rgba(var(--color-canopy-accent-rgb, 16 185 129), 0.2)",
    color: "rgb(var(--color-canopy-accent, 16 185 129))",
    border: "1px solid rgba(var(--color-canopy-accent-rgb, 16 185 129), 0.3)",
    transition: "colors 150ms",
  },
  ".cm-slash-command-chip-invalid": {
    backgroundColor: "rgba(239, 68, 68, 0.2)",
    color: "rgb(248, 113, 113)",
    border: "1px solid rgba(239, 68, 68, 0.3)",
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
        dom.className =
          "overflow-hidden rounded-[var(--radius-md)] surface-overlay shadow-overlay px-3 py-1.5 text-xs text-canopy-text";

        const root = createRoot(dom);
        root.render(<SlashCommandTooltipContent command={command} />);

        return {
          dom,
          destroy() {
            root.unmount();
          },
        };
      },
    };
  });
}

export function createAutoSize() {
  return EditorView.updateListener.of((update) => {
    if (!update.docChanged && !update.viewportChanged) return;

    const view = update.view;
    const max = MAX_TEXTAREA_HEIGHT_PX;
    const next = Math.min(view.contentHeight, max);

    view.dom.style.height = `${next}px`;
    view.scrollDOM.style.overflowY = view.contentHeight > max ? "auto" : "hidden";
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
