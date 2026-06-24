/**
 * Shared utility for parsing text to extract code blocks and patches.
 * Used by browser/worker artifact extraction.
 */

import { stripAnsiAndOscCodes } from "./urlUtils.js";

export interface CodeBlock {
  language: string;
  content: string;
}

export function extractCodeBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const regex = /```([^\n`]*)\n([\s\S]*?)```/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const languageHint = match[1]?.trim();
    const language = languageHint ? (languageHint.split(/\s+/)[0] ?? "text") : "text";
    const content = match[2]!.trim();
    if (content) {
      blocks.push({ language, content });
    }
  }

  return blocks;
}

// === Patch detection helpers ===
//
// `extractPatches` previously opened a block on any `---` line, which meant
// Markdown horizontal rules, YAML front-matter delimiters, and bulleted lists
// were emitted as patch artifacts and handed to `git apply` (which rejected
// them noisily). The helpers below form a three-tier classifier:
//
//   Tier 1 — trigger:  `diff --git ...` or `--- a/<file>`
//   Tier 2 — corroborate: a `+++ b/<file>` target header within a few lines
//                            (only required for the `--- a/<file>` opener;
//                            `diff --git` is unambiguous)
//   Tier 3 — commit:  at least one `@@` / `@@@` hunk header in the block
//
// A block is only emitted when all three tiers are satisfied. Bare `---` and
// `--- ` (no path) never reach Tier 1, which is what stops the false positives.

// Tier 1 trigger: `diff --git ...`, `diff -u ...`, `diff -Naur ...`,
// `diff --combined ...`, `diff (GNU patch) ...`, etc.
function isDiffStart(line: string): boolean {
  return line.startsWith("diff ");
}

// Tier 1 trigger (with corroboration): a `--- a/<file>` source header.
// Bare `---` (Markdown HR, YAML front-matter) does NOT match — it needs
// whitespace AND a non-whitespace token after the `--- `. `--- /dev/null`
// (new-file diff) and `---` followed by a custom path (e.g. `--- foo` from
// `git diff --no-prefix`) both pass.
const UNIFIED_OPENER_REGEX = /^---\s+\S/;
function isUnifiedOpener(line: string): boolean {
  return UNIFIED_OPENER_REGEX.test(line);
}

// The `+++ b/<file>` target header that must corroborate a `--- a/<file>`
// opener. The path prefix is not enforced (`git diff --no-prefix` omits `b/`,
// and `+++ /dev/null` marks a deleted file).
const TARGET_HEADER_REGEX = /^\+\+\+\s+\S/;
function isTargetHeader(line: string): boolean {
  return TARGET_HEADER_REGEX.test(line);
}

// Walk forward from a `--- a/<file>` opener and confirm a `+++ b/<file>`
// target header appears in the next few lines. Blank lines and additional
// `---` headers are skipped (combined diffs and octopus merges list one
// source header per parent before the target). Bounded to keep the scan
// cheap — 4 covers 3-parent octopus merges (`git merge-octopus`).
const TARGET_HEADER_LOOKAHEAD = 4;
function findTargetHeader(lines: string[], openerIndex: number): boolean {
  for (
    let j = openerIndex + 1;
    j < lines.length && j <= openerIndex + TARGET_HEADER_LOOKAHEAD;
    j++
  ) {
    const line = lines[j]!;
    if (line.trim() === "") continue;
    // Combined diffs have multiple `--- a/<parent>` headers before the
    // target; tolerate them.
    if (line.startsWith("---")) continue;
    return isTargetHeader(line);
  }
  return false;
}

// Real hunk header: `@@ -N +M @@` or combined `@@@ -A,B -C,D +E,F @@@`.
// Anchored at line start, requires whitespace and a `-<digits>` after the
// run of `@`s so prose like `@@user` and `@@@handle` are rejected.
const HUNK_HEADER_REGEX = /^@@@*\s+-\d+/;
function isHunkHeader(line: string): boolean {
  return HUNK_HEADER_REGEX.test(line);
}

function hasHunkHeader(patch: string[]): boolean {
  return patch.some(isHunkHeader);
}

// A line that is part of a diff body (in-block continuation). Same set as
// before so existing well-formed diffs still parse unchanged, with one
// addition: the `\` prefix is the `git diff` `\ No newline at end of file`
// marker, which `git apply` requires to avoid "corrupt patch" errors.
function isBlockBodyLine(line: string): boolean {
  return (
    line.startsWith("+++") ||
    line.startsWith("@@") ||
    line.startsWith("+") ||
    line.startsWith("-") ||
    line.startsWith(" ") ||
    line.startsWith("\\") ||
    line.trim() === ""
  );
}

export function extractPatches(text: string): string[] {
  const patches: string[] = [];
  const lines = text.split("\n");
  let currentPatch: string[] = [];
  let inPatch = false;

  // Commit the in-flight block if it looks like a real diff: long enough AND
  // contains at least one hunk header. The hunk check is the structural
  // guarantee that `git apply` will accept the block — anything without `@@`
  // is prose that happens to share prefixes with a diff.
  const finalize = () => {
    if (inPatch && currentPatch.length > 3 && hasHunkHeader(currentPatch)) {
      patches.push(currentPatch.join("\n"));
    }
    currentPatch = [];
    inPatch = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (!inPatch) {
      // Tier 1: unambiguous openers — no corroboration needed.
      if (isDiffStart(line)) {
        currentPatch = [line];
        inPatch = true;
      } else if (isUnifiedOpener(line) && findTargetHeader(lines, i)) {
        // Tier 1 + Tier 2: `--- a/<file>` needs a nearby `+++ b/<file>` to
        // be promoted to a diff header pair. This is what stops `--- a/x`
        // prose (Markdown HR with a path-shaped tail) from opening a block.
        currentPatch = [line];
        inPatch = true;
      }
      continue;
    }

    if (isBlockBodyLine(line)) {
      currentPatch.push(line);
    } else {
      // A non-body line ends the current block. Commit it, then re-process this
      // same line as a potential opener — back-to-back patches put the 2nd
      // block's `diff --git ...` header here, and skipping it would drop that
      // header (the body re-opens on the next `--- a/` line, masking the loss).
      finalize();
      i--;
    }
  }

  finalize();
  return patches;
}

export function extractPatchFilename(patch: string): string | undefined {
  const match = patch.match(/^\+\+\+ b\/(.+)$/m) || patch.match(/^---\s*a\/(.+)$/m);
  return match ? match[1] : undefined;
}

export function suggestFilename(language: string, content: string): string | undefined {
  const extensionMap: Record<string, string> = {
    typescript: ".ts",
    javascript: ".js",
    tsx: ".tsx",
    jsx: ".jsx",
    python: ".py",
    ruby: ".rb",
    rust: ".rs",
    go: ".go",
    java: ".java",
    cpp: ".cpp",
    c: ".c",
    html: ".html",
    css: ".css",
    json: ".json",
    yaml: ".yaml",
    yml: ".yml",
    markdown: ".md",
    sql: ".sql",
    bash: ".sh",
    shell: ".sh",
  };

  const extension = extensionMap[language.toLowerCase()];
  if (!extension) {
    return undefined;
  }

  let name = "code";

  const classMatch = content.match(/(?:export\s+)?(?:class|interface)\s+(\w+)/);
  if (classMatch) {
    name = classMatch[1]!;
  }

  const functionMatch = content.match(/(?:export\s+)?(?:function|const)\s+(\w+)/);
  if (functionMatch && !classMatch) {
    name = functionMatch[1]!;
  }

  const pythonMatch = content.match(/(?:class|def)\s+(\w+)/);
  if (pythonMatch && language === "python") {
    name = pythonMatch[1]!;
  }

  return name + extension;
}

export function stripAnsiCodes(text: string): string {
  return stripAnsiAndOscCodes(text);
}

// Trailing ASCII whitespace, including the `\r` left behind when CRLF-terminated
// serializer output is split on `\n`, and the cell-padding spaces xterm emits to
// the right of a line's last glyph. Leading whitespace (indentation, box drawing)
// is intentionally preserved.
const TRAILING_WHITESPACE_REGEX = /[ \t\r\f\v]+$/;

// 7-bit ESC and the 8-bit C1 introducers (CSI/OSC/DCS/SOS/PM/APC) that
// `stripAnsiCodes` knows how to remove. Used as a fast guard so we only pay the
// ANSI-stripping probe on lines that actually carry escape sequences.
// eslint-disable-next-line no-control-regex -- intentional control-char class, matches stripAnsiAndOscCodes
const CONTAINS_ESCAPE_REGEX = /[\x1b\x90\x98\x9b\x9d\x9e\x9f]/;

// A line is "blank" if nothing visible remains after right-trimming. The cheap
// path is the right-trim alone; only lines carrying escape bytes get the
// ANSI-stripping probe, so a styled/painted padding row (e.g. a themed TUI that
// fills its empty region with a background colour — `\x1b[48;5;235m  \x1b[0m\r`)
// is correctly recognised as blank even though raw right-trim leaves the SGR.
function isBlankCapturedLine(rightTrimmedLine: string): boolean {
  if (rightTrimmedLine.length === 0) return true;
  if (!CONTAINS_ESCAPE_REGEX.test(rightTrimmedLine)) return false;
  return stripAnsiCodes(rightTrimmedLine).replace(TRAILING_WHITESPACE_REGEX, "").length === 0;
}

/**
 * Normalize captured terminal/process output for return to a *reading* consumer
 * (the MCP terminal-read tools, finish-detection). This is NOT safe for the
 * restore/persistence path, where exact blank padding drives xterm cursor and
 * viewport reconstruction — apply it only at read/serialization boundaries that
 * hand text to a consumer for display or classification.
 *
 * Bottom-padding TUIs (notably the Codex CLI) render their composer high in the
 * viewport and pad the rest of the screen with blank rows, which the xterm
 * serializer emits as bare `\r\n` (or, for themed TUIs, SGR-only rows). A naive
 * "last N lines" tail then returns only that padding, stranding every consumer
 * that relies on the tail to detect completion (issue #10763). Normalizing
 * before tailing makes the last N lines the last N lines of *real* content:
 *
 * - Right-trims each line (drops trailing whitespace, the split `\r`, and
 *   cell-padding spaces), preserving leading indentation.
 * - Collapses any interior run of two or more blank lines down to a single blank
 *   line, so paragraph structure survives but agent-emitted gaps don't bloat.
 * - Drops leading and trailing blank runs entirely — pure padding with no
 *   separating purpose — so even a one-line tail lands on real content.
 *
 * Blank detection is ANSI-aware, so SGR-painted padding rows collapse too. Call
 * this BEFORE slicing the trailing N lines.
 */
export function normalizeCapturedOutput(text: string): string {
  const out: string[] = [];
  let prevBlank = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(TRAILING_WHITESPACE_REGEX, "");
    if (isBlankCapturedLine(line)) {
      // Collapse a run of 2+ blank lines to one; leading/trailing runs are
      // dropped wholesale by the trim pass below. Emit a clean "" so that pass
      // (and any consumer) sees a real blank, not residual SGR.
      if (prevBlank) continue;
      out.push("");
      prevBlank = true;
    } else {
      out.push(line);
      prevBlank = false;
    }
  }
  // Drop leading/trailing blank lines (at most one each after the collapse).
  if (out[0] === "") out.shift();
  if (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

/**
 * Normalize captured output (see `normalizeCapturedOutput`) and return its last
 * `maxLines` lines, optionally ANSI-stripped. Single source of truth for the MCP
 * terminal-read surfaces (`terminal.getOutput`, `terminal.getStatus`) so their
 * trim-then-tail behaviour cannot drift. `truncated`/`lineCount` are measured
 * against the *normalized* content, so trailing padding never makes a consumer
 * think real output was omitted.
 */
export function tailCapturedOutput(
  serialized: string,
  maxLines: number,
  stripAnsi: boolean
): { content: string; lineCount: number; truncated: boolean } {
  const normalized = normalizeCapturedOutput(serialized);
  // Normalized-empty means no real lines; report 0 rather than the phantom
  // single line `"".split("\n")` produces.
  if (normalized.length === 0) {
    return { content: "", lineCount: 0, truncated: false };
  }
  // Guard the exported contract: `slice(-0)` would return the whole buffer.
  const limit = Math.max(1, Math.floor(maxLines));
  const allLines = normalized.split("\n");
  const truncated = allLines.length > limit;
  const selected = allLines.slice(-limit);
  let content = selected.join("\n");
  if (stripAnsi) content = stripAnsiCodes(content);
  return { content, lineCount: selected.length, truncated };
}
