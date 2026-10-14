// ESLint options for scripts/lint-ratchet.mjs. Loaded with
// ESLint.fromOptionsModule because the `files` predicate is a function, which
// cannot be cloned into the worker threads `concurrency` starts; each worker
// imports this module instead. It must stay free of side effects for that reason.

import { dirname, join } from "path";
import { fileURLToPath } from "url";

// Test files still get linted (editor + raw `npm run lint`), but their warnings
// don't count toward the ratchet — test patterns like `as Foo` partial mocks
// aren't product debt. Errors are still counted for all files.
export const TEST_FILE_PATTERN = /[/\\](__tests__|e2e)[/\\]|\.(?:test|spec)\.[^.]+$/;

// Warn-level rules the ratchet turns off on test files, where it discards
// warnings anyway. They were over a third of the whole run there, react-compiler
// mostly. The ratchet fails if any of them is ever an error on a test file.
export const TEST_FILE_SKIPPED_RULES = [
  "react-compiler/react-compiler",
  "@typescript-eslint/no-floating-promises",
  "@typescript-eslint/no-unsafe-type-assertion",
];

// A `files` entry also decides which files get linted at all, so the test
// predicate is ANDed with the extensions eslint.config.js already lints. On its
// own it would pull every fixture in a test directory (.md, .json, .cast) in.
const LINTED_EXTENSIONS = "**/*.{js,mjs,cjs,jsx,ts,tsx,cts,mts}";

// ESLINT_CONCURRENCY is set by CI. Every worker thread builds its own typed
// program: two threads peaked at 11.5 GB locally, four at 15.5 GB.
function concurrency(value) {
  if (!value || value === "off" || value === "auto") return value || "off";
  return Number(value);
}

export default {
  cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
  concurrency: concurrency(process.env.ESLINT_CONCURRENCY),
  overrideConfig: {
    files: [[LINTED_EXTENSIONS, (filePath) => TEST_FILE_PATTERN.test(filePath)]],
    rules: Object.fromEntries(TEST_FILE_SKIPPED_RULES.map((ruleId) => [ruleId, "off"])),
  },
};
