import type { File } from "gitdiff-parser";

// Basename exact matches for lockfiles — union of all three prior classifiers.
const LOCKFILE_BASENAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-lock.yml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
  "Pipfile.lock",
  "poetry.lock",
  "composer.lock",
  "mix.lock",
  "flake.lock",
  "deno.lock",
]);

// Suffixes matched case-insensitively via endsWith.
const GENERATED_SUFFIXES = [
  ".min.js",
  ".min.css",
  ".min.mjs",
  ".min.js.map",
  ".min.css.map",
  ".lockb",
  ".bundle.js",
  ".bundle.css",
  ".bundle.js.map",
  ".bundle.css.map",
  ".chunk.js",
  ".chunk.css",
  ".chunk.js.map",
  ".chunk.css.map",
  ".generated.js",
  ".generated.ts",
  ".generated.css",
  ".pb.go",
  ".pb.cc",
  ".pb.h",
  ".pb.ts",
  ".pb.d.ts",
  ".designer.cs",
  ".wasm",
  ".snap",
  ".lock",
].map((s) => s.toLowerCase());

// .gen.<ext> and .generated.<ext> patterns (case-insensitive).
const GENERATED_EXT_RE = /\.(?:gen\.\w+|generated\.\w+)$/i;

// Build-output and framework-generated directories (complete path segments).
const GENERATED_DIR_RE =
  /(?:^|\/)(?:dist|build|\.next|\.nuxt|\.svelte-kit|\.out|coverage|__generated__)\//;

// Content-header markers for auto-generated files — used only on newly-added
// files whose first hunk starts at line 1.
const GENERATED_HEADER_RE = /code generated.*do not edit|auto[-]?generated/i;
const SNIFF_MAX_LINES = 20;
const SNIFF_MAX_CHARS = 500;

export function isGeneratedFile(filePath: string): boolean {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const basename = segments[segments.length - 1];
  if (!basename) return false;

  if (LOCKFILE_BASENAMES.has(basename.toLowerCase())) return true;

  const lower = basename.toLowerCase();
  for (const suffix of GENERATED_SUFFIXES) {
    if (lower.endsWith(suffix)) return true;
  }

  if (GENERATED_EXT_RE.test(basename)) return true;
  if (GENERATED_DIR_RE.test(normalized)) return true;

  return false;
}

export function isGeneratedDiffFile(file: File): boolean {
  const path = getDiffFilePath(file);
  if (isGeneratedFile(path)) return true;

  // Content-based detection only for newly-added files where the header is
  // guaranteed to be in the diff hunks.
  if (file.type !== "add") return false;
  const firstHunk = file.hunks?.[0];
  if (!firstHunk || firstHunk.newStart !== 1) return false;

  let chars = 0;
  for (const change of firstHunk.changes) {
    if (change.type !== "insert") continue;
    // lineNumber exists on InsertChange and NormalChange.
    const line = (change as { lineNumber?: number }).lineNumber ?? 0;
    if (line > SNIFF_MAX_LINES) break;

    const content = change.content;
    chars += content.length;
    if (GENERATED_HEADER_RE.test(content)) return true;
    if (chars > SNIFF_MAX_CHARS) break;
  }

  return false;
}

function getDiffFilePath(file: File): string {
  if (file.newPath && file.newPath !== "/dev/null") return file.newPath;
  if (file.oldPath && file.oldPath !== "/dev/null") return file.oldPath;
  return "";
}
