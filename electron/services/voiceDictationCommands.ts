/**
 * Dictation-command post-processor for the OpenAI realtime transcription path.
 *
 * Spoken break commands ("new paragraph" → \n\n, "new line" → \n) arrive as
 * literal text; this module rewrites them in post-processing. Punctuation words
 * ("period", "comma", ...) are deliberately not commands: both providers punctuate
 * on their own, and those words are ordinary in technical speech.
 *
 * "send it" at the very end of an utterance asks for the prompt to be sent; it is
 * stripped here and reported as a flag, since only the renderer can send.
 *
 * Safety: commands only fire when they form a trailing chain at the end of the
 * utterance, optionally wrapped in the model's own punctuation. Mid-sentence uses
 * like "I'll add a new paragraph here" stay literal.
 */

type CommandPhrase = string;
type CommandReplacement = string;

const COMMAND_MAP: ReadonlyArray<readonly [CommandPhrase, CommandReplacement]> = [
  ["new paragraph", "\n\n"],
  ["new line", "\n"],
];

const COMMAND_REPLACEMENTS = new Map<string, string>(
  COMMAND_MAP.map(([phrase, replacement]) => [phrase, replacement])
);

const COMMAND_ALTERNATION = COMMAND_MAP.map(([phrase]) => phrase.replace(/\s+/g, "\\s+")).join("|");

// Matches a trailing chain of one or more commands separated by whitespace or
// the model's punctuation. \b anchors at a word boundary; $ anchors at end of
// string so commands embedded mid-sentence stay literal. Trailing punctuation the
// model added after the command ("new paragraph.") is consumed with it.
const TRAILING_PUNCT = "[\\s.,;:!?]";
const TRAILING_CHAIN_RE = new RegExp(
  `\\s*\\b((?:${COMMAND_ALTERNATION})(?:${TRAILING_PUNCT}+(?:${COMMAND_ALTERNATION}))*)${TRAILING_PUNCT}*$`,
  "i"
);

// Used to tokenize a captured chain back into individual command phrases.
const SINGLE_COMMAND_RE = new RegExp(`(?:${COMMAND_ALTERNATION})`, "gi");

/**
 * Replace trailing spoken dictation commands with their text equivalents.
 *
 * Only the chain of commands at the END of the utterance is replaced — text
 * preceding the chain is preserved verbatim. A "chain" is one or more
 * recognized commands separated by whitespace.
 *
 * Examples:
 *   applyDictationCommands("hello new line")            → "hello\n"
 *   applyDictationCommands("Hello, new paragraph.")     → "Hello,\n\n"
 *   applyDictationCommands("new paragraph")             → "\n\n"
 *   applyDictationCommands("I'll add a new paragraph here") → unchanged
 *
 * Idempotent on text without trailing commands.
 */
export function applyDictationCommands(text: string): string {
  const chain = trailingDictationCommands(text);
  return chain ? text.slice(0, chain.start) + chain.replacement : text;
}

/**
 * Where the trailing chain of break commands in `text` starts, and the breaks
 * it stands for, or null when `text` doesn't end in one.
 */
export function trailingDictationCommands(
  text: string
): { start: number; replacement: string } | null {
  const match = TRAILING_CHAIN_RE.exec(text);
  if (!match) return null;

  const phrases = match[1].match(SINGLE_COMMAND_RE);
  if (!phrases || phrases.length === 0) return null;

  const replacement = phrases
    .map((phrase) => {
      const key = phrase.replace(/\s+/g, " ").toLowerCase();
      return COMMAND_REPLACEMENTS.get(key) ?? phrase;
    })
    .join("");
  return { start: match.index, replacement };
}

const BREAK_COMMAND_WORDS = COMMAND_MAP.map(([phrase]) => phrase.split(" "));
const SEND_COMMAND_WORDS = ["send", "it"];
// A word as the command patterns see one: anything between their separators.
const COMMAND_WORD_RE = /[^\s.,;:!?]+/g;
// More than any chain of commands anyone says in one breath.
const MAX_PENDING_COMMAND_WORDS = 12;

