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
const COMMAND_SHAPED_RE = /^[\p{L}\p{N}][\p{L}\p{N}_:.-]*$/u;
// Joins a prefix to its name when said aloud: "slash prompts colon deploy".
const SPOKEN_JOINERS = new Set(["colon"]);
// What may come before a command's name when it's asked for without its
// trigger: "please run the review skill", "can you use plugin creator".
const INVOCATION_LEAD_WORDS = new Set([
  "please",
  "can",
  "could",
  "would",
  "you",
  "lets",
  "let",
  "us",
  "go",
  "now",
  "ok",
  "okay",
  "run",
  "use",
  "invoke",
  "call",
  "execute",
  "trigger",
  "start",
  "do",
  "the",
  "a",
  "an",
  "my",
  "our",
]);
// At least one of these must be among the lead words: "the review skill is
// broken" mentions a command without asking for it.
const INVOCATION_VERBS = new Set([
  "run",
  "use",
  "invoke",
  "call",
  "execute",
  "trigger",
  "start",
  "do",
]);
// What may sit between the name and its arguments: "run the review skill on…".
const INVOCATION_NOUNS = new Set(["skill", "command", "plugin", "prompt"]);

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
  return source.discovery.method === "static"
    ? source.trigger
    : source.discovery.derive.labelPrefix;
}

function spokenPrefixForms(source: CompletionSourceConfig, prefix: string): string[][] {
  if (source.spokenPrefixes) return source.spokenPrefixes.map(toWords);
  const { trigger } = source;
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
    const entry = { prefix, spoken: spokenPrefixForms(source, prefix) };
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
    const matches = vocabulary.entries.filter(
      (candidate) => candidate.prefix === prefix.prefix && candidate.key === key
    );
    // `foo-bar` and `foobar` sound the same; guessing between them would
    // write a command nobody asked for.
    if (matches.length > 1) return null;
    if (matches[0]) return { entry: matches[0], end: words[skip + count - 1]!.end };
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
      // The arguments are copied as said: `--force` and `./src` keep every character.
      const rest = trimmed.slice(match.end).trimStart();
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

// Every trigger a command can be spoken with. Correction may never invent a
// token opening with one, whatever the target accepts.
const SPOKEN_TRIGGERS = (
  Object.entries(COMPLETION_TRIGGER_SPOKEN_FORMS) as [CompletionTrigger, readonly string[]][]
)
  .filter(([, forms]) => forms.length > 0)
  .map(([trigger]) => trigger);

function leadingWord(text: string): string {
  return text.trim().split(/\s/u, 1)[0] ?? "";
}

/** `/review`, `$plugin-creator`, `/prompts:deploy`, but not `/etc/hosts` or `/`. */
function isCommandShaped(word: string): boolean {
  const trigger = SPOKEN_TRIGGERS.find((candidate) => word.startsWith(candidate));
  return trigger !== undefined && COMMAND_SHAPED_RE.test(word.slice(trigger.length));
}

function knownToken(token: string, vocabulary: VoiceCommandVocabulary): VoiceCommandEntry | null {
  return vocabulary.entries.find((entry) => entry.token === token) ?? null;
}

/**
 * Where the arguments start in `raw` when its opening words ask for `entry`
 * ("compact the conversation", "please run the review skill on…"), else -1.
 */
function invocationArgumentsStart(raw: string, entry: VoiceCommandEntry): number {
  const words = toWords(raw);
  const limit = Math.min(MAX_LEAD_WORDS, words.length);
  for (let start = 0; start < limit; start++) {
    const lead = words.slice(0, start);
    if (!lead.every((word) => INVOCATION_LEAD_WORDS.has(word))) return -1;
    if (lead.length > 0 && !lead.some((word) => INVOCATION_VERBS.has(word))) continue;
    let joined = "";
    for (let end = start; end < words.length && joined.length < entry.key.length; end++) {
      joined += words[end];
      if (joined !== entry.key) continue;
      let next = end + 1;
      if (INVOCATION_NOUNS.has(words[next] ?? "")) next++;
      return next;
    }
  }
  return -1;
}

function isSubsequence(needle: readonly string[], haystack: readonly string[]): boolean {
  let found = 0;
  for (const value of haystack) {
    if (found < needle.length && value === needle[found]) found++;
  }
  return found === needle.length;
}

const splitWords = (text: string) => text.split(/\s+/u).filter(Boolean);

export type VoiceCommandEditRejection =
  "command_changed" | "arguments_reformatted" | "unknown_command" | "unprompted_command";

/**
 * Checks a cleanup's handling of commands. A command `raw` opens with comes
 * back exactly, and its arguments may only lose words, never be recased,
 * respelled or punctuated. A command cleanup introduces must be one the target
 * has, may open only the prompt itself, must have been asked for by the
 * dictation's opening words, and keeps the words that followed them.
 */
export function checkVoiceCommandEdit(
  raw: string,
  corrected: string,
  vocabulary: VoiceCommandVocabulary,
  startsPrompt: boolean
): VoiceCommandEditRejection | null {
  const rawLead = leadingWord(raw);
  const correctedLead = leadingWord(corrected);
  const argumentsOf = (text: string, token: string) => text.trim().slice(token.length);

  if (knownToken(rawLead, vocabulary)) {
    if (correctedLead !== rawLead) return "command_changed";
    const kept = isSubsequence(
      splitWords(argumentsOf(corrected, rawLead)),
      splitWords(argumentsOf(raw, rawLead))
    );
    return kept ? null : "arguments_reformatted";
  }

  // "/etc/hosts" fixed up from "slash etc slash hosts" is a path, not a command.
  if (correctedLead === rawLead || !isCommandShaped(correctedLead)) return null;
  const entry = knownToken(correctedLead, vocabulary);
  if (!entry) return "unknown_command";
  if (!startsPrompt) return "unprompted_command";
  const argumentsStart = invocationArgumentsStart(raw, entry);
  if (argumentsStart < 0) return "unprompted_command";
  const kept = isSubsequence(
    toWords(argumentsOf(corrected, correctedLead)),
    toWords(raw).slice(argumentsStart)
  );
  return kept ? null : "arguments_reformatted";
}
