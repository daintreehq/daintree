import { EditorView, Decoration, WidgetType } from "@codemirror/view";
import { StateField, type EditorState } from "@codemirror/state";
import {
  getAllAtFileTokens,
  RESERVED_AT_TOKEN_PATHS,
  type AtFileToken,
} from "../hybridInputParsing";
import { chipAriaLabel, chipPendingDeleteField, isChipSelected } from "./chipBackspace";
import { chipCardPath, chipHoverTooltip, chipTooltip } from "./chipCard";
import { fileDropChipField } from "./fileDropChip";
import { imageChipField } from "./imageChip";

interface FileChipState {
  tokens: AtFileToken[];
}

interface RangeOwner {
  from: number;
  to: number;
}

/**
 * Whether `start`–`end` overlaps a chip something inserted explicitly — a
 * dropped file or a pasted image — rather than one parsed from typed text. A
 * dropped file's `@path` also spells an `@file` token, and those ranges belong
 * to the attachment: its chip, its card, and no completion menu.
 */
export function isOwnedByAttachmentChip(state: EditorState, start: number, end: number): boolean {
  const dropEntries: RangeOwner[] | undefined = state.field(fileDropChipField, false);
  if (dropEntries) {
    for (const e of dropEntries) {
      if (e.from < end && e.to > start) return true;
    }
  }
  const imageEntries: RangeOwner[] | undefined = state.field(imageChipField, false);
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
    span.setAttribute("aria-label", chipAriaLabel(`File: ${this.path}`, this.isSelected));
    span.textContent = `@${this.path}`;
    return span;
  }

  ignoreEvent() {
    return false;
  }
}

function buildFileChipState(text: string): FileChipState {
  const tokens = getAllAtFileTokens(text).filter((t) => !RESERVED_AT_TOKEN_PATHS.has(t.path));
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
        .filter((t) => !isOwnedByAttachmentChip(view.state, t.start, t.end))
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
        .filter((t) => !isOwnedByAttachmentChip(view.state, t.start, t.end))
        .map((t) => Decoration.mark({}).range(t.start, t.end));
      if (ranges.length === 0) return Decoration.none;
      return Decoration.set(ranges, true);
    }),
  ],
});

export function createFileChipField() {
  return fileChipStateField;
}

export function createFileChipTooltip() {
  return chipHoverTooltip((view, pos) => {
    const chipState = view.state.field(fileChipStateField, false);
    if (!chipState) return null;

    const token = chipState.tokens.find((t) => pos >= t.start && pos < t.end);
    if (!token || isOwnedByAttachmentChip(view.state, token.start, token.end)) return null;

    return chipTooltip({ from: token.start, to: token.end }, ".cm-file-chip", () => [
      chipCardPath(token.path),
    ]);
  });
}
