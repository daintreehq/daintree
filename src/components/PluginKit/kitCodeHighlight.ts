import type { ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import type { ElementContent, RootContent } from "hast";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { refractor } from "refractor/core";
import { canonicalLang } from "@/components/Markdown/fenceLanguage";
import {
  ensureLanguage,
  isLanguageFailed,
  isLanguageRegistered,
} from "@/components/Worktree/diffRefractor";
import "@/styles/components/syntax-tokens.css";
import { reportPluginFault } from "./kitDiagnostics";

// The kit CodeBlock's highlighter, loaded on the first block a view renders so
// refractor and its grammars stay out of the kit chunk. The same grammars and
// loader as the diff viewer and Markdown fences, so a snippet is coloured the
// same wherever it appears.

export { canonicalLang, ensureLanguage, isLanguageFailed, isLanguageRegistered };

/**
 * A highlighted tree cut into lines. A token can span a newline (a block
 * comment, a template string), so each element that does is cloned onto every
 * line it reaches, keeping its classes there.
 */
function splitLines(nodes: readonly (RootContent | ElementContent)[]): ElementContent[][] {
  const lines: ElementContent[][] = [[]];
  const current = () => lines[lines.length - 1]!;
  for (const node of nodes) {
    if (node.type === "text") {
      node.value.split("\n").forEach((part, index) => {
        if (index > 0) lines.push([]);
        if (part) current().push({ type: "text", value: part });
      });
    } else if (node.type === "element") {
      splitLines(node.children).forEach((children, index) => {
        if (index > 0) lines.push([]);
        if (children.length > 0) current().push({ ...node, children });
      });
    }
  }
  return lines;
}

const CACHE_MAX_ENTRIES = 32;
const CACHE_MAX_CHARS = 500_000;
const cache = new Map<string, ReactNode[]>();
let cacheGrammarCount = -1;

/**
 * Each line of `code` as highlighted React nodes, or null while the grammar is
 * not registered. Kept in a small cache, since a view re-renders its blocks far
 * more often than their text changes.
 */
export function highlightCodeLines(code: string, language: string): ReactNode[] | null {
  if (!isLanguageRegistered(language)) return null;
  // Embedded grammars (markup's scripts, markdown's fences) highlight only if
  // registered, so a newly loaded one invalidates everything.
  const grammarCount = refractor.listLanguages().length;
  if (grammarCount !== cacheGrammarCount) {
    cache.clear();
    cacheGrammarCount = grammarCount;
  }
  const key = `${language}\n${code}`;
  const cached = cache.get(key);
  if (cached) return cached;
  let lines: ReactNode[];
  try {
    lines = splitLines(refractor.highlight(code, language).children).map((children) =>
      toJsxRuntime({ type: "root", children }, { Fragment, jsx, jsxs })
    );
  } catch (error) {
    reportPluginFault("CodeBlock highlight failed", error);
    return null;
  }
  if (key.length <= CACHE_MAX_CHARS) {
    cache.set(key, lines);
    if (cache.size > CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }
  return lines;
}
