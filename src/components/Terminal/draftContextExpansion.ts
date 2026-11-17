import { peek as peekTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";
import { readTerminalTail } from "@/services/terminal/readTerminalTail";
import { usePluginContextProvidersStore } from "@/store/pluginContextProvidersStore";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type {
  ContextReference,
  ContextReferenceResolution,
} from "@shared/types/pluginContextProvider";
import {
  getAllAtContextReferences,
  getAllAtTerminalTokens,
  getAllAtSelectionTokens,
  getAllAtDiffTokens,
  getAllAtNotesTokens,
  fenceTokenExpansion,
  resolveTokenExpansions,
  type DiffContextType,
  type TokenExpansion,
} from "./hybridInputParsing";
import { expandContextReferences } from "./contextReferenceExpansion";
import { expandDiffNotesTokens } from "./diffNotesReference";
import type { DiffNote } from "@/components/Worktree/diffNotes";

// `@terminal` reads lines, not rows, so the pane's width doesn't change what it
// attaches; the row cap bounds a read through very long wrapped lines.
const TERMINAL_CONTEXT_LINES = 100;
const TERMINAL_CONTEXT_ROWS = 400;

/** The plugin this view believes holds `prefix`, for a placeholder when main can't be asked. */
function activeProviderName(prefix: string): string | undefined {
  return usePluginContextProvidersStore
    .getState()
    .entries.find((entry) => entry.status === "active" && entry.prefix === prefix)?.pluginName;
}

export type ContextReferenceResolver = (
  references: ContextReference[]
) => Promise<ContextReferenceResolution[]>;

/** Ask main for a draft's references; a bridge without the method answers that nothing is held. */
export const resolveContextReferences: ContextReferenceResolver = (references) => {
  const bridge = window.electron?.plugin;
  if (typeof bridge?.resolveContextReferences !== "function") {
    return Promise.resolve(references.map(() => ({ status: "unknown" })));
  }
  return bridge.resolveContextReferences(references);
};

/**
 * A resolver that asks main once per reference however many drafts carry it,
 * so every agent a fleet send reaches is handed the same plugin context.
 */
export function shareContextReferenceResolutions(
  resolve: ContextReferenceResolver = resolveContextReferences
): ContextReferenceResolver {
  const held = new Map<string, Promise<ContextReferenceResolution>>();
  const keyOf = ({ prefix, id }: ContextReference) => `${prefix}\0${id}`;
  return (references) => {
    const missing = new Map<string, ContextReference>();
    for (const reference of references) {
      const key = keyOf(reference);
      if (!held.has(key)) missing.set(key, reference);
    }
    if (missing.size > 0) {
      const asked = [...missing.values()];
      const answer = resolve(asked);
      asked.forEach((reference, index) => {
        held.set(
          keyOf(reference),
          answer.then((results) => results[index] ?? { status: "unknown" })
        );
      });
    }
    return Promise.all(references.map((reference) => held.get(keyOf(reference))!));
  };
}

export type WorkingDiffReader = (cwd: string, type: DiffContextType) => Promise<string>;

export const readWorkingDiff: WorkingDiffReader = (cwd, type) =>
  window.electron.git.getWorkingDiff(cwd, type);

/**
 * A reader that asks main once per working directory and diff type, however
 * many agents or tokens name it: every agent a fleet send reaches in one
 * worktree gets the same snapshot, failure included, and the send stays clear
 * of the channel's rate limit.
 */
export function shareWorkingDiffReads(
  read: WorkingDiffReader = readWorkingDiff
): WorkingDiffReader {
  const held = new Map<string, Promise<string>>();
  return (cwd, type) => {
    const key = `${cwd}\0${type}`;
    let reading = held.get(key);
    if (!reading) {
      try {
        reading = read(cwd, type);
      } catch (err) {
        reading = Promise.reject(err);
      }
      held.set(key, reading);
    }
    return reading;
  };
}

export type DraftContextKind = "terminal" | "selection" | "diff" | "notes" | "plugin";

export interface DraftContextToken {
  /** The token as typed, e.g. `@diff:staged`. */
  text: string;
  kind: DraftContextKind;
}

/** The distinct context tokens a send would expand, in the order they first appear. */
export function listDraftContextTokens(text: string): DraftContextToken[] {
  const found: Array<{ start: number; end: number; kind: DraftContextKind }> = [
    ...getAllAtTerminalTokens(text).map((t) => ({ ...t, kind: "terminal" as const })),
    ...getAllAtSelectionTokens(text).map((t) => ({ ...t, kind: "selection" as const })),
    ...getAllAtDiffTokens(text).map((t) => ({ ...t, kind: "diff" as const })),
    ...getAllAtNotesTokens(text).map((t) => ({ ...t, kind: "notes" as const })),
    ...getAllAtContextReferences(text).map((t) => ({ ...t, kind: "plugin" as const })),
  ].sort((a, b) => a.start - b.start);
  const tokens: DraftContextToken[] = [];
  const seen = new Set<string>();
  for (const { start, end, kind } of found) {
    const token = text.slice(start, end);
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push({ text: token, kind });
  }
  return tokens;
}

export interface DraftContextSource {
  /** Whose screen `@terminal` and `@selection` read. */
  terminalId: string;
  /** Where `@diff` is taken. */
  cwd: string;
  /** Reads `@diff`; without one, each distinct diff is read once for this draft. */
  readDiff?: WorkingDiffReader;
  resolveReferences?: ContextReferenceResolver;
  /**
   * Handed the notes `@notes` took, for the caller to clear once the text is
   * delivered. Without it the caller can't report delivery, and notes stay out
   * of the text.
   */
  onDiffNotesTaken?: (notes: readonly DiffNote[]) => void;
}

/**
 * `@terminal`, `@selection`, `@diff`, `@notes` and plugin context references
 * replaced by what they name for `source`, read now. Every failure is a visible
 * placeholder in the token's place, so nothing returns as a bare token except
 * a reference no provider holds.
 */
export async function expandDraftContext(
  text: string,
  {
    terminalId,
    cwd,
    readDiff = shareWorkingDiffReads(),
    resolveReferences = resolveContextReferences,
    onDiffNotesTaken,
  }: DraftContextSource
): Promise<string> {
  const terminalTokens = getAllAtTerminalTokens(text);
  const selectionTokens = getAllAtSelectionTokens(text);
  const diffTokens = getAllAtDiffTokens(text);
  const contextReferences = getAllAtContextReferences(text);
  // Ahead of every await: the notes as they read when the send began.
  const notesExpansions = expandDiffNotesTokens(
    getAllAtNotesTokens(text),
    terminalId,
    onDiffNotesTaken
  );
  // Started first so the plugins answer while the diff is fetched; every
  // reference resolves in parallel under main's deadline.
  const contextExpansions =
    contextReferences.length > 0
      ? expandContextReferences(contextReferences, resolveReferences, activeProviderName)
      : null;

  const replacements: TokenExpansion[] = [...notesExpansions];

  for (const token of terminalTokens) {
    const managed = peekTerminalService()?.get(terminalId);
    let replacement: string;
    if (managed) {
      const content = readTerminalTail(
        managed.terminal.buffer.active,
        TERMINAL_CONTEXT_LINES,
        TERMINAL_CONTEXT_ROWS
      );
      replacement = content ? fenceTokenExpansion(content) : "[No terminal output]";
    } else {
      replacement = "[Terminal not available]";
    }
    replacements.push({ start: token.start, end: token.end, replacement });
  }

  for (const token of selectionTokens) {
    const selection = peekTerminalService()?.getCachedSelection(terminalId);
    const replacement = selection ? fenceTokenExpansion(selection) : "[No terminal selection]";
    replacements.push({ start: token.start, end: token.end, replacement });
  }

  for (const token of diffTokens) {
    let replacement: string;
    try {
      const raw = await readDiff(cwd, token.diffType);
      if (raw) {
        replacement = fenceTokenExpansion(raw, "diff");
      } else {
        const labels: Record<DiffContextType, string> = {
          unstaged: "working tree",
          staged: "staged",
          head: "HEAD",
        };
        replacement = `No ${labels[token.diffType]} changes.`;
      }
    } catch (err) {
      const msg = formatErrorMessage(err, "Failed to fetch diff");
      replacement = `[Error fetching diff: ${msg}]`;
    }
    replacements.push({ start: token.start, end: token.end, replacement });
  }

  if (contextExpansions) replacements.push(...(await contextExpansions));

  return resolveTokenExpansions(text, replacements);
}
