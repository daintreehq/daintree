import { Decoration, EditorView, type DecorationSet, type Tooltip } from "@codemirror/view";
import {
  StateEffect,
  StateField,
  type EditorState,
  type Range,
  type Transaction,
} from "@codemirror/state";
import type { ForgeNumberReference } from "@shared/types/forge";
import {
  getIssueStateColor,
  getIssueStateLabel,
  getPrStateColor,
  getPrStateLabel,
} from "@/lib/prStateGlyph";
import { cn } from "@/lib/utils";
import { createTrustedHTML, setTrustedInnerHTML } from "@/lib/trustedTypesPolicy";
import { getAllIssueReferences, type IssueReferenceToken } from "../forgeReferenceParsing";
import { getAllAtContextReferences, getAllAtFileTokens } from "../hybridInputParsing";
import { chipHoverTooltip, chipTooltip } from "./chipCard";
import { isOwnedByAttachmentChip } from "./fileChip";

/**
 * Issue and pull request references (#14849): a bare `#N` that names one in
 * the project's repository is marked, and stays ordinary text the caret moves
 * through. What each number names is looked up outside the editor and handed
 * in; a number nobody has named stays plain.
 */

export type ForgeReferenceMap = ReadonlyMap<number, ForgeNumberReference>;

const NO_REFERENCES: ForgeReferenceMap = new Map();

/** Replace what the draft's numbers are known to name. */
export const setForgeReferences = StateEffect.define<ForgeReferenceMap>();

/** Tell a view what its draft's numbers name, when that differs from what it holds. */
export function applyForgeReferences(view: EditorView, references: ForgeReferenceMap): void {
  const current = view.state.field(forgeReferenceField, false)?.references ?? NO_REFERENCES;
  if (sameReferences(current, references)) return;
  view.dispatch({ effects: setForgeReferences.of(references) });
}

/** Who looks up each view's references: the composer that owns it. */
const rescanners = new WeakMap<EditorView, () => void>();

/** Register `rescan` as how `view`'s references are looked up again; returns the unregister. */
export function onForgeReferenceRescan(view: EditorView, rescan: () => void): () => void {
  rescanners.set(view, rescan);
  return () => {
    if (rescanners.get(view) === rescan) rescanners.delete(view);
  };
}

/**
 * Look a view's references up again: after `view.setState` restored a stashed
 * draft, which reaches no document listener and carries the references of
 * when it was stashed, or when a card shows what may since have changed.
 */
export function rescanForgeReferences(view: EditorView): void {
  rescanners.get(view)?.();
}

/**
 * The `#N`s in the draft that could be references: not one inside another
 * token (`@"notes #12.md"`, `@rec:#12`), whose own chip speaks for that text.
 */
export function eligibleIssueReferences(state: EditorState): IssueReferenceToken[] {
  const text = state.doc.toString();
  const tokens = getAllIssueReferences(text);
  if (tokens.length === 0) return tokens;
  const owned: Array<{ start: number; end: number }> = text.includes("@")
    ? [...getAllAtFileTokens(text), ...getAllAtContextReferences(text)]
    : [];
  return tokens.filter(
    (token) =>
      !owned.some((other) => other.start < token.end && other.end > token.start) &&
      !isOwnedByAttachmentChip(state, token.start, token.end)
  );
}

function sameReferences(a: ForgeReferenceMap, b: ForgeReferenceMap): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [number, reference] of a) {
    const other = b.get(number);
    if (!other || !sameReference(reference, other)) return false;
  }
  return true;
}

function sameReference(a: ForgeNumberReference, b: ForgeNumberReference): boolean {
  return (
    a.kind === b.kind &&
    a.title === b.title &&
    a.state === b.state &&
    (a.kind !== "pr" || b.kind !== "pr" || a.isDraft === b.isDraft)
  );
}

interface DrawnReference {
  from: number;
  to: number;
  reference: ForgeNumberReference;
}

interface ForgeReferenceState {
  references: ForgeReferenceMap;
  drawn: DrawnReference[];
  decorations: DecorationSet;
}

/** The state and kind in words: "Merged pull request #14843". */
export function describeForgeReference(reference: ForgeNumberReference): string {
  return reference.kind === "pr"
    ? `${getPrStateLabel(reference.state, reference.isDraft)} pull request #${reference.number}`
    : `${getIssueStateLabel(reference.state)} issue #${reference.number}`;
}

function build(state: EditorState, references: ForgeReferenceMap): ForgeReferenceState {
  if (references.size === 0) return { references, drawn: [], decorations: Decoration.none };
  const drawn: DrawnReference[] = [];
  const marks: Range<Decoration>[] = [];
  for (const token of eligibleIssueReferences(state)) {
    const reference = references.get(token.number);
    if (!reference) continue;
    drawn.push({ from: token.start, to: token.end, reference });
    marks.push(
      Decoration.mark({
        class: "cm-forge-ref",
        attributes: {
          "aria-description": `${describeForgeReference(reference)}: ${reference.title}`,
        },
      }).range(token.start, token.end)
    );
  }
  return { references, drawn, decorations: Decoration.set(marks) };
}

