import { EditorView, Decoration, hoverTooltip } from "@codemirror/view";
import { StateField, Compartment } from "@codemirror/state";
import type { SlashCommand } from "@shared/types";
import { getAllSlashCommandTokens, type SlashCommandToken } from "../hybridInputParsing";

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
          box-shadow: 0 2px 8px var(--theme-scrim-soft);
        `;

        dom.appendChild(createTooltipContent(command));

        return { dom };
      },
    };
  });
}

export function createSlashChipCompartment() {
  return new Compartment();
}

export function createSlashTooltipCompartment() {
  return new Compartment();
}