/** Whether `words` could still grow into break commands, optionally closed by "send it". */
function couldBeCommands(words: readonly string[]): boolean {
  let at = 0;
  while (at < words.length) {
    const rest = words.slice(at);
    const phrase = BREAK_COMMAND_WORDS.find((candidate) =>
      candidate.every((word, i) => i >= rest.length || rest[i] === word)
    );
    if (phrase) {
      at += phrase.length;
      continue;
    }
    return rest.every((word, i) => SEND_COMMAND_WORDS[i] === word);
  }
  return true;
}

/**
 * Where the words that could still be trailing commands start in `text`: "new",
 * "new line", "send" or "new line send it" at its end, which more speech may
 * finish or turn into prose. -1 when nothing at the end could be one.
 */
export function pendingCommandStart(text: string): number {
  const words = [...text.matchAll(COMMAND_WORD_RE)].slice(-MAX_PENDING_COMMAND_WORDS);
  const lowered = words.map((word) => word[0].toLowerCase());
  for (let from = 0; from < words.length; from++) {
    if (couldBeCommands(lowered.slice(from))) return words[from]!.index;
  }
  return -1;
}

const SEND_COMMAND_RE = /(?:^|[\s.,;:!?]+)\bsend\s+it[\s.,;:!?]*$/i;

const CLAUSE_BREAK_RE = /[.,;:!?\u2014\u2013]/;

// Negation anywhere in the clause ("don't actually send it", "do not ever send
// it") makes "send it" part of the sentence, not an order.
const NEGATION_RE =
  /(?:^|[^\p{L}\p{N}'\u2019])(?:(?:do|does|did|is|are|was|were|wo|ca|would|could|should|must|need|has|have|had|might)n['\u2019]?t|not|never|cannot|no)(?![\p{L}\p{N}])/iu;

// "you send it", "before we send it", "I'll send it", "should send it", "to send
// it": the word before names who sends or what sending is meant to do.
const SENDER_BEFORE_RE =
  /(?:^|[^\p{L}\p{N}'\u2019])(?:(?:i|you|we|they|he|she|who)(?:['\u2019](?:ll|d|ve|re))?|will|would|shall|should|could|can|may|might|must|to)\s+(?:(?:actually|eventually|also|always|really|probably|ever|still|just|then)\s+)*$/iu;

// "where should the handler send it": a clause opening on a question word.
// "when" counts only before an auxiliary, since "when ready send it" is an order.
const QUESTION_OPENER_RE =
  /^\s*(?:(?:where|what|whom|whose|which|who|how|why)|when\s+(?:should|will|would|do|does|did|can|could|is|are))(?![\p{L}\p{N}])/iu;

/**
 * Whether the "send it" that starts at `index` belongs to its sentence rather
 * than standing as an order: a question, a negated or subject-led clause, or a
 * statement about sending.
 */
function isSentenceSendIt(text: string, index: number, tail: string): boolean {
  if (tail.includes("?")) return true;
  const before = text.slice(0, index);
  let clauseStart = 0;
  for (let i = before.length - 1; i >= 0; i--) {
    if (CLAUSE_BREAK_RE.test(before[i])) {
      clauseStart = i + 1;
      break;
    }
  }
  const clause = before.slice(clauseStart);
  return (
    NEGATION_RE.test(clause) || QUESTION_OPENER_RE.test(clause) || SENDER_BEFORE_RE.test(clause)
  );
}

export interface SendCommandResult {
  text: string;
  send: boolean;
}

/**
 * Strip a trailing spoken "send it" from an utterance.
 *
 * Examples:
 *   extractSendCommand("fix the login bug, send it.") → { text: "fix the login bug", send: true }
 *   extractSendCommand("Send it")                      → { text: "", send: true }
 *   extractSendCommand("then send it to the API")      → unchanged, send: false
 *   extractSendCommand("but don't send it")            → unchanged, send: false
 *   extractSendCommand("let me review it before you send it") → unchanged, send: false
 */
export function extractSendCommand(text: string): SendCommandResult {
  const match = SEND_COMMAND_RE.exec(text);
  if (!match) return { text, send: false };
  const phraseStart = match.index + match[0].search(/send/i);
  if (isSentenceSendIt(text, phraseStart, text.slice(phraseStart))) return { text, send: false };
  return { text: text.slice(0, match.index).trimEnd(), send: true };
}
