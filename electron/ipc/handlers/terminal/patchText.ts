/**
 * Line-ending handling for patches handed to `git apply`.
 *
 * A patch that crossed a Windows terminal, the clipboard or PowerShell's
 * `Set-Content` arrives with CRLF on every line. Under Git for Windows'
 * default `core.autocrlf=true` git copes, but against an LF working tree
 * (`eol=lf` attributes, `autocrlf=false`/`input`) every context line carries a
 * stray `\r` and the patch "does not apply". `--ignore-whitespace` is not the
 * answer: it only relaxes context matching, so the added lines would still be
 * written with their `\r` and the file would end up with mixed line endings.
 */

// git never ends its own header lines with a CR: a file committed with CRLF
// content carries `\r` only on its ` `/`+`/`-` lines, and hunk-header function
// context is trimmed. `---`/`+++` are left out because a removed `-- x` or an
// added `++ x` content line looks the same.
function isUnambiguousHeaderLine(line: string): boolean {
  return line.startsWith("diff --git ") || line.startsWith("@@ ");
}

/**
 * Returns the patch with the CRLF that a transport added stripped back to LF,
 * or `null` when the patch was not converted as a whole (so there is nothing
 * to retry). Only a patch with a CR on every line and on git's own header lines
 * qualifies: one that mixes LF and CRLF lines may carry CRs that belong to the
 * files, such as a section adding a CRLF file or a final `\r` before
 * `\ No newline at end of file`, and stripping those would change their bytes.
 * Exactly one CR is removed per line, so a content line that really ends in a
 * CR (`\r\r\n` after transport) keeps it.
 */
export function stripTransportCrlf(patch: string): string | null {
  const lines = patch.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0 || !lines.every((line) => line.endsWith("\r"))) return null;
  if (!lines.some(isUnambiguousHeaderLine)) return null;
  return patch.replace(/\r(\n|$)/g, "$1");
}

/**
 * Applies `patch` as written first, and only when that fails and the patch
 * carries transport CRLF, once more with it stripped. `git apply` is atomic
 * without `--reject`, so the failed first attempt leaves the tree untouched.
 * The original error is the one reported when both attempts fail.
 */
export async function applyPatchToleratingTransportCrlf(
  patch: string,
  apply: (content: string) => Promise<void>
): Promise<void> {
  try {
    await apply(patch);
  } catch (error) {
    const lfPatch = stripTransportCrlf(patch);
    if (lfPatch === null) throw error;
    try {
      await apply(lfPatch);
    } catch {
      throw error;
    }
  }
}

const C_ESCAPES = new Map<string, number>([
  ["a", 0x07],
  ["b", 0x08],
  ["f", 0x0c],
  ["n", 0x0a],
  ["r", 0x0d],
  ["t", 0x09],
  ["v", 0x0b],
  ['"', 0x22],
  ["\\", 0x5c],
]);

/**
 * Decodes a path git wrote C-style quoted (`core.quotePath`, or a name holding
 * a tab, newline, `"` or `\\`). Octal escapes are raw bytes of the UTF-8 name,
 * so they are gathered as bytes and decoded once. Returns `null` for anything
 * git would not have written, or bytes that are not UTF-8, rather than
 * guessing a name.
 */
function unquoteCStylePath(quoted: string): string | null {
  if (quoted.length < 2 || !quoted.startsWith('"') || !quoted.endsWith('"')) return null;
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  const body = quoted.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '"') return null;
    if (ch !== "\\") {
      const codePoint = body.codePointAt(i)!;
      const char = String.fromCodePoint(codePoint);
      bytes.push(...encoder.encode(char));
      i += char.length - 1;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) return null;
    const octal = /^[0-3][0-7]{2}/.exec(body.slice(i + 1, i + 4));
    if (octal) {
      // git cuts a name at NUL, so no real path carries one.
      if (octal[0] === "000") return null;
      bytes.push(parseInt(octal[0], 8));
      i += 3;
      continue;
    }
    const escaped = C_ESCAPES.get(next);
    if (escaped === undefined) return null;
    bytes.push(escaped);
    i += 1;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

// git appends a tab to a name containing a space, quoted or not.
function parseNewSidePath(header: string): string | null {
  const raw = header.endsWith("\t") ? header.slice(0, -1) : header;
  const path = raw.startsWith('"') ? unquoteCStylePath(raw) : raw;
  if (path === null || !path.startsWith("b/")) return null;
  return path.slice(2);
}

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/**
 * The `b/` side of every `+++` header, so deleted files (`+++ /dev/null`) are
 * left out. Hunk line counts are tracked so an added `++ b/x` or removed
 * `-- a/x` content line is never read as a header. A CRLF patch ends each line
 * with `\r`, which is not part of the name.
 */
export function parsePatchModifiedFiles(patch: string): string[] {
  const files: string[] = [];
  let oldLeft = 0;
  let newLeft = 0;
  let afterOldHeader = false;
  for (const rawLine of patch.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (oldLeft > 0 || newLeft > 0) {
      const marker = line[0];
      if (marker === "\\") continue;
      if (marker === "+") {
        newLeft--;
        continue;
      }
      if (marker === "-") {
        oldLeft--;
        continue;
      }
      // Some transports strip the trailing space of an empty context line.
      if (marker === " " || line === "") {
        oldLeft--;
        newLeft--;
        continue;
      }
      oldLeft = 0;
      newLeft = 0;
    }
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      oldLeft = Number(hunk[1] ?? 1);
      newLeft = Number(hunk[2] ?? 1);
      afterOldHeader = false;
      continue;
    }
    if (afterOldHeader && line.startsWith("+++ ")) {
      const path = parseNewSidePath(line.slice(4));
      if (path !== null) files.push(path);
    }
    afterOldHeader = line.startsWith("--- ");
  }
  return files;
}
