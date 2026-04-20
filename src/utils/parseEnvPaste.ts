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

function parseDoubleQuoted(body: string): { value: string; ok: boolean } {
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
          out += next;
          break;
      }
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return { value: out, ok: true };
}

function parseValue(raw: string): { value: string; ok: boolean; reason?: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { value: "", ok: true };
  }

  const first = trimmed[0];
  if (first === '"' || first === "'") {
    const last = trimmed[trimmed.length - 1];
    if (trimmed.length < 2 || last !== first) {
      return { value: "", ok: false, reason: "Unterminated quoted value" };
    }
    const body = trimmed.slice(1, -1);
    if (first === '"') {
      const parsed = parseDoubleQuoted(body);
      return { value: parsed.value, ok: true };
    }
    return { value: body, ok: true };
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
