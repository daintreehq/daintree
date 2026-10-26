import type { VoiceDictionaryEntry } from "../types/ipc/api.js";
import { MAX_DICTIONARY_TERM_LENGTH } from "./voiceDictionary.js";
import { findProtectedRanges } from "./voiceProtectedSpans.js";

/** One "when you hear this, write that" pair from the dictionary. */
export interface HeardAsRule {
  heard: string;
  term: string;
}

/**
 * Rewrites dictated text with the dictionary's heard-as rules. With `within`,
 * only phrases inside that span are rewritten and the text around it is
 * context, so a phrase that runs on into a word or a path beside the span is
 * left alone.
 */
export type HeardAsRewriter = (text: string, within?: { from: number; to: number }) => string;

/**
 * Each rule is scanned for at every character, so past this many only the
 * newest entries' rules are kept, as keyterms keep the newest terms.
 */
export const MAX_HEARD_AS_RULES = 1000;

const WORD = "[\\p{L}\\p{N}\\p{M}_]";
// Characters that join two words into one token: "react-dom", "let's", "go.mod".
const JOINER = "[-'’./\\\\]";
const BEFORE = `(?<!${WORD})(?<!${WORD}${JOINER})`;
// A possessive "'s" still ends the phrase: "zoo stand's" is "Zustand's".
const AFTER = `(?=(?:['’]s)?(?!${WORD})(?!${JOINER}${WORD}))`;
// Words of a phrase may be split by any run of spaces, but never a line break.
const GAP = "[^\\S\\r\\n]+";
const HAS_WORD_RE = /[\p{L}\p{N}]/u;
const LINE_BREAK_RE = /[\r\n]/;

const identity: HeardAsRewriter = (text) => text;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const phraseKey = (phrase: string) => phrase.split(/\s+/).join(" ").toLowerCase();

/**
 * Every heard-as pair, oldest entry first. A heard form claimed by two
 * entries belongs to the first. A form with no letters or digits can't be
 * matched as a word, and a term with a line break would move the breaks a
 * transcript is split on, so neither becomes a rule.
 */
export function collectHeardAsRules(entries: readonly VoiceDictionaryEntry[]): HeardAsRule[] {
  const rules: HeardAsRule[] = [];
  const claimed = new Set<string>();
  for (const { term, heardAs } of entries) {
    if (LINE_BREAK_RE.test(term)) continue;
    for (const raw of heardAs) {
      const heard = raw.trim().split(/\s+/).join(" ");
      const key = heard.toLowerCase();
      if (
        !HAS_WORD_RE.test(heard) ||
        heard.length > MAX_DICTIONARY_TERM_LENGTH ||
        claimed.has(key)
      ) {
        continue;
      }
      claimed.add(key);
      rules.push({ heard, term });
    }
  }
  return rules.slice(-MAX_HEARD_AS_RULES);
}

interface CompiledRule extends HeardAsRule {
  source: string;
  exact?: RegExp;
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
  const ordered: CompiledRule[] = rules
    .map((rule, index) => ({
      ...rule,
      index,
      source: rule.heard.split(" ").map(escapeRegExp).join(GAP),
    }))
    .sort((a, b) => b.heard.length - a.heard.length || a.index - b.index);
  const byKey = new Map<string, CompiledRule>();
  for (const rule of ordered) {
    const key = phraseKey(rule.heard);
    if (!byKey.has(key)) byKey.set(key, rule);
  }
  const pattern = new RegExp(
    `${BEFORE}(?:${ordered.map((rule) => rule.source).join("|")})${AFTER}`,
    "giu"
  );
  // The regex folds case for a few letters toLowerCase leaves alone ("ſ", "ς").
  const termFor = (match: string): string | undefined =>
    (
      byKey.get(phraseKey(match)) ??
      ordered.find((rule) => (rule.exact ??= new RegExp(`^(?:${rule.source})$`, "iu")).test(match))
    )?.term;

  return (text, within) => {
    const limit = within?.to ?? text.length;
    let ranges: ReturnType<typeof findProtectedRanges> | null = null;
    let nextRange = 0;
    let out = "";
    let copied = 0;
    pattern.lastIndex = within?.from ?? 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      const start = match.index;
      if (start >= limit) break;
      const end = start + match[0].length;
      ranges ??= findProtectedRanges(text);
      // Matches only move forward, so a range that ends before this one never matters again.
      while (nextRange < ranges.length && ranges[nextRange]!.end <= start) nextRange++;
      const touchesSpan = nextRange < ranges.length && ranges[nextRange]!.start < end;
      const term = end > limit || touchesSpan ? undefined : termFor(match[0]);
      if (term === undefined) {
        // A shorter phrase may still start inside the one that was refused.
        pattern.lastIndex = start + (text.codePointAt(start)! > 0xffff ? 2 : 1);
        continue;
      }
      out += text.slice(copied, start) + term;
      copied = end;
    }
    return copied === 0 ? text : out + text.slice(copied);
  };
}
