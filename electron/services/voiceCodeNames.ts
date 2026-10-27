import { holdsCredential, isSecretShaped } from "./voiceKeytermSecrets.js";

/**
 * Code names a dictation spells out word by word. A speaker says
 * "voice recording service" for `VoiceRecordingService` and "node PTY" for
 * `node-pty`; the recogniser writes the words, and cleanup can only join them
 * if it knows the name exists. The index holds the repository's names and the
 * identifier-shaped names of its files and folders, keyed by their letters and
 * digits run together; a passage's runs of words are looked up in it, and only
 * the names the speaker said go to cleanup.
 */

// A name made of several parts with no space between them: an internal
// capital (useShallow, VoiceRecordingService) or a digit (e2e, Nova3). A plain
// lowercase or hyphenated file name ("dark-mode.css") is an ordinary phrase as
// often as a name, so files only count when they look like code.
const CODE_SHAPED_RE = /^(?=.*\p{Ll})(?=.*(?:\p{Ll}\p{Lu}|\p{L}\p{N}|\p{N}\p{L}))[\p{L}\p{N}_-]+$/u;
const NON_KEY_RE = /[^\p{L}\p{N}]+/gu;
const WORD_RE = /[\p{L}\p{N}]+/gu;
// A name is said within one clause: "keep the voice recording. Service
// workers can wait." never spells VoiceRecordingService. Sentence punctuation
// breaks before a space (a closing quote or bracket may come between), so a
// path, URL or decimal stays whole; brackets, dashes and line breaks always break.
const CLAUSE_BREAK_RE = /[.!?;:,]+["'\u201d\u2019)\]]*(?=\s|$)|[()[\]\u2014\u2013\n]/u;
// Short keys collide with ordinary words run together ("toDo" for "to do").
const MIN_KEY_LENGTH = 6;
const MAX_NAME_LENGTH = 60;
const MAX_INDEX_NAMES = 40_000;
// A listing past this is scanned no further, so a huge repository costs a
// bounded build.
const MAX_SCANNED_FILES = 100_000;
// A name is at most this many spoken words.
const MAX_RUN_WORDS = 6;
export const MAX_CODE_NAMES_PER_PASSAGE = 12;

export type CodeNameIndex = ReadonlyMap<string, string>;

function keyOf(name: string): string {
  return name.toLowerCase().replace(NON_KEY_RE, "");
}

// "src/services/VoiceRecordingService.test.ts" names its folders and
// "VoiceRecordingService": each segment up to its first dot.
function pathNames(file: string): string[] {
  return file
    .split(/[\\/]/)
    .map((segment) => segment.split(".")[0] ?? "")
    .filter(Boolean);
}

function keyFor(name: string): string | null {
  if (name.length > MAX_NAME_LENGTH) return null;
  const key = keyOf(name);
  if (key.length < MIN_KEY_LENGTH) return null;
  if (holdsCredential(name) || isSecretShaped(name)) return null;
  return key;
}

/**
 * The index of code names: every name in `repositoryNames` (packages and
 * dependencies are chosen names, hyphenated or not), which keep their key
 * whatever a file spells, then identifier-shaped file and folder names from
 * `files`, a key spelled several ways keeping the spelling seen most.
 * Secret-shaped names never go in.
 */
export function buildCodeNameIndex(
  files: readonly string[],
  repositoryNames: readonly string[] = []
): CodeNameIndex {
  const index = new Map<string, string>();
  for (const raw of repositoryNames) {
    const name = raw.replace(/^@[^/]+\//, "");
    const key = keyFor(name);
    if (key && !index.has(key) && index.size < MAX_INDEX_NAMES) index.set(key, name);
  }
  const counts = new Map<string, Map<string, number>>();
  for (const file of files.slice(0, MAX_SCANNED_FILES)) {
    for (const name of pathNames(file)) {
      if (!CODE_SHAPED_RE.test(name)) continue;
      const key = keyFor(name);
      if (!key || index.has(key)) continue;
      if (!counts.has(key) && index.size + counts.size >= MAX_INDEX_NAMES) continue;
      const spellings = counts.get(key) ?? new Map<string, number>();
      spellings.set(name, (spellings.get(name) ?? 0) + 1);
      counts.set(key, spellings);
    }
  }
  for (const [key, spellings] of counts) {
    let best = "";
    let bestCount = -1;
    for (const [name, count] of spellings) {
      if (count > bestCount) {
        best = name;
        bestCount = count;
      }
    }
    index.set(key, best);
  }
  return index;
}

/**
 * The code names `text` says as separate words, in the order said, at most
 * `MAX_CODE_NAMES_PER_PASSAGE`. A name is said within one clause, the longest
 * run at each place wins, and a name already written as one word isn't one
 * the speaker spelled out.
 */
export function matchCodeNames(text: string, index: CodeNameIndex): string[] {
  if (index.size === 0) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  for (const clause of text.split(CLAUSE_BREAK_RE)) {
    const words = Array.from(clause.matchAll(WORD_RE), (match) => match[0].toLowerCase());
    for (let i = 0; i < words.length && found.length < MAX_CODE_NAMES_PER_PASSAGE;) {
      let matched = 0;
      for (let n = Math.min(MAX_RUN_WORDS, words.length - i); n >= 2; n--) {
        const name = index.get(words.slice(i, i + n).join(""));
        if (name === undefined) continue;
        if (!seen.has(name)) {
          seen.add(name);
          found.push(name);
        }
        matched = n;
        break;
      }
      i += matched || 1;
    }
  }
  return found;
}
