import { EditorView, Decoration, WidgetType, closeHoverTooltips } from "@codemirror/view";
import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { pluralize } from "@/lib/pluralize";
import { createTrustedHTML, setTrustedInnerHTML } from "@/lib/trustedTypesPolicy";
import {
  allocateDiffNotes,
  type DiffNote,
  type PendingDiffNotes,
} from "@/components/Worktree/diffNotes";
import { getAllAtNotesTokens, type AtNotesToken } from "../hybridInputParsing";
import { chipAriaLabel, chipPendingDeleteField, isChipSelected } from "./chipBackspace";
import { chipCardPath, chipCardText, chipHoverTooltip, chipTooltip } from "./chipCard";

/**
 * Chips for `@notes`: how many notes the token will send and that sending
 * clears them, kept current as notes come and go. Drawn only for a composer
 * that can take notes; elsewhere the token stays text.
 */

/** Replace the notes the chips count; dispatched as they change. */
export const setDiffNotesChipSource = StateEffect.define<PendingDiffNotes | null>();

/** What each view was last told, for a state that replaces the view's own. */
const appliedSources = new WeakMap<EditorView, PendingDiffNotes | null>();

export function applyDiffNotesChipSource(view: EditorView, source: PendingDiffNotes | null): void {
  appliedSources.set(view, source);
  // An open card would go on promising what the notes were when it opened. A
  // draft that names no notes has no such card, and any other is left open.
  const namesNotes = (view.state.field(notesChipField, false)?.tokens.length ?? 0) > 0;
  view.dispatch({
    effects: namesNotes
      ? [setDiffNotesChipSource.of(source), closeHoverTooltips]
      : setDiffNotesChipSource.of(source),
  });
}

/**
 * The effect that brings a view's chips back to the current notes after
 * `view.setState` restored an older state (a popped stash), which carries the
 * notes it was stashed with. Empty when none were ever applied.
 */
export function currentDiffNotesChipEffects(
  view: EditorView
): StateEffect<PendingDiffNotes | null>[] {
  return appliedSources.has(view)
    ? [setDiffNotesChipSource.of(appliedSources.get(view) ?? null)]
    : [];
}

// lucide `message-square-text`
const NOTE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M13 8H7"/><path d="M17 12H7"/></svg>`;

interface NotesChipToken extends AtNotesToken {
  /** What a send would take for this token. */
  notes: readonly DiffNote[];
  label: string;
  description: string;
}

interface NotesChipState {
  source: PendingDiffNotes | null;
  tokens: NotesChipToken[];
}

function describeToken(
  token: AtNotesToken,
  notes: readonly DiffNote[],
  source: PendingDiffNotes
): { label: string; description: string } {
  const names = (note: DiffNote) => token.filePath === null || note.filePath === token.filePath;
  const editing = source.editing.filter(names).length;
  const editingStays = `${pluralize(editing, "note being edited stays", "notes being edited stay")} pending`;
  const fileName = token.filePath?.split(/[\\/]/).pop();

  let status: string;
  let description: string;
  if (notes.length > 0) {
    status = `${pluralize(notes.length, "note")} · clears on send`;
    description = `Sends ${pluralize(notes.length, "pending note")}. Sending clears ${notes.length === 1 ? "it" : "them"}`;
    if (editing > 0) description += `; ${editingStays}`;
  } else if (source.sendable.some(names)) {
    status = "Included above";
    description = "An earlier reference in this message already sends these notes";
  } else if (editing > 0) {
    status = "Being edited";
    description = editingStays;
  } else {
    status = "No notes";
    description = "No pending notes to send";
  }
  return { label: fileName ? `${fileName} · ${status}` : status, description };
}

function buildTokens(text: string, source: PendingDiffNotes | null): NotesChipToken[] {
  if (!source) return [];
  const tokens = getAllAtNotesTokens(text);
  const allocated = allocateDiffNotes(tokens, source.sendable);
  return tokens.map((token, index) => {
    const notes = allocated[index]!;
    return { ...token, notes, ...describeToken(token, notes, source) };
  });
}

class NotesChipWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly description: string,
    readonly isSelected: boolean
  ) {
    super();
  }

  eq(other: NotesChipWidget) {
    return (
      this.label === other.label &&
      this.description === other.description &&
      this.isSelected === other.isSelected
    );
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = this.isSelected ? "cm-notes-chip cm-chip-pending-delete" : "cm-notes-chip";
    span.setAttribute("role", "img");
    span.setAttribute("aria-label", chipAriaLabel(`Diff notes: ${this.label}`, this.isSelected));
    span.setAttribute("aria-description", this.description);

    const icon = document.createElement("span");
    setTrustedInnerHTML(icon, createTrustedHTML(NOTE_ICON_SVG));
    icon.style.display = "inline-flex";
    icon.style.alignItems = "center";
    span.appendChild(icon);

    const label = document.createElement("span");
    label.setAttribute("aria-hidden", "true");
    label.textContent = this.label;
    span.appendChild(label);

    return span;
  }

  ignoreEvent() {
    return false;
  }
}

export const notesChipField = StateField.define<NotesChipState>({
  create(state) {
    return { source: null, tokens: buildTokens(state.doc.toString(), null) };
  },
  update(value, tr) {
    let source = value.source;
    for (const effect of tr.effects) {
      if (effect.is(setDiffNotesChipSource)) source = effect.value;
    }
    if (!tr.docChanged && source === value.source) return value;
    return { source, tokens: buildTokens(tr.state.doc.toString(), source) };
  },
  provide: (f) => [
    EditorView.decorations.of((view) => {
      const tokens = drawnTokens(view.state, f);
      if (tokens.length === 0) return Decoration.none;
      const pending = view.state.field(chipPendingDeleteField, false) ?? null;
      return Decoration.set(
        tokens.map((token) =>
          Decoration.replace({
            widget: new NotesChipWidget(
              token.label,
              token.description,
              isChipSelected(pending, token.start, token.end)
            ),
          }).range(token.start, token.end)
        ),
        true
      );
    }),
    EditorView.atomicRanges.of((view) => {
      const tokens = drawnTokens(view.state, f);
      if (tokens.length === 0) return Decoration.none;
      return Decoration.set(
        tokens.map((t) => Decoration.mark({}).range(t.start, t.end)),
        true
      );
    }),
  ],
});

/**
 * The tokens drawn as chips. A per-file one the caret sits in or at the end of,
 * naming no file with notes, is still being typed and stays text until the user
 * moves on or picks a row.
 */
function drawnTokens(
  state: EditorState,
  field: StateField<NotesChipState> = notesChipField
): NotesChipToken[] {
  const value = state.field(field, false);
  if (!value || value.tokens.length === 0) return [];
  const caret = state.selection.main;
  return value.tokens.filter(
    (token) =>
      token.filePath === null ||
      token.notes.length > 0 ||
      !caret.empty ||
      caret.head <= token.start ||
      caret.head > token.end
  );
}

export function createNotesChipTooltip() {
  return chipHoverTooltip((view, pos) => {
    const token = drawnTokens(view.state).find((t) => pos >= t.start && pos < t.end);
    if (!token) return null;
    return chipTooltip({ from: token.start, to: token.end }, ".cm-notes-chip", () => [
      chipCardText(token.description),
      ...(token.filePath === null ? [] : [chipCardPath(token.filePath)]),
    ]);
  });
}
