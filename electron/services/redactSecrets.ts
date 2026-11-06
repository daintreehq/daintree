/**
 * Obvious credentials, so the screen that leaves the machine carries none of
 * them. A best-effort net, not a guarantee: anything shaped like a known key
 * or an `x=secret` assignment is replaced before the text is sent.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  /\b(?:sk|pk|rk)-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bwhsec_[A-Za-z0-9]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bhf_[A-Za-z0-9]{30,}\b/g,
  /\b(?:xox[abeprs]|xapp)-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // Cloudflare's scannable tokens: `cfat_` (account), `cfut_` (user), `cfk_` (global key).
  /\bcf(?:at|ut|k)_[A-Za-z0-9]{40}[0-9a-f]{8}\b/g,
  // A Decisions relay's claim secret as its deploy CLI prints it, on a line of its own:
  // `  Claim secret  <value>`, with no `=` or `:` for an assignment to find.
  /^([ \t]*claim[ _-]?secret[ \t]{2,16})(?!\[redacted\])[^\r\n]{16,}/gim,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bya29\.[A-Za-z0-9_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b(Bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  // `Authorization: Basic …`, `"Authorization": "token …"`: the scheme stays,
  // the credential goes.
  /\b(Authorization["']?\s*:\s*["']?[A-Za-z]+)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // A command-line flag and its value, quoted or not: `--password hunter2`,
  // `--client-secret "abc…"`, `--access-token=abc…`. A quoted value stays on
  // its line, so a stray quote can't take the screen below with it.
  /(--(?:[a-z0-9]+-){0,3}(?:password|passwd|passphrase|token|secret|api[_-]?key|access[_-]?key)(?:\s+|=))(["'])(?:\\.|(?!\2)[^\n])*(?:\2|(?=\n|$))/gi,
  /(--(?:[a-z0-9]+-){0,3}(?:password|passwd|passphrase|token|secret|api[_-]?key|access[_-]?key)(?:\s+|=))(?!\[redacted\])[^\s"']+/gi,
];

/**
 * Credentials in a connection string: `postgres://user:pass@host`, or a
 * password alone, `redis://:pass@host`. The scheme is bounded so a long run of
 * word characters can't be rescanned from every position.
 */
const CONNECTION_PASSWORD =
  /(\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:@/]{0,256}:)(?!\[redacted\]@)[^\s@/]+(?=@)/gi;

/**
 * The start of `name = value` or `name: value`, in every style a screen shows
 * them — env (`export FOO_API_KEY=…`), JSON (`"token": "…"`), YAML, TOML,
 * camelCase (`secretAccessKey: …`), dotted (`db.password=…`). Matched only
 * where a name starts, so a long run of word characters is never rescanned
 * from every position inside it; the value is read only for a name that is a
 * secret's (`secretName`), so one inside another's value is still found.
 */
