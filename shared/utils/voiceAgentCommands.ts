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
// Hesitation sounds a cleanup may drop anywhere, including before a command.
const HESITATIONS = new Set(["um", "umm", "uh", "uhh", "uhm", "erm", "hmm", "mm"]);
// At least one of these must be among the lead words: "the review skill is
// broken" mentions a command without asking for it, and "clear the build
// cache" is an instruction that happens to open with a command's name.
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
  /** Lowercased with every separator removed. */
  word: string;
  /** Whether it opens with something other than a letter or digit: a flag, path or reference. */
  symbolic: boolean;
  end: number;
}

function wordSpans(text: string, from: number): WordSpan[] {
  const spans: WordSpan[] = [];
  const re = /\S+/gu;
  re.lastIndex = from;
  for (let match = re.exec(text); match; match = re.exec(text)) {
    spans.push({
      word: toKey(match[0]),
      symbolic: !/^[\p{L}\p{N}]/u.test(match[0]),
      end: match.index + match[0].length,
    });
  }
  return spans;
}

/** Where `text` starts once leading hesitation sounds ("Um, slash review") are skipped. */
function afterHesitations(text: string): number {
  let at = 0;
  for (const span of wordSpans(text, 0)) {
    if (!HESITATIONS.has(span.word)) break;
    at = span.end;
  }
  return at;
}

