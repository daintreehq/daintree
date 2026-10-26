import {
  COMPLETION_TRIGGER_SPOKEN_FORMS,
  type CompletionKind,
  type CompletionSourceConfig,
  type CompletionTrigger,
} from "../types/completionSources.js";
import type { SlashCommand, SlashCommandScope } from "../types/slashCommands.js";

/**
 * One command or skill the dictation target accepts, derived from the agent's
 * declared completion sources, so dictation writes exactly what its composer's
 * autocomplete would insert.
 */
export interface VoiceCommandEntry {
  /** Written exactly as a typed one: `/review`, `$plugin-creator`, `/prompts:deploy`. */
  token: string;
  /** The label prefix the token opens with. */
  prefix: string;
  /** The name after the prefix as spoken words: `plugin creator`. */
  spokenName: string;
  /** The name lowercased with every separator removed, for matching speech. */
  key: string;
  scope: SlashCommandScope;
  kind?: CompletionKind;
  description: string;
}

interface VoiceCommandPrefix {
  prefix: string;
  /** Each way of saying the prefix, as lowercase words. */
  spoken: readonly (readonly string[])[];
}

export interface VoiceCommandVocabulary {
  /** Most likely first: the user's own commands before the agent's built-ins. */
  entries: readonly VoiceCommandEntry[];
  /** Longest first, so `/prompts:` is tried before `/`. */
  prefixes: readonly VoiceCommandPrefix[];
}

export const EMPTY_VOICE_COMMAND_VOCABULARY: VoiceCommandVocabulary = {
  entries: [],
  prefixes: [],
};

// Project and user commands are the user's own, and the likeliest to be both
// dictated and misheard; built-ins are mostly plain words.
const SCOPE_LIKELIHOOD: Record<SlashCommandScope, number> = {
  project: 0,
  user: 1,
  global: 2,
  "built-in": 3,
};

// Longer than any command name anyone says aloud.
const MAX_NAME_WORDS = 6;
// How far into the dictation correction may find the words a command it
// introduced was named by ("please run the plugin creator skill").
const MAX_LEAD_WORDS = 8;
const NON_WORD_RE = /[^\p{L}\p{N}]+/gu;
const LEADING_SEPARATORS_RE = /^[\s,.;:!?…-]+/u;
const COMMAND_SHAPED_RE = /^[\p{L}\p{N}][\p{L}\p{N}_:.-]*$/u;
// Joins a prefix to its name when said aloud: "slash prompts colon deploy".
const SPOKEN_JOINERS = new Set(["colon"]);

function toWords(text: string): string[] {
  return text.toLowerCase().split(NON_WORD_RE).filter(Boolean);
}

function toKey(text: string): string {
  return text.toLowerCase().replace(NON_WORD_RE, "");
}

function spokenName(name: string): string {
  return name
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .split(/[-_:.\s/]+/u)
    .filter(Boolean)
    .join(" ");
}

function sourcePrefix(source: CompletionSourceConfig): string {
  return source.discovery.method === "static" ? source.trigger : source.discovery.derive.labelPrefix;
}

function spokenPrefixForms(trigger: CompletionTrigger, prefix: string): string[][] {
  const tail = toWords(prefix.startsWith(trigger) ? prefix.slice(trigger.length) : prefix);
  return COMPLETION_TRIGGER_SPOKEN_FORMS[trigger].map((form) => [...toWords(form), ...tail]);
}

/**
 * The commands and skills of `commands` that dictation may write, keyed by the
 * prefixes `sources` declare. A command whose token no declared prefix opens,
 * or that holds whitespace, is left out: dictation can't write it the way the
 * composer would.
 */
