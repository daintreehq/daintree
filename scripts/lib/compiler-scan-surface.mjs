// What the React Compiler budget considers "ours", kept free of heavy imports
// so `vite.config.ts` can hold the build to the same surface without pulling
// Babel and the compiler into config evaluation.
//
// One declaration, two consumers: `compiler-scan.mjs` scans exactly this set,
// and the build asserts every file the compiler touches is inside it. Without
// the second half, moving a renderer file to a root outside these patterns
// would retire its debt silently — the old path reads as deleted and the new
// path is simply never scanned.

import { minimatch } from "minimatch";

// `plugins/sample/**` is deliberately absent: the sample plugin builds through
// its own `vite.config.ts`, which never registers the compiler, so scanning it
// would budget files the compiler never sees. Plugin main-process code is out
// for the same reason — only `renderer/` is client code.
export const SCAN_PATTERNS = ["src/**/*.{ts,tsx}", "plugins/builtin/*/renderer/**/*.{ts,tsx}"];

// `*.spec.*` is listed alongside `*.test.*` even though the repo does not use
// it today: a naming convention arriving later should not quietly widen the
// budget.
export const SCAN_IGNORE = [
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.spec.ts",
  "**/*.spec.tsx",
  "**/__tests__/**",
  "**/*.d.ts",
  "**/node_modules/**",
];

/** Repo-relative POSIX path, whatever separator the caller arrived with. */
export function toPosixRelative(relPath) {
  return relPath.split("\\").join("/");
}

/** Whether a repo-relative path is inside the declared budget surface. */
export function isInScanSurface(relPath) {
  const rel = toPosixRelative(relPath);
  if (SCAN_IGNORE.some((pattern) => minimatch(rel, pattern))) return false;
  return SCAN_PATTERNS.some((pattern) => minimatch(rel, pattern));
}