/** Where each way `text` could open with the prefix at `from` ends, longest first. */
function matchPrefix(text: string, from: number, prefix: VoiceCommandPrefix): number[] {
  const ends: number[] = [];
  const at = text.slice(from).search(/\S/u);
  if (at >= 0 && text.startsWith(prefix.prefix, from + at)) {
    ends.push(from + at + prefix.prefix.length);
  }
  const words = wordSpans(text, from);
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
  const spans = wordSpans(text, nameStart);
  // A name never runs into its arguments: "slash review --force" is `/review`
  // with a flag, even when `/review-force` exists.
  const argumentAt = spans.findIndex((span) => span.symbolic);
  const words = argumentAt < 0 ? spans : spans.slice(0, argumentAt);
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

/** The command `text` opens with, said with its prefix, and where its name ends. */
function matchExplicit(
  text: string,
  vocabulary: VoiceCommandVocabulary
): { entry: VoiceCommandEntry; end: number } | null {
  const from = afterHesitations(text);
  for (const prefix of vocabulary.prefixes) {
    for (const nameStart of matchPrefix(text, from, prefix)) {
      const match = matchName(text, nameStart, prefix, vocabulary);
      if (match) return match;
    }
  }
  return null;
}

/**
 * A spoken command written as the composer would, with where its arguments,
 * copied as said, start in the spoken text (`argsFrom`) and in `text` (`argsAt`).
 */
export interface SpokenCommandRewrite {
  text: string;
  argsFrom: number;
  argsAt: number;
}

/** `rewriteSpokenCommand`, with where the arguments it copied sit on each side. */
export function planSpokenCommand(
  text: string,
  vocabulary: VoiceCommandVocabulary
): SpokenCommandRewrite | null {
  if (vocabulary.entries.length === 0) return null;
  const trimmed = text.trim();
  const match = matchExplicit(trimmed, vocabulary);
  if (!match) return null;
  // The arguments are copied as said: `--force` and `./src` keep every character.
  const rest = trimmed.slice(match.end).trimStart();
  const token = match.entry.token;
  const lead = text.length - text.trimStart().length;
  return {
    text: rest ? `${token} ${rest}` : token,
    argsFrom: lead + trimmed.length - rest.length,
    argsAt: rest ? token.length + 1 : token.length,
  };
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
  return planSpokenCommand(text, vocabulary)?.text ?? null;
}

/**
 * How far `text`, the opening of an utterance, has got toward a spoken
 * command: `pending` while a prefix waits for its name ("slash", "slash
 * plugin"), `extendable` once it names one a longer name still starts with
 * ("slash review" while `/review-pr` exists), `complete` once it names one
 * past that, and `none` when it can't become one.
 */
export function classifySpokenCommandOpening(
  text: string,
  vocabulary: VoiceCommandVocabulary
): "none" | "pending" | "extendable" | "complete" {
  if (vocabulary.entries.length === 0) return "none";
  const trimmed = text.trim();
  const growing = couldStillName(trimmed, vocabulary);
  if (matchExplicit(trimmed, vocabulary)) return growing ? "extendable" : "complete";
  return growing ? "pending" : "none";
}

/**
 * Whether more words could still make `text` name a command: a prefix said in
 * part ("forward" of "forward slash"), or one followed by every word so far of
 * a longer name ("slash review PR" while `/review-pr-comments` exists).
 */
function couldStillName(text: string, vocabulary: VoiceCommandVocabulary): boolean {
  const from = afterHesitations(text);
  const words = wordSpans(text, from);
  if (words.length === 0) return false;
  return vocabulary.prefixes.some((prefix) => {
    const partial = prefix.spoken.some(
      (form) =>
        words.length < form.length && words.every((span, index) => span.word === form[index])
    );
    if (partial) return true;
    return matchPrefix(text, from, prefix).some((nameStart) => {
      const spans = wordSpans(text, nameStart);
      if (spans.some((span) => span.symbolic) || spans.length > MAX_NAME_WORDS) return false;
      const skip = spans.length > 0 && SPOKEN_JOINERS.has(spans[0]!.word) ? 1 : 0;
      const said = spans
        .slice(skip)
        .map((span) => span.word)
        .join("");
      return vocabulary.entries.some(
        (entry) =>
          entry.prefix === prefix.prefix &&
          entry.key.length > said.length &&
          entry.key.startsWith(said)
      );
    });
  });
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
// `$PATH`, `$HOME`: a shell variable, not a skill.
const ENV_VARIABLE_RE = /^\$[A-Z_][A-Z0-9_]*$/u;
const TRAILING_PROSE_PUNCTUATION_RE = /[.,;:!?…]+$/u;

function leadingWord(text: string): string {
  return text.trim().split(/\s/u, 1)[0] ?? "";
}

/**
 * The command a word would be read as, with any prose punctuation after it
 * dropped: `/review`, `$plugin-creator`, `/prompts:deploy` and `/deploy!`, but
 * not `/etc/hosts`, `$PATH` or a bare `/`.
 */
function commandShape(word: string): string | null {
  const bare = word.replace(TRAILING_PROSE_PUNCTUATION_RE, "");
  const trigger = SPOKEN_TRIGGERS.find((candidate) => bare.startsWith(candidate));
  if (trigger === undefined || ENV_VARIABLE_RE.test(bare)) return null;
  return COMMAND_SHAPED_RE.test(bare.slice(trigger.length)) ? bare : null;
}

function knownToken(token: string, vocabulary: VoiceCommandVocabulary): VoiceCommandEntry | null {
  return vocabulary.entries.find((entry) => entry.token === token) ?? null;
}

/** Whether `text` opens with something shaped like a command or skill: `/compact`, `$github`. */
export function opensWithVoiceCommand(text: string): boolean {
  return commandShape(leadingWord(text)) !== null;
}

/** Whether `corrected` opens with a command or skill that `raw` didn't open with. */
export function introducesVoiceCommand(raw: string, corrected: string): boolean {
  const lead = leadingWord(corrected);
  return lead !== leadingWord(raw) && commandShape(lead) !== null;
}

/**
 * Where the arguments start in `raw` when its opening words ask for `entry`,
 * with its prefix ("slash review…") or with a verb that runs it ("please run
 * the review skill on…"), else -1. A sentence that merely opens with the
 * command's name ("clear the build cache") is an instruction to the agent,
 * never a request to run the command, however it's worded.
 */
function invocationArgumentsAt(
  raw: string,
  entry: VoiceCommandEntry,
  vocabulary: VoiceCommandVocabulary
): number {
  const explicit = matchExplicit(raw, vocabulary);
  if (explicit) return explicit.entry === entry ? explicit.end : -1;

  const spans = wordSpans(raw, 0).filter((span) => !HESITATIONS.has(span.word));
  const limit = Math.min(MAX_LEAD_WORDS, spans.length);
  for (let start = 0; start < limit; start++) {
    const lead = spans.slice(0, start).map((span) => span.word);
    if (!lead.every((word) => INVOCATION_LEAD_WORDS.has(word))) return -1;
    if (!lead.some((word) => INVOCATION_VERBS.has(word))) continue;
    let joined = "";
    for (let end = start; end < spans.length && joined.length < entry.key.length; end++) {
      // As with a spoken prefix, `--force` is an argument, never part of a name.
      if (spans[end]!.symbolic) break;
      joined += spans[end]!.word;
      if (joined !== entry.key) continue;
      const noun = spans[end + 1];
      return noun && INVOCATION_NOUNS.has(noun.word) ? noun.end : spans[end]!.end;
    }
  }
  return -1;
}

function withoutHesitations(words: readonly string[]): string[] {
  return words.filter((word) => !HESITATIONS.has(toKey(word)));
}

function sameWords(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export type VoiceCommandEditRejection =
  "command_changed" | "arguments_reformatted" | "unknown_command" | "unprompted_command";

/**
 * Checks a cleanup's handling of commands. A command `raw` opens with comes
 * back exactly, and so do its arguments, word for word, but for hesitation
 * sounds. A command cleanup introduces must be one the target has, may open
 * only the prompt itself, must have been asked for by the dictation's opening
 * words (its trigger, or a verb like "run"), and keeps every word that followed
 * them, or none when the whole phrase named it.
 */
export function checkVoiceCommandEdit(
  raw: string,
  corrected: string,
  vocabulary: VoiceCommandVocabulary,
  startsPrompt: boolean
): VoiceCommandEditRejection | null {
  const trimmedRaw = raw.trim();
  const trimmedCorrected = corrected.trim();
  const rawLead = leadingWord(trimmedRaw);
  const correctedLead = leadingWord(trimmedCorrected);
  const argumentsOf = (text: string, token: string) =>
    withoutHesitations(text.slice(token.length).split(/\s+/u).filter(Boolean));

  if (knownToken(rawLead, vocabulary)) {
    if (correctedLead !== rawLead) return "command_changed";
    const kept = sameWords(
      argumentsOf(trimmedCorrected, rawLead),
      argumentsOf(trimmedRaw, rawLead)
    );
    return kept ? null : "arguments_reformatted";
  }

  // "/etc/hosts" fixed up from "slash etc slash hosts" is a path, not a command.
  if (correctedLead === rawLead) return null;
  // A skill the target has is checked even when it's named in capitals like a
  // shell variable ("$README"); a token with punctuation stuck to it is still
  // not one the composer has.
  const entry = knownToken(correctedLead, vocabulary);
  if (!entry) return commandShape(correctedLead) ? "unknown_command" : null;
  if (!startsPrompt) return "unprompted_command";
  const argumentsAt = invocationArgumentsAt(trimmedRaw, entry, vocabulary);
  if (argumentsAt < 0) return "unprompted_command";
  const words = (text: string) => withoutHesitations(text.split(/\s+/u).filter(Boolean));
  const correctedArguments = words(trimmedCorrected.slice(correctedLead.length));
  const rawArguments = words(trimmedRaw.slice(argumentsAt));
  // The sentence's own closing punctuation may go: it ended prose, not the arguments.
  const last = rawArguments.length - 1;
  if (last >= 0)
    rawArguments[last] = rawArguments[last]!.replace(TRAILING_PROSE_PUNCTUATION_RE, "");
  // Either the rest of what was said comes along exactly as said, or none of
  // it does, when the whole phrase named the command ("please run the compact skill").
  const kept =
    correctedArguments.length === 0 ||
    sameWords(correctedArguments, rawArguments) ||
    sameWords(correctedArguments, words(trimmedRaw.slice(argumentsAt)));
  return kept ? null : "arguments_reformatted";
}

/**
 * `raw` as it reads once the invocation `corrected` introduced is written as
 * its command ("please run the review skill on auth" → "/review on auth"),
 * for the prose guards to measure the rest of the cleanup against. Null when
 * `corrected` introduces no command `checkVoiceCommandEdit` accepts.
 */
export function voiceCommandBaseline(
  raw: string,
  corrected: string,
  vocabulary: VoiceCommandVocabulary
): string | null {
  const trimmedRaw = raw.trim();
  const lead = leadingWord(corrected);
  const entry = lead !== leadingWord(trimmedRaw) ? knownToken(lead, vocabulary) : null;
  if (!entry) return null;
  const argumentsAt = invocationArgumentsAt(trimmedRaw, entry, vocabulary);
  if (argumentsAt < 0) return null;
  const rest = trimmedRaw.slice(argumentsAt).trimStart();
  return rest ? `${entry.token} ${rest}` : entry.token;
}
