import { EditorView, Decoration, WidgetType } from "@codemirror/view";
import { StateField, Compartment } from "@codemirror/state";
import type { SlashCommand } from "@shared/types";
import { getAllSlashCommandTokens, type SlashCommandToken } from "../hybridInputParsing";
import { chipAriaLabel, chipPendingDeleteField, isChipSelected } from "./chipBackspace";
import { chipCardText, chipHoverTooltip, chipTooltip } from "./chipCard";

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
    readonly isSelected: boolean,
    readonly description: string
  ) {
    super();
  }

  eq(other: SlashChipWidget) {
    return (
      this.command === other.command &&
      this.isValid === other.isValid &&
      this.isSelected === other.isSelected &&
      this.description === other.description
    );
  }

  toDOM() {
    const span = document.createElement("span");
    const classes = ["cm-slash-command-chip"];
    if (!this.isValid) classes.push("cm-slash-command-chip-invalid");
    if (this.isSelected) classes.push("cm-chip-pending-delete");
    span.className = classes.join(" ");
    span.setAttribute("role", "img");
    span.setAttribute(
      "aria-label",
      chipAriaLabel(`Slash command: ${this.command}`, this.isSelected)
    );
    if (this.description) span.setAttribute("aria-description", this.description);
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
          // Only a recognized command solidifies into an atomic chip. A token
          // that's still being typed or mistyped stays plain editable text
          // (single-char Backspace) with just a "no match" hint, so a finger
          // slip is fixable instead of nuking the whole draft.
          if (!token.isValid) {
            return Decoration.mark({ class: "cm-slash-command-chip-invalid" }).range(
              token.start,
              token.end
            );
          }
          const selected = isChipSelected(pending, token.start, token.end);
          return Decoration.replace({
            widget: new SlashChipWidget(
              token.command,
              token.isValid,
              selected,
              slashCommandDescription(config.commandMap.get(token.command))
            ),
          }).range(token.start, token.end);
        });
        return Decoration.set(ranges, true);
      }),
      EditorView.atomicRanges.of((view) => {
        const fieldValue = view.state.field(f, false);
        if (!fieldValue || fieldValue.tokens.length === 0) return Decoration.none;
        const ranges = fieldValue.tokens
          .filter((t) => t.isValid)
          .map((t) => Decoration.mark({}).range(t.start, t.end));
        if (ranges.length === 0) return Decoration.none;
        return Decoration.set(ranges, true);
      }),
    ],
  });
}

function slashCommandDescription(command: SlashCommand | undefined): string {
  return command?.description ?? command?.label ?? "";
}

export function createSlashTooltip(commandMap: Map<string, SlashCommand>) {
  return chipHoverTooltip((view, pos) => {
    const tokens = getAllSlashCommandTokens(view.state.doc.toString());
    const token = tokens.find((t) => pos >= t.start && pos < t.end);
    if (!token) return null;

    const command = commandMap.get(token.command);
    if (!command) return null;

    return chipTooltip({ from: token.start, to: token.end }, ".cm-slash-command-chip", () => [
      chipCardText(slashCommandDescription(command)),
    ]);
  });
}

export function createSlashChipCompartment() {
  return new Compartment();
}

export function createSlashTooltipCompartment() {
  return new Compartment();
}
