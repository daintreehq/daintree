import type { VoiceDictionaryEntry } from "../types/ipc/api.js";
import { findProtectedRanges } from "./voiceProtectedSpans.js";

/** One "when you hear this, write that" pair from the dictionary. */
export interface HeardAsRule {
  heard: string;
  term: string;
}

/** Rewrites dictated text with the dictionary's heard-as rules. */
export type HeardAsRewriter = (text: string) => string;

const WORD = "[\\p{L}\\p{N}\\p{M}_]";
// Characters that join two words into one token: "react-dom", "let's", "go.mod".
const JOINER = "[-'’./\\\\]";
const BEFORE = `(?<!${WORD})(?<!${WORD}${JOINER})`;
// A possessive "'s" still ends the phrase: "zoo stand's" is "Zustand's".
const AFTER = `(?=['’]s(?!${WORD})|(?!${WORD})(?!${JOINER}${WORD}))`;
// Words of a phrase may be split by any run of spaces, but never a line break.
const GAP = "[^\\S\\r\\n]+";
const HAS_WORD_RE = /[\p{L}\p{N}]/u;

const identity: HeardAsRewriter = (text) => text;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every heard-as pair, oldest entry first. A heard form claimed by two
 * entries belongs to the first, and one with no letters or digits can't be
 * matched as a word, so it's left out.
 */
export function collectHeardAsRules(entries: readonly VoiceDictionaryEntry[]): HeardAsRule[] {
  const rules: HeardAsRule[] = [];
  const claimed = new Set<string>();
  for (const { term, heardAs } of entries) {
    for (const raw of heardAs) {
      const heard = raw.trim().split(/\s+/).join(" ");
      const key = heard.toLowerCase();
      if (!heard || !HAS_WORD_RE.test(heard) || claimed.has(key)) continue;
      claimed.add(key);
      rules.push({ heard, term });
    }
  }
  return rules;
}

/**
 * Compiles the rules into one rewriter. A match is a whole phrase, any case,
 * and becomes the term exactly as written; where two phrases start at the
 * same word the longer wins. One left-to-right pass, so a term written in is
 * never matched again. Code, @-references, URLs, flags and paths are left as
 * they are, even when a phrase only touches them.
 */
export function createHeardAsRewriter(rules: readonly HeardAsRule[]): HeardAsRewriter {
  if (rules.length === 0) return identity;
  const ordered = rules
    .map((rule, index) => ({ ...rule, index }))
    .sort((a, b) => b.heard.length - a.heard.length || a.index - b.index);
  const alternatives = ordered.map(
    ({ heard }) => `(${heard.split(" ").map(escapeRegExp).join(GAP)})`
  );
  const pattern = new RegExp(`${BEFORE}(?:${alternatives.join("|")})${AFTER}`, "giu");

  return (text) => {
    let ranges: ReturnType<typeof findProtectedRanges> | null = null;
    let out = "";
    let copied = 0;
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      const start = match.index;
      const end = start + match[0].length;
      ranges ??= findProtectedRanges(text);
      if (ranges.some((range) => start < range.end && end > range.start)) {
        // A shorter phrase may still start inside the one that was refused.
        pattern.lastIndex = start + (text.codePointAt(start)! > 0xffff ? 2 : 1);
        continue;
      }
      const group = match.findIndex((value, i) => i > 0 && value !== undefined);
      out += text.slice(copied, start) + ordered[group - 1]!.term;
      copied = end;
    }
    return copied === 0 ? text : out + text.slice(copied);
  };
}
