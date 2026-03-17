import { EditorView, Decoration, WidgetType, hoverTooltip } from "@codemirror/view";
import { StateField } from "@codemirror/state";
import { getAllAtSelectionTokens, type AtSelectionToken } from "../hybridInputParsing";
import { TERMINAL_ICON_SVG } from "./base";

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
          box-shadow: 0 2px 8px var(--theme-scrim-soft);
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
