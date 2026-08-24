import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { refractor } from "refractor/core";
import {
  ensureLanguage,
  isLanguageFailed,
  isLanguageRegistered,
} from "@/components/Worktree/diffRefractor";

/**
 * The one syntax-highlighted fence body, shared by every markdown surface.
 *
 * Extracted from `MarkdownDocument` when the assistant panel needed the same thing:
 * two copies of a lazy-grammar component would have drifted on the details that are
 * easy to get subtly wrong — which aliases resolve, what a failed grammar falls back
 * to, whether a cold load re-renders. The COLOURS are not shared and must not be:
 * each host scopes its own `.token` rules, because the assistant panel takes its ink
 * from the terminal theme and the file viewer takes its ink from the app theme.
 */

/**
 * Fence-info aliases → the grammar keys diffRefractor's loaders know.
 * refractor registers Prism's own aliases (ts, py, …) once the grammar is
 * loaded; this map only bridges the *loader* lookup for grammars that are
 * still cold.
 */
const FENCE_LANG_ALIASES: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  py: "python",
  rb: "ruby",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  "c++": "cpp",
  cs: "csharp",
  dockerfile: "docker",
  html: "markup",
  xml: "markup",
};

export function canonicalLang(lang: string): string {
  const lower = lang.toLowerCase();
  return FENCE_LANG_ALIASES[lower] ?? lower;
}

export interface HighlightedCodeProps {
  language: string;
  code: string;
  /**
   * Whether to highlight at all. `false` renders the identical characters as plain
   * text.
   *
   * This exists for STREAMING hosts. A fence arrives a token at a time, so mid-stream
   * the text is a syntactically broken fragment — an unterminated string, half an
   * identifier — and highlighting it means re-tokenising the whole growing buffer on
   * every frame to produce colours that are wrong until the last character lands.
   * Both halves of that are bad: the cost is quadratic over a turn, and the visible
   * result is a block that flickers between interpretations of itself while it fills.
   *
   * Passing `false` while the text is still arriving and `true` once it settles costs
   * one highlight per block and shows the reader a stable answer.
   */
  enabled?: boolean;
}

/**
 * Highlights synchronously when the grammar is registered; otherwise kicks off
 * diffRefractor's lazy grammar load and re-renders once it lands. Falls back to
 * plain text for unknown grammars — same downgrade behavior as the diff viewer.
 */
export function HighlightedCode({ language, code, enabled = true }: HighlightedCodeProps) {
  const lang = canonicalLang(language);
  const [grammarRevision, setGrammarRevision] = useState(0);

  useEffect(() => {
    // A cold grammar is not fetched while highlighting is off. The load is the
    // expensive half and a streaming host would otherwise pay it for a block whose
    // language may still change as the info string finishes arriving.
    if (!enabled) return undefined;
    if (isLanguageRegistered(lang) || isLanguageFailed(lang)) return undefined;
    let cancelled = false;
    void ensureLanguage(lang).then(() => {
      if (!cancelled) setGrammarRevision((revision) => revision + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [lang, enabled]);

  const highlighted = useMemo<ReactNode>(() => {
    void grammarRevision;
    if (!enabled) return null;
    if (!isLanguageRegistered(lang)) return null;
    try {
      return toJsxRuntime(refractor.highlight(code, lang), { Fragment, jsx, jsxs });
    } catch {
      return null;
    }
  }, [code, lang, grammarRevision, enabled]);

  return <code className={`language-${lang}`}>{highlighted ?? code}</code>;
}
