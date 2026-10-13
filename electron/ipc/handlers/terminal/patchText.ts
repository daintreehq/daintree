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

/**
 * The `b/` side of every `+++` header. git appends a tab to a path containing
 * a space, and a CRLF patch ends each line with `\r`; neither is part of the
 * name.
 */
export function parsePatchModifiedFiles(patch: string): string[] {
  const files: string[] = [];
  for (const line of patch.split("\n")) {
    const match = /^\+\+\+ b\/(.+?)\t?\r?$/.exec(line);
    if (match) files.push(match[1]!);
  }
  return files;
}
