import { EditorView, Decoration, hoverTooltip } from "@codemirror/view";
import { StateField } from "@codemirror/state";
import { getAllAtFileTokens, type AtFileToken } from "../hybridInputParsing";

const fileChipMark = Decoration.mark({ class: "cm-file-chip" });

interface FileChipState {
  decorations: ReturnType<typeof Decoration.set>;
  tokens: AtFileToken[];
}

const RESERVED_TOKEN_PATHS = new Set(["diff", "diff:staged", "diff:head", "terminal", "selection"]);

function buildFileChipState(text: string): FileChipState {
  const tokens = getAllAtFileTokens(text).filter((t) => !RESERVED_TOKEN_PATHS.has(t.path));
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
          background: var(--theme-surface-panel-elevated);
          border-radius: 4px;
          box-shadow: 0 2px 8px var(--theme-scrim-soft);
        `;

        dom.appendChild(createFileTooltipContent(token));

        return { dom };
      },
    };
  });
}
