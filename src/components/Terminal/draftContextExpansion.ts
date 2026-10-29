import { peek as peekTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";
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
  fenceTokenExpansion,
  resolveTokenExpansions,
  type DiffContextType,
  type TokenExpansion,
} from "./hybridInputParsing";
import { expandContextReferences } from "./contextReferenceExpansion";

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

export type DraftContextKind = "terminal" | "selection" | "diff" | "plugin";

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
  resolveReferences?: ContextReferenceResolver;
}

/**
 * `@terminal`, `@selection`, `@diff` and plugin context references replaced by
 * what they name for `source`, read now. Every failure is a visible
 * placeholder in the token's place, so nothing returns as a bare token except
 * a reference no provider holds.
 */
export async function expandDraftContext(
  text: string,
  { terminalId, cwd, resolveReferences = resolveContextReferences }: DraftContextSource
): Promise<string> {
  const terminalTokens = getAllAtTerminalTokens(text);
  const selectionTokens = getAllAtSelectionTokens(text);
  const diffTokens = getAllAtDiffTokens(text);
  const contextReferences = getAllAtContextReferences(text);
  // Started first so the plugins answer while the diff is fetched; every
  // reference resolves in parallel under main's deadline.
  const contextExpansions =
    contextReferences.length > 0
      ? expandContextReferences(contextReferences, resolveReferences, activeProviderName)
      : null;

  const replacements: TokenExpansion[] = [];

  for (const token of terminalTokens) {
    const managed = peekTerminalService()?.get(terminalId);
    let replacement: string;
    if (managed) {
      const buffer = managed.terminal.buffer.active;
      const start = Math.max(0, buffer.length - 100);
      const lines: string[] = [];
      for (let i = start; i < buffer.length; i++) {
        const line = buffer.getLine(i);
        if (line) lines.push(line.translateToString(true));
      }
      const content = lines.join("\n").trimEnd();
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
      const raw = await window.electron.git.getWorkingDiff(cwd, token.diffType);
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
