import { EditorView, Decoration, WidgetType, hoverTooltip } from "@codemirror/view";
import { StateField, Compartment } from "@codemirror/state";
import type { SlashCommand } from "@shared/types";
import { getAllSlashCommandTokens, type SlashCommandToken } from "../hybridInputParsing";
import { chipPendingDeleteField, isChipSelected } from "./chipBackspace";

interface SlashChipFieldConfig {
  commandMap: Map<string, SlashCommand>;
}

interface SlashChipToken extends SlashCommandToken {
  isValid: boolean;
}

interface SlashChipState {
  tokens: SlashChipToken[];
}

class SlashChipWidget extends WidgetType {
  constructor(
    readonly command: string,
    readonly isValid: boolean,
    readonly isSelected: boolean
  ) {
    super();
  }

  eq(other: SlashChipWidget) {
    return (
      this.command === other.command &&
      this.isValid === other.isValid &&
      this.isSelected === other.isSelected
    );
  }

  toDOM() {
    const span = document.createElement("span");
    const classes = ["cm-slash-command-chip"];
    if (!this.isValid) classes.push("cm-slash-command-chip-invalid");
    if (this.isSelected) classes.push("cm-chip-pending-delete");
    span.className = classes.join(" ");
    span.setAttribute("role", "img");
    span.setAttribute("aria-label", `Slash command: ${this.command}`);
    span.textContent = this.command;
    return span;
  }

  ignoreEvent() {
    return false;
  }
}

function buildSlashChipState(text: string, config: SlashChipFieldConfig): SlashChipState {
  const tokens = getAllSlashCommandTokens(text).map((token) => ({
    ...token,
    isValid: config.commandMap.has(token.command),
  }));
  return { tokens };
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
    provide: (f) => [
      EditorView.decorations.of((view) => {
        const fieldValue = view.state.field(f, false);
        if (!fieldValue || fieldValue.tokens.length === 0) return Decoration.none;
        const pending = view.state.field(chipPendingDeleteField, false) ?? null;
        const ranges = fieldValue.tokens.map((token) => {
          const selected = isChipSelected(pending, token.start, token.end);
          return Decoration.replace({
            widget: new SlashChipWidget(token.command, token.isValid, selected),
          }).range(token.start, token.end);
        });
        return Decoration.set(ranges, true);
      }),
      EditorView.atomicRanges.of((view) => {
        const fieldValue = view.state.field(f, false);
        if (!fieldValue || fieldValue.tokens.length === 0) return Decoration.none;
        const ranges = fieldValue.tokens.map((t) => Decoration.mark({}).range(t.start, t.end));
        return Decoration.set(ranges, true);
      }),
    ],
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
