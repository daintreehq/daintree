import type { PromptTemplateEntry } from "@/hooks/usePromptTemplates";
import type { AutocompleteItem } from "./AutocompleteMenu";

/** The `/` menu's band for prompt templates (#13799), after the agent's own commands. */
export const PROMPT_TEMPLATE_BAND = "Prompt templates";

const WORD_BREAK = /[^\p{L}\p{N}]+/u;

function words(text: string): string[] {
  return text.toLowerCase().split(WORD_BREAK).filter(Boolean);
}

/**
 * How well a template answers a `/` query, or null when it does not. Every
 * word typed must start a word of the title, the template's id or the name of
 * who it belongs to, or sit inside the title; a title hit ranks above the rest. The
 * description is left out: the menu narrows on every keystroke, and prose
 * matches there would put templates beside commands they have nothing to do with.
 */
export function scorePromptTemplate(entry: PromptTemplateEntry, query: string): number | null {
  const terms = words(query);
  if (terms.length === 0) return query.trim() === "" ? 0 : null;
  const title = entry.template.title.toLowerCase();
  const titleWords = words(title);
  const idWords = words(entry.template.id);
  const sourceWords = words(entry.sourceName);

  let total = 0;
  for (const term of terms) {
    if (title.startsWith(term)) total += 8;
    else if (titleWords.some((w) => w.startsWith(term))) total += 6;
    else if (idWords.some((w) => w.startsWith(term))) total += 5;
    else if (title.includes(term)) total += 4;
    else if (sourceWords.some((w) => w.startsWith(term))) total += 3;
    else return null;
  }
  return total;
}

/**
 * The templates a `/` query matches, best first and otherwise in the order
 * given, as rows of the template band. A row inserts nothing:
 * picking it opens the template's form or fills the draft (`template`).
 */
export function toPromptTemplateItems(
  templates: readonly PromptTemplateEntry[],
  query: string
): AutocompleteItem[] {
  return templates
    .map((entry, order) => ({ entry, order, score: scorePromptTemplate(entry, query) }))
    .filter((c): c is { entry: PromptTemplateEntry; order: number; score: number } => {
      return c.score !== null;
    })
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ entry }) => ({
      key: `template:${entry.key}`,
      label: entry.template.title,
      insertText: "",
      description: entry.template.description,
      badge: entry.sourceName,
      group: PROMPT_TEMPLATE_BAND,
      template: { key: entry.key, opensForm: entry.template.args.length > 0 },
    }));
}

/** A span of the draft, in document offsets. */
export interface DraftSpan {
  from: number;
  to: number;
}

/**
 * What to take out of the draft for the `/` token a template was picked with.
 * At the end of the draft the whitespace before it goes too, so the template
 * lands a blank line after the words rather than after a stray space; inside
 * the draft one space beside it goes, so the words either side don't end up
 * two spaces apart.
 */
export function promptTemplateTokenCut(draft: string, token: DraftSpan): DraftSpan {
  if (draft.slice(token.to).trim() === "") {
    return { from: draft.slice(0, token.from).trimEnd().length, to: draft.length };
  }
  // A token always opens a word (`getActiveCompletionContext`), so the space
  // after it is the one to go.
  const spaceAfter = draft[token.to] === " " || draft[token.to] === "\t";
  return { from: token.from, to: spaceAfter ? token.to + 1 : token.to };
}
