import { EditorView, Decoration, WidgetType } from "@codemirror/view";
import { StateField, type EditorState, type Transaction } from "@codemirror/state";
import {
  getAllAtFileTokens,
  RESERVED_AT_TOKEN_PATHS,
  type AtFileToken,
} from "../hybridInputParsing";
import {
  chipAriaLabel,
  chipPendingDeleteField,
  isChipSelected,
  type ChipPendingDelete,
} from "./chipBackspace";
import { chipCardPath, chipHoverTooltip, chipTooltip } from "./chipCard";
import { fileDropChipField } from "./fileDropChip";
import { isOwnedByContextReferenceChip } from "./contextReferenceChip";
import { imageChipField } from "./imageChip";

interface RangeOwner {
  from: number;
  to: number;
}

/**
 * Whether an `@file` token's range belongs to another chip: an attachment, or
 * a plugin context reference (`@rec:142` would otherwise read as a file `rec`).
 */
function isOwnedByOtherChip(state: EditorState, start: number, end: number): boolean {
  return (
    isOwnedByAttachmentChip(state, start, end) || isOwnedByContextReferenceChip(state, start, end)
  );
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

function parseFileTokens(text: string): AtFileToken[] {
  return getAllAtFileTokens(text).filter((t) => !RESERVED_AT_TOKEN_PATHS.has(t.path));
}

interface FileChipState {
  tokens: AtFileToken[];
  /** Start of the reference being typed, if any: it stays text until the caret leaves it. */
  typing: number | null;
}

function tokenAtCaret(state: EditorState, tokens: AtFileToken[]): AtFileToken | undefined {
  const main = state.selection.main;
  if (!main.empty) return undefined;
  return tokens.find((t) => main.head > t.start && main.head <= t.end);
}

/**
 * A reference being typed stays plain text, so a slip takes one Backspace and
 * the caret walks through it, as a `/command` being typed does; the menu above
 * it is still offering files for it. It becomes a chip once the caret leaves
 * it — picking a file from the menu adds the space that does that. Only typing
 * opens one: Backspacing into a finished reference from the space after it
 * still meets the chip, and stages it.
 */
function nextTyping(value: FileChipState, tokens: AtFileToken[], tr: Transaction): number | null {
  const atCaret = tokenAtCaret(tr.state, tokens);
  if (!atCaret) return null;
  if (insertsAtCaret(tr)) return atCaret.start;
  if (value.typing === null) return null;
  const mapped = tr.docChanged ? tr.changes.mapPos(value.typing) : value.typing;
  return mapped === atCaret.start ? atCaret.start : null;
}

/**
 * Whether the transaction wrote text that ends at the caret: typing, keyed on
 * the change itself, because a Backspace the browser performs reaches the
 * editor as an input event too.
 */
function insertsAtCaret(tr: Transaction): boolean {
  if (!tr.docChanged) return false;
  const head = tr.state.selection.main.head;
  let inserted = false;
  tr.changes.iterChanges((_fromA, _toA, _fromB, toB, text) => {
    if (text.length > 0 && toB === head) inserted = true;
  });
  return inserted;
}

function isSettled(
  state: EditorState,
  token: AtFileToken,
  typing: number | null,
  pending: ChipPendingDelete | null
): boolean {
  if (isOwnedByOtherChip(state, token.start, token.end)) return false;
  if (isChipSelected(pending, token.start, token.end)) return true;
  return token.start !== typing;
}

const fileChipStateField = StateField.define<FileChipState>({
  create(state) {
    return { tokens: parseFileTokens(state.doc.toString()), typing: null };
  },
  update(value, tr) {
    if (!tr.docChanged && !tr.selection) return value;
    const tokens = tr.docChanged ? parseFileTokens(tr.state.doc.toString()) : value.tokens;
    const typing = nextTyping(value, tokens, tr);
    if (tokens === value.tokens && typing === value.typing) return value;
    return { tokens, typing };
  },
  provide: (f) => [
    EditorView.decorations.of((view) => {
      const fieldValue = view.state.field(f, false);
      if (!fieldValue || fieldValue.tokens.length === 0) return Decoration.none;
      const pending = view.state.field(chipPendingDeleteField, false) ?? null;
      const ranges = fieldValue.tokens
        .filter((t) => isSettled(view.state, t, fieldValue.typing, pending))
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
      const pending = view.state.field(chipPendingDeleteField, false) ?? null;
      const ranges = fieldValue.tokens
        .filter((t) => isSettled(view.state, t, fieldValue.typing, pending))
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
    if (!token || isOwnedByOtherChip(view.state, token.start, token.end)) return null;

    return chipTooltip({ from: token.start, to: token.end }, ".cm-file-chip", () => [
      chipCardPath(token.path),
    ]);
  });
}