export const forgeReferenceField = StateField.define<ForgeReferenceState>({
  create(state) {
    return build(state, NO_REFERENCES);
  },
  update(value, tr) {
    let references = value.references;
    for (const effect of tr.effects) {
      if (effect.is(setForgeReferences)) references = effect.value;
    }
    if (!tr.docChanged && references === value.references) return value;
    return build(tr.state, references);
  },
  provide: (f) => EditorView.decorations.from(f, (value) => value.decorations),
});

// Lucide's glyphs, the badges' own: issue open/closed, and the four PR states.
const GLYPH_PATHS = {
  issueOpen: `<circle cx="12" cy="12" r="1"/><circle cx="12" cy="12" r="10"/>`,
  issueClosed: `<circle cx="12" cy="12" r="10"/><path d="m16 9-5.5 5.5L8 12"/>`,
  prOpen: `<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/>`,
  prDraft: `<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M18 6V5"/><path d="M18 11v-1"/><line x1="6" x2="6" y1="9" y2="21"/>`,
  prMerged: `<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>`,
  prClosed: `<path d="m15.5 3.5 5 5"/><path d="m15.5 8.5 5-5"/><path d="M18 11.62V15"/><path d="M6 9v12"/><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/>`,
} as const;

function glyphOf(reference: ForgeNumberReference): keyof typeof GLYPH_PATHS {
  if (reference.kind === "issue") return reference.state === "closed" ? "issueClosed" : "issueOpen";
  if (reference.state === "merged") return "prMerged";
  if (reference.state === "open") return reference.isDraft ? "prDraft" : "prOpen";
  return "prClosed";
}

/** The badges' card header in DOM: the state's glyph and word in its tone, the number, then the title. */
function referenceCard(reference: ForgeNumberReference): Node[] {
  const tone =
    reference.kind === "pr"
      ? getPrStateColor(reference.state, reference.isDraft)
      : getIssueStateColor(reference.state);

  const header = document.createElement("p");
  header.className = "flex items-center gap-1.5 text-2xs";

  const glyph = document.createElement("span");
  glyph.className = cn("inline-flex shrink-0", tone);
  glyph.setAttribute("aria-hidden", "true");
  setTrustedInnerHTML(
    glyph,
    createTrustedHTML(
      `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${GLYPH_PATHS[glyphOf(reference)]}</svg>`
    )
  );

  const state = document.createElement("span");
  state.className = cn("font-medium", tone);
  state.textContent =
    reference.kind === "pr"
      ? getPrStateLabel(reference.state, reference.isDraft)
      : getIssueStateLabel(reference.state);

  const number = document.createElement("span");
  number.className = "text-text-secondary tabular-nums";
  number.textContent = `#${reference.number}`;

  header.append(glyph, state, number);

  const title = document.createElement("p");
  title.className =
    "mt-1 text-xs font-medium text-text-primary line-clamp-4 [overflow-wrap:anywhere]";
  title.textContent = reference.title;

  return [header, title];
}

/** The marked reference that starts at `from`, if one still does. */
function drawnAt(state: EditorState, from: number): DrawnReference | undefined {
  return state.field(forgeReferenceField, false)?.drawn.find((d) => d.from === from);
}

const toldReferences = (tr: Transaction) =>
  tr.effects.some((effect) => effect.is(setForgeReferences));

/** The card for the marked reference at `pos`, if there is one; `side` as `hoverTooltip` gives it. */
export function forgeReferenceTooltipAt(
  view: EditorView,
  pos: number,
  side: -1 | 1
): Tooltip | null {
  const drawn = view.state.field(forgeReferenceField, false)?.drawn ?? [];
  const hit = drawn.find(
    (d) =>
      (pos > d.from || (pos === d.from && side > 0)) && (pos < d.to || (pos === d.to && side < 0))
  );
  if (!hit) return null;
  // Reading a card is when its state matters: a stale answer is asked again,
  // outside this update, and an open card takes the new one as it lands.
  setTimeout(() => rescanForgeReferences(view), 0);
  let shown = hit.reference;
  return chipTooltip(
    { from: hit.from, to: hit.to },
    ".cm-forge-ref",
    () => referenceCard(shown),
    (update) => {
      if (!update.transactions.some(toldReferences)) return null;
      const current = drawnAt(update.state, hit.from)?.reference;
      if (!current || sameReference(current, shown)) return null;
      shown = current;
      return referenceCard(current);
    }
  );
}

/**
 * Whether `tr` closes an open card: the draft's text changed under it, or its
 * number no longer names anything. A changed answer for the same number
 * updates the card in place instead.
 */
export function closesReferenceCard(tr: Transaction, tooltip: Tooltip): boolean {
  if (tr.docChanged) return true;
  return toldReferences(tr) && !drawnAt(tr.state, tooltip.pos);
}

export function createForgeReferenceTooltip() {
  return chipHoverTooltip(forgeReferenceTooltipAt, { hideOn: closesReferenceCard });
}
