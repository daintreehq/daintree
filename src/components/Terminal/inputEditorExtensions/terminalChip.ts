import { EditorView, Decoration, WidgetType } from "@codemirror/view";
import { StateField } from "@codemirror/state";
import { getAllAtTerminalTokens, type AtTerminalToken } from "../hybridInputParsing";
import { TERMINAL_ICON_SVG } from "./base";
import { chipAriaLabel, chipPendingDeleteField, isChipSelected } from "./chipBackspace";
import { chipCardText, chipHoverTooltip, chipTooltip } from "./chipCard";
import { createTrustedHTML, setTrustedInnerHTML } from "@/lib/trustedTypesPolicy";

const TERMINAL_CHIP_DESCRIPTION = "Attaches last 100 lines of terminal output as context";

interface TerminalChipState {
  tokens: AtTerminalToken[];
}

function buildTerminalChipState(text: string): TerminalChipState {
  return { tokens: getAllAtTerminalTokens(text) };
}

class TerminalBufferChipWidget extends WidgetType {
  constructor(readonly isSelected: boolean) {
    super();
  }

  eq(other: TerminalBufferChipWidget) {
    return this.isSelected === other.isSelected;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = this.isSelected
      ? "cm-terminal-chip cm-chip-pending-delete"
      : "cm-terminal-chip";
    span.setAttribute("role", "img");
    span.setAttribute("aria-label", chipAriaLabel("Terminal output", this.isSelected));
    span.setAttribute("aria-description", TERMINAL_CHIP_DESCRIPTION);

    const icon = document.createElement("span");
    setTrustedInnerHTML(icon, createTrustedHTML(TERMINAL_ICON_SVG));
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
    EditorView.decorations.of((view) => {
      const chipState = view.state.field(f, false);
      if (!chipState || chipState.tokens.length === 0) return Decoration.none;
      const pending = view.state.field(chipPendingDeleteField, false) ?? null;
      const ranges = chipState.tokens.map((token) => {
        const selected = isChipSelected(pending, token.start, token.end);
        return Decoration.replace({
          widget: new TerminalBufferChipWidget(selected),
        }).range(token.start, token.end);
      });
      return Decoration.set(ranges, true);
    }),
    EditorView.atomicRanges.of((view) => {
      const chipState = view.state.field(f, false);
      if (!chipState || chipState.tokens.length === 0) return Decoration.none;
      const ranges = chipState.tokens.map((t) => Decoration.mark({}).range(t.start, t.end));
      return Decoration.set(ranges, true);
    }),
  ],
});

export function createTerminalChipTooltip() {
  return chipHoverTooltip((view, pos) => {
    const chipState = view.state.field(terminalChipField, false);
    if (!chipState) return null;

    const token = chipState.tokens.find((t) => pos >= t.start && pos < t.end);
    if (!token) return null;

    return chipTooltip({ from: token.start, to: token.end }, ".cm-terminal-chip", () => [
      chipCardText(TERMINAL_CHIP_DESCRIPTION),
    ]);
  });
}
