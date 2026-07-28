import { djb2 } from "./hash.js";

/**
 * Emoji a project carries until someone chooses otherwise. Kept as the "unset"
 * signal — the open-an-existing-repo path never overwrites it, so a plain tree
 * still means "nobody has set an identity here".
 */
export const DEFAULT_PROJECT_EMOJI = "🌲";

/**
 * Whole-token keyword matches, checked in the order the tokens appear in the
 * name so `mobile-api` suggests 📱 (its first meaningful token) rather than
 * whichever key happens to sit earlier in this map.
 */
const KEYWORD_EMOJI = new Map<string, string>(
  Object.entries({
    api: "🔌",
    server: "🖥️",
    backend: "🖥️",
    service: "🛎️",
    web: "🌐",
    frontend: "🎨",
    ui: "🎨",
    mobile: "📱",
    ios: "📱",
    android: "🤖",
    docs: "📚",
    documentation: "📚",
    bot: "🤖",
    agent: "🤖",
    ai: "🧠",
    data: "📊",
    database: "🗄️",
    db: "🗄️",
    auth: "🔐",
    security: "🔐",
    cli: "⌨️",
    terminal: "⌨️",
    infra: "🏗️",
    devops: "🏗️",
    cloud: "☁️",
    test: "🧪",
    tests: "🧪",
    game: "🎮",
  })
);

/**
 * Fallback pool for names with no keyword hit. Deliberately excludes
 * `DEFAULT_PROJECT_EMOJI` so a suggestion is always visibly distinct from the
 * unset tree.
 */
const FALLBACK_EMOJI = [
  "🚀",
  "✨",
  "🧭",
  "🛠️",
  "⚙️",
  "🧩",
  "📦",
  "🧪",
  "🔧",
  "💡",
  "🎯",
  "🌐",
  "🗂️",
  "🪄",
  "🛰️",
  "🏗️",
] as const;

/**
 * Split on separators and camelCase boundaries, lowercased and NFC-normalized.
 * The case boundary and the separator class are both Unicode-aware: an
 * ASCII-only `[a-z][A-Z]` split misses `δDocs`, and dropping `\p{M}` would
 * shred any script that writes with combining marks.
 */
function tokenize(name: string): string[] {
  return name
    .normalize("NFC")
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2")
    .toLowerCase()
    .normalize("NFC")
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter(Boolean);
}

/**
 * Suggest an emoji for a project from its folder or repository name: a small
 * keyword map first, then a deterministic hash pick so the same name always
 * yields the same emoji.
 *
 * Pure string logic — no fs, no DOM — so both the renderer dialogs and the
 * main process can call it.
 */
export function suggestProjectEmoji(name: string): string {
  if (typeof name !== "string") return DEFAULT_PROJECT_EMOJI;
  const trimmed = name.trim();
  if (!trimmed) return DEFAULT_PROJECT_EMOJI;

  const tokens = tokenize(trimmed);
  for (const token of tokens) {
    // A Map, not an object literal — a plain-object lookup would resolve
    // `constructor`/`toString` to an inherited function and return it as the
    // "emoji".
    const match = KEYWORD_EMOJI.get(token);
    if (match) return match;
  }

  // Hash the normalized token join rather than the raw string so `My-API` and
  // `my api` land on the same suggestion.
  const key = tokens.length > 0 ? tokens.join(" ") : trimmed.normalize("NFC").toLowerCase();
  return FALLBACK_EMOJI[Math.abs(djb2(key)) % FALLBACK_EMOJI.length]!;
}