export function buildVoiceCommandVocabulary(
  commands: readonly SlashCommand[],
  sources: readonly CompletionSourceConfig[]
): VoiceCommandVocabulary {
  const prefixesByTrigger = new Map<CompletionTrigger, VoiceCommandPrefix[]>();
  const prefixes: VoiceCommandPrefix[] = [];
  for (const source of sources) {
    const prefix = sourcePrefix(source);
    if (!prefix || prefixes.some((known) => known.prefix === prefix)) continue;
    const entry = { prefix, spoken: spokenPrefixForms(source.trigger, prefix) };
    prefixes.push(entry);
    const forTrigger = prefixesByTrigger.get(source.trigger) ?? [];
    forTrigger.push(entry);
    prefixesByTrigger.set(source.trigger, forTrigger);
  }
  const byLength = (a: VoiceCommandPrefix, b: VoiceCommandPrefix) =>
    b.prefix.length - a.prefix.length;
  prefixes.sort(byLength);
  for (const list of prefixesByTrigger.values()) list.sort(byLength);

  const seen = new Set<string>();
  const entries: VoiceCommandEntry[] = [];
  for (const command of commands) {
    const token = (command.insertText ?? command.label).trim();
    if (!token || /\s/u.test(token) || seen.has(token)) continue;
    const candidates = prefixesByTrigger.get(command.trigger ?? "/") ?? [];
    const match = candidates.find(
      (candidate) => token.startsWith(candidate.prefix) && token.length > candidate.prefix.length
    );
    if (!match) continue;
    const name = token.slice(match.prefix.length);
    const key = toKey(name);
    if (!key) continue;
    seen.add(token);
    entries.push({
      token,
      prefix: match.prefix,
      spokenName: spokenName(name),
      key,
      scope: command.scope,
      ...(command.kind ? { kind: command.kind } : {}),
      description: command.description,
    });
  }
  // Array.prototype.sort is stable, so discovery's own order holds within a scope.
  entries.sort((a, b) => SCOPE_LIKELIHOOD[a.scope] - SCOPE_LIKELIHOOD[b.scope]);
  return { entries, prefixes };
}

interface WordSpan {
  word: string;
  end: number;
}

function wordSpans(text: string, from: number): WordSpan[] {
  const spans: WordSpan[] = [];
  const re = /\S+/gu;
  re.lastIndex = from;
  for (let match = re.exec(text); match; match = re.exec(text)) {
    spans.push({ word: toKey(match[0]), end: match.index + match[0].length });
  }
  return spans;
}

/** Where each way `text` could open with the prefix ends, longest first. */
function matchPrefix(text: string, prefix: VoiceCommandPrefix): number[] {
  const ends: number[] = [];
  if (text.startsWith(prefix.prefix)) ends.push(prefix.prefix.length);
  const words = wordSpans(text, 0);
  for (const form of prefix.spoken) {
    if (form.length === 0 || words.length < form.length) continue;
    if (form.every((word, index) => words[index]!.word === word)) {
      ends.push(words[form.length - 1]!.end);
    }
  }
  return ends.sort((a, b) => b - a);
}

/** The command `text` names from `nameStart` on, and where its name ends. */
function matchName(
  text: string,
  nameStart: number,
  prefix: VoiceCommandPrefix,
  vocabulary: VoiceCommandVocabulary
): { entry: VoiceCommandEntry; end: number } | null {
  const words = wordSpans(text, nameStart);
  // "slash prompts colon deploy": the joiner belongs to the prefix.
  const skip = words.length > 1 && SPOKEN_JOINERS.has(words[0]!.word) ? 1 : 0;
  const limit = Math.min(MAX_NAME_WORDS, words.length - skip);
  for (let count = limit; count >= 1; count--) {
    const key = words
      .slice(skip, skip + count)
      .map((span) => span.word)
      .join("");
    if (!key) continue;
    const entry = vocabulary.entries.find(
      (candidate) => candidate.prefix === prefix.prefix && candidate.key === key
    );
    if (entry) return { entry, end: words[skip + count - 1]!.end };
  }
  return null;
}

/**
 * `text` with a spoken command at its start written as the composer would:
 * "Slash review the last commit." becomes "/review the last commit.". The
 * longest name wins. Null when `text` doesn't open with a prefix followed by
 * one of the vocabulary's own names, so "slash" and anything else stays words.
 */
export function rewriteSpokenCommand(
  text: string,
  vocabulary: VoiceCommandVocabulary
): string | null {
  if (vocabulary.entries.length === 0) return null;
  const trimmed = text.trim();
  for (const prefix of vocabulary.prefixes) {
    for (const nameStart of matchPrefix(trimmed, prefix)) {
      const match = matchName(trimmed, nameStart, prefix, vocabulary);
      if (!match) continue;
      const rest = trimmed.slice(match.end).replace(LEADING_SEPARATORS_RE, "");
      return rest ? `${match.entry.token} ${rest}` : match.entry.token;
    }
  }
  return null;
}

