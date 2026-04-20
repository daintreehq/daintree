/**
 * Pure parser for pasted dotenv content.
 *
 * Supports the canonical subset of the .env format:
 *  - `KEY=value` and `export KEY=value`
 *  - `#` comment lines and inline `# comment` after unquoted whitespace
 *  - `"double quoted"` values with `\n \r \t \\ \"` escape sequences
 *  - `'single quoted'` values (literal — no escapes)
 *  - `\r\n` normalization and UTF-8 BOM stripping
 *
 * Malformed lines (no `=`, invalid key, unterminated quote) are surfaced as
 * `{ line, raw }` parse errors so the UI can point the user at the offending
 * line without hiding data.
 */

export interface ParsedPair {
  key: string;
  value: string;
}

export interface ParseError {
  line: number;
  raw: string;
  reason: string;
}

export interface ParseEnvResult {
  pairs: ParsedPair[];
  errors: ParseError[];
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EXPORT_RE = /^export\s+/;

function decodeDoubleQuoted(body: string): string {
  let out = "";
  let i = 0;
  while (i < body.length) {
    const ch = body[i]!;
    if (ch === "\\" && i + 1 < body.length) {
      const next = body[i + 1]!;
      switch (next) {
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        case "\\":
          out += "\\";
          break;
        case '"':
          out += '"';
          break;
        default:
          // Unknown escape — preserve the backslash so `\q` → `\q`, matching
          // the way most dotenv parsers (and shell tools) treat the sequence.
          out += "\\" + next;
          break;
      }
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function findUnescapedQuote(body: string, quote: string): number {
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\" && quote === '"') {
      i += 1;
      continue;
    }
    if (ch === quote) return i;
  }
  return -1;
}

function parseValue(raw: string): { value: string; ok: boolean; reason?: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { value: "", ok: true };
  }

  const first = trimmed[0];
  if (first === '"' || first === "'") {
    const rest = trimmed.slice(1);
    const closeIdx = findUnescapedQuote(rest, first);
    if (closeIdx === -1) {
      return { value: "", ok: false, reason: "Unterminated quoted value" };
    }
    const body = rest.slice(0, closeIdx);
    // Anything after the closing quote must be whitespace or a `# comment`.
    const tail = rest.slice(closeIdx + 1).trim();
    if (tail.length > 0 && !tail.startsWith("#")) {
      return { value: "", ok: false, reason: "Unexpected text after closing quote" };
    }
    const value = first === '"' ? decodeDoubleQuoted(body) : body;
    return { value, ok: true };
  }

  // Unquoted: strip inline comment starting at `#` preceded by whitespace.
  let end = trimmed.length;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === "#" && i > 0 && /\s/.test(trimmed[i - 1]!)) {
      end = i;
      break;
    }
  }
  return { value: trimmed.slice(0, end).trim(), ok: true };
}

export function parseEnvPaste(text: string): ParseEnvResult {
  const pairs: ParsedPair[] = [];
  const errors: ParseError[] = [];

  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");

  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx]!;
    const lineNumber = idx + 1;
    const trimmed = raw.trim();

    if (trimmed === "") continue;
    if (trimmed.startsWith("#")) continue;

    const withoutExport = trimmed.replace(EXPORT_RE, "");
    const eqIdx = withoutExport.indexOf("=");
    if (eqIdx === -1) {
      errors.push({ line: lineNumber, raw, reason: "Missing '='" });
      continue;
    }

    const keyPart = withoutExport.slice(0, eqIdx).trim();
    const valuePart = withoutExport.slice(eqIdx + 1);

    if (keyPart === "") {
      errors.push({ line: lineNumber, raw, reason: "Empty key" });
      continue;
    }
    if (!KEY_RE.test(keyPart)) {
      errors.push({ line: lineNumber, raw, reason: `Invalid key "${keyPart}"` });
      continue;
    }

    const parsed = parseValue(valuePart);
    if (!parsed.ok) {
      errors.push({ line: lineNumber, raw, reason: parsed.reason ?? "Invalid value" });
      continue;
    }

    pairs.push({ key: keyPart, value: parsed.value });
  }

  return { pairs, errors };
}