const ASSIGNMENT = /(?<![A-Za-z0-9_.-])(["']?)([A-Za-z0-9_][A-Za-z0-9_.-]*)\1(\s*[:=]\s*)/g;
/**
 * A quoted value, whole. One with no spaces in it may run across lines while
 * its quote closes within a few screens' width, as a long token wrapped at the
 * pane's edge does; anything else ends with its line, so a stray quote can't
 * take the screen below with it.
 */
const QUOTED_VALUE = /(["'])(?:\\[\s\S]|(?!\1)[^\\\s]|\n){0,2048}\1|(["'])(?:\\.|(?!\2)[^\n])*\2?/y;
const BARE_VALUE = /[^\s"',}]+/y;
/** A YAML block scalar's indicator: the value is on the indented lines below. */
const BLOCK_VALUE = /^[|>][-+]?$/;
const INDENTED_LINES = /(?:\n[ \t]+[^\n]*)+/y;
const REST_OF_LINE = /[^\r\n]*/y;
/** A value that says there is none. */
const EMPTY_VALUE = /^(?:undefined|null|nil|none|true|false|n\/a)$/i;

/** Endings that make a word name a secret: `DB_PASSWORD`, `mytoken`, `clientSecret`. `tokens` is a count, not one. */
const SECRET_WORD =
  /(?:password|passwd|passphrase|secret|credentials?|token|apikey|secretkey|privatekey|accesskey|cookie)$/;

/**
 * A last word that names something about a secret rather than the secret
 * itself: `token_count`, `password_length`, `api_key_file`, `secret_name`.
 */
const ATTRIBUTE_WORDS = new Set([
  "count",
  "counts",
  "usage",
  "limit",
  "budget",
  "length",
  "len",
  "size",
  "total",
  "max",
  "min",
  "used",
  "remaining",
  "left",
  "type",
  "kind",
  "name",
  "file",
  "path",
  "dir",
  "url",
  "id",
  "env",
  "header",
  "expiry",
  "expires",
  "ttl",
  "prefix",
  "hint",
  "format",
  "manager",
  "provider",
]);

/** Words an environment name ends in to say which one it is: `STRIPE_KEY_LIVE`. */
const VARIANT_WORDS = new Set([
  "live",
  "test",
  "prod",
  "production",
  "dev",
  "development",
  "staging",
  "local",
  "base",
]);

/** Keys that are not secrets: a table's, a map's, a keyboard's, a public one. */
const PLAIN_KEY_QUALIFIERS = new Set([
  "primary",
  "foreign",
  "sort",
  "partition",
  "range",
  "hash",
  "unique",
  "composite",
  "cache",
  "lookup",
  "map",
  "row",
  "group",
  "index",
  "idempotency",
  "public",
  "translation",
  "i18n",
  "storage",
  "query",
  "react",
  "hot",
  "short",
]);

/**
 * Whether an assignment's name says its value is a credential: a word ending
 * in a secret's name in any style (`DB_PASSWORD`, `clientSecret`, `mytoken`),
 * or ending in a key that is more than the bare word and not a table's or a
 * public one (`STRIPE_KEY`, `privateKey`, `AWS_SECRET_ACCESS_KEY`) — unless its
 * last word says it is about the secret rather than one.
 */
function secretName(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_.-]+/)
    .filter((word) => word !== "");
  if (words.length === 0 || ATTRIBUTE_WORDS.has(words[words.length - 1]!)) return false;
  if (words.some((word) => SECRET_WORD.test(word))) return true;
  let last = words.length - 1;
  while (last > 0 && VARIANT_WORDS.has(words[last]!)) last--;
  return words[last] === "key" && last > 0 && !PLAIN_KEY_QUALIFIERS.has(words[last - 1]!);
}

/** Every assignment to a secret's name, its value replaced. */
function redactAssignments(text: string): string {
  let out = "";
  let from = 0;
  ASSIGNMENT.lastIndex = 0;
  for (let match = ASSIGNMENT.exec(text); match !== null; match = ASSIGNMENT.exec(text)) {
    const [head, quote, name, separator] = match as unknown as [string, string, string, string];
    if (!secretName(name)) continue;
    const valueAt = match.index + head.length;
    let end: number;
    QUOTED_VALUE.lastIndex = valueAt;
    const quoted = QUOTED_VALUE.exec(text);
    if (quoted !== null) {
      end = valueAt + quoted[0].length;
    } else {
      BARE_VALUE.lastIndex = valueAt;
      const bare = BARE_VALUE.exec(text)?.[0];
      if (bare === undefined) continue;
      if (/passphrase/i.test(name) && !separator.includes("\n") && !BLOCK_VALUE.test(bare)) {
        // A passphrase may be several words, so the rest of its line goes with it,
        // unless the whole of it says there is none or was already replaced.
        REST_OF_LINE.lastIndex = valueAt;
        const rest = REST_OF_LINE.exec(text)?.[0] ?? "";
        const whole = rest.trim();
        if (whole === "[redacted]" || EMPTY_VALUE.test(whole)) continue;
        end = valueAt + rest.length;
      } else {
        if (bare === "[redacted]" || EMPTY_VALUE.test(bare)) continue;
        end = valueAt + bare.length;
        if (BLOCK_VALUE.test(bare)) {
          INDENTED_LINES.lastIndex = end;
          end += INDENTED_LINES.exec(text)?.[0].length ?? 0;
        } else if (bare.length < 6 && !/pass(?:word|wd|phrase)/i.test(name)) {
          // A password however short: `password: abc` is still a password.
          continue;
        }
      }
    }
    out += `${text.slice(from, match.index)}${quote}${name}${quote}${separator}[redacted]`;
    from = end;
    ASSIGNMENT.lastIndex = end;
  }
  return out + text.slice(from);
}

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix?: unknown) => {
      if (typeof prefix !== "string" || !match.startsWith(prefix)) return "[redacted]";
      return /[\s:=]$/.test(prefix) ? `${prefix}[redacted]` : `${prefix} [redacted]`;
    });
  }
  out = redactAssignments(out);
  return out.replace(CONNECTION_PASSWORD, (_match, prefix: string) => `${prefix}[redacted]`);
}
