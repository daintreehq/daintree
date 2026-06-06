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
//   Tier 1 — trigger:  `diff --git ...`, `From <sha> ...`, or `--- a/<file>`
//   Tier 2 — corroborate: a `+++ b/<file>` target header within a few lines
//                            (only required for the `--- a/<file>` opener;
//                            `diff --git` and `From <sha>` are unambiguous)
//   Tier 3 — commit:  at least one `@@` / `@@@` hunk header in the block
//
// A block is only emitted when all three tiers are satisfied. Bare `---` and
// `--- ` (no path) never reach Tier 1, which is what stops the false positives.

// Tier 1 trigger: `diff --git ...`, `diff -u ...`, `diff -Naur ...`,
// `diff --combined ...`, `diff (GNU patch) ...`, etc.
function isDiffStart(line: string): boolean {
  return line.startsWith("diff ");
}

// Tier 1 trigger: the `git format-patch` envelope header. Default `git
// format-patch` always uses a full 40-char SHA-1; SHA-256 (64 hex chars) is
// also accepted.
const FROM_ENVELOPE_REGEX = /^From [0-9a-f]{40,}\b/;
function isFromEnvelope(line: string): boolean {
  return FROM_ENVELOPE_REGEX.test(line);
}

// Tier 1 trigger (with corroboration): a `--- a/<file>` source header.
// Bare `---` (Markdown HR, YAML front-matter) does NOT match — it needs
// whitespace AND a non-whitespace token after the `--- `.
const UNIFIED_OPENER_REGEX = /^---\s+\S/;
function isUnifiedOpener(line: string): boolean {
  return UNIFIED_OPENER_REGEX.test(line);
}

// The `+++ b/<file>` target header that must corroborate a `--- a/<file>`
// opener. The path prefix is not enforced (`git diff --no-prefix` omits `b/`).
const TARGET_HEADER_REGEX = /^\+\+\+\s+\S/;
function isTargetHeader(line: string): boolean {
  return TARGET_HEADER_REGEX.test(line);
}

// Walk forward from a `--- a/<file>` opener and confirm a `+++ b/<file>`
// target header appears in the next few lines. Blank lines and additional
// `---` headers are skipped (combined diffs list one source header per
// parent before the target). Bounded to keep the scan cheap.
const TARGET_HEADER_LOOKAHEAD = 3;
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
// before so existing well-formed diffs still parse unchanged.
function isBlockBodyLine(line: string): boolean {
  return (
    line.startsWith("+++") ||
    line.startsWith("@@") ||
    line.startsWith("+") ||
    line.startsWith("-") ||
    line.startsWith(" ") ||
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
      if (isDiffStart(line) || isFromEnvelope(line)) {
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
      finalize();
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
