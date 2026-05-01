import { EditorView, Decoration, WidgetType, hoverTooltip } from "@codemirror/view";
import { StateField } from "@codemirror/state";
import { getAllAtDiffTokens, type AtDiffToken, type DiffContextType } from "../hybridInputParsing";
import { chipPendingDeleteField, isChipSelected } from "./chipBackspace";
import { createTrustedHTML, setTrustedInnerHTML } from "@/lib/trustedTypesPolicy";

const DIFF_LABELS: Record<DiffContextType, string> = {
  unstaged: "Working tree diff",
  staged: "Staged diff",
  head: "HEAD diff",
};

const GIT_BRANCH_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>`;

interface DiffChipState {
  tokens: AtDiffToken[];
}

function buildDiffChipState(text: string): DiffChipState {
  return { tokens: getAllAtDiffTokens(text) };
}

class DiffChipWidget extends WidgetType {
  constructor(
    readonly diffType: DiffContextType,
    readonly isSelected: boolean
  ) {
    super();
  }

  eq(other: DiffChipWidget) {
    return this.diffType === other.diffType && this.isSelected === other.isSelected;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = this.isSelected ? "cm-diff-chip cm-chip-pending-delete" : "cm-diff-chip";
    span.setAttribute("role", "img");
    span.setAttribute("aria-label", `Diff: ${DIFF_LABELS[this.diffType]}`);

    const icon = document.createElement("span");
    setTrustedInnerHTML(icon, createTrustedHTML(GIT_BRANCH_ICON_SVG));
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
    EditorView.decorations.of((view) => {
      const chipState = view.state.field(f, false);
      if (!chipState || chipState.tokens.length === 0) return Decoration.none;
      const pending = view.state.field(chipPendingDeleteField, false) ?? null;
      const ranges = chipState.tokens.map((token) => {
        const selected = isChipSelected(pending, token.start, token.end);
        return Decoration.replace({
          widget: new DiffChipWidget(token.diffType, selected),
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
          box-shadow: 0 2px 8px var(--theme-scrim-soft);
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