/**
 * Up to `limit` command names to bias recognition toward, most likely first,
 * as they're said ("plugin creator"), since the transcriber matches speech.
 */
export function voiceCommandKeyterms(vocabulary: VoiceCommandVocabulary, limit: number): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const entry of vocabulary.entries) {
    if (terms.length >= limit) break;
    if (entry.key.length < 3) continue;
    const term = entry.spokenName;
    const lower = term.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    terms.push(term);
  }
  return terms;
}

/** The first word of `text` when it opens with one of the vocabulary's prefixes. */
function leadingCommandWord(text: string, vocabulary: VoiceCommandVocabulary): string | null {
  const word = text.trim().split(/\s/u, 1)[0] ?? "";
  return vocabulary.prefixes.some((prefix) => word.startsWith(prefix.prefix)) ? word : null;
}

function knownToken(token: string, vocabulary: VoiceCommandVocabulary): VoiceCommandEntry | null {
  return vocabulary.entries.find((entry) => entry.token === token) ?? null;
}

/** Whether the opening words of `raw` name `entry` ("run the review skill"). */
function namesCommand(raw: string, entry: VoiceCommandEntry): boolean {
  const words = toWords(raw).slice(0, MAX_LEAD_WORDS);
  for (let start = 0; start < words.length; start++) {
    let joined = "";
    for (let end = start; end < words.length && joined.length < entry.key.length; end++) {
      joined += words[end];
      if (joined === entry.key) return true;
    }
  }
  return false;
}

function punctuationCount(text: string): number {
  return text.match(/[.,;:!?…]/gu)?.length ?? 0;
}

/** Whether `corrected` recased a word of `raw` or punctuated inside it. */
function reformatsArguments(raw: string, corrected: string): boolean {
  if (punctuationCount(corrected) > punctuationCount(raw)) return true;
  const rawWords = new Map<string, Set<string>>();
  for (const word of raw.split(/\s+/u).filter(Boolean)) {
    const forms = rawWords.get(word.toLowerCase()) ?? new Set<string>();
    forms.add(word);
    rawWords.set(word.toLowerCase(), forms);
  }
  return corrected
    .split(/\s+/u)
    .filter(Boolean)
    .some((word) => {
      const forms = rawWords.get(word.toLowerCase());
      return forms !== undefined && !forms.has(word);
    });
}

export type VoiceCommandEditRejection =
  "command_changed" | "arguments_reformatted" | "unknown_command" | "unprompted_command";

/**
 * Checks a cleanup's handling of commands. A command `raw` opens with comes
 * back exactly, with its arguments neither recased nor punctuated. A command
 * cleanup introduces must be one the target has, may open only the prompt
 * itself, and must have been named in the dictation's opening words.
 */
export function checkVoiceCommandEdit(
  raw: string,
  corrected: string,
  vocabulary: VoiceCommandVocabulary,
  startsPrompt: boolean
): VoiceCommandEditRejection | null {
  if (vocabulary.prefixes.length === 0) return null;
  const rawLead = leadingCommandWord(raw, vocabulary);
  const correctedLead = leadingCommandWord(corrected, vocabulary);

  if (rawLead && knownToken(rawLead, vocabulary)) {
    if (correctedLead !== rawLead) return "command_changed";
    const args = (text: string) => text.trim().slice(rawLead.length);
    return reformatsArguments(args(raw), args(corrected)) ? "arguments_reformatted" : null;
  }

  if (!correctedLead || correctedLead === rawLead) return null;
  const prefix = vocabulary.prefixes.find((candidate) =>
    correctedLead.startsWith(candidate.prefix)
  );
  // "/etc/hosts" fixed up from "slash etc slash hosts" is a path, not a command.
  if (!prefix || !COMMAND_SHAPED_RE.test(correctedLead.slice(prefix.prefix.length))) return null;
  const entry = knownToken(correctedLead, vocabulary);
  if (!entry) return "unknown_command";
  if (!startsPrompt || !namesCommand(raw, entry)) return "unprompted_command";
  return null;
}
