import { EditorView, Decoration, WidgetType, hoverTooltip } from "@codemirror/view";
import { StateField } from "@codemirror/state";
import { getAllAtFileTokens, type AtFileToken } from "../hybridInputParsing";
import { chipPendingDeleteField, isChipSelected } from "./chipBackspace";
import { fileDropChipField } from "./fileDropChip";
import { imageChipField } from "./imageChip";

interface FileChipState {
  tokens: AtFileToken[];
}

const RESERVED_TOKEN_PATHS = new Set(["diff", "diff:staged", "diff:head", "terminal", "selection"]);

interface RangeOwner {
  from: number;
  to: number;
}

function isOwnedByExplicitChip(view: EditorView, start: number, end: number): boolean {
  const dropEntries: RangeOwner[] | undefined = view.state.field(fileDropChipField, false);
  if (dropEntries) {
    for (const e of dropEntries) {
      if (e.from < end && e.to > start) return true;
    }
  }
  const imageEntries: RangeOwner[] | undefined = view.state.field(imageChipField, false);
  if (imageEntries) {
    for (const e of imageEntries) {
      if (e.from < end && e.to > start) return true;
    }
  }
  return false;
}

class FileChipWidget extends WidgetType {
  constructor(
    readonly path: string,
    readonly isSelected: boolean
  ) {
    super();
  }

  eq(other: FileChipWidget) {
    return this.path === other.path && this.isSelected === other.isSelected;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = this.isSelected ? "cm-file-chip cm-chip-pending-delete" : "cm-file-chip";
    span.setAttribute("role", "img");
    span.setAttribute("aria-label", `File: ${this.path}`);
    span.textContent = `@${this.path}`;
    return span;
  }

  ignoreEvent() {
    return false;
  }
}

function buildFileChipState(text: string): FileChipState {
  const tokens = getAllAtFileTokens(text).filter((t) => !RESERVED_TOKEN_PATHS.has(t.path));
  return { tokens };
}

const fileChipStateField = StateField.define<FileChipState>({
  create(state) {
    return buildFileChipState(state.doc.toString());
  },
  update(value, tr) {
    if (!tr.docChanged) return value;
    return buildFileChipState(tr.state.doc.toString());
  },
  provide: (f) => [
    EditorView.decorations.of((view) => {
      const fieldValue = view.state.field(f, false);
      if (!fieldValue || fieldValue.tokens.length === 0) return Decoration.none;
      const pending = view.state.field(chipPendingDeleteField, false) ?? null;
      const ranges = fieldValue.tokens
        .filter((t) => !isOwnedByExplicitChip(view, t.start, t.end))
        .map((token) => {
          const selected = isChipSelected(pending, token.start, token.end);
          return Decoration.replace({
            widget: new FileChipWidget(token.path, selected),
          }).range(token.start, token.end);
        });
      if (ranges.length === 0) return Decoration.none;
      return Decoration.set(ranges, true);
    }),
    EditorView.atomicRanges.of((view) => {
      const fieldValue = view.state.field(f, false);
      if (!fieldValue || fieldValue.tokens.length === 0) return Decoration.none;
      const ranges = fieldValue.tokens
        .filter((t) => !isOwnedByExplicitChip(view, t.start, t.end))
        .map((t) => Decoration.mark({}).range(t.start, t.end));
      if (ranges.length === 0) return Decoration.none;
      return Decoration.set(ranges, true);
    }),
  ],
});

export function createFileChipField() {
  return fileChipStateField;
}

function createFileTooltipContent(token: AtFileToken): HTMLElement {
  const container = document.createElement("div");
  container.className = "max-w-[300px]";

  const pathEl = document.createElement("p");
  pathEl.className = "text-[11px] text-daintree-text/90 leading-snug font-mono break-all";
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
