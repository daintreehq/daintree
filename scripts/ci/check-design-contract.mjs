#!/usr/bin/env node
/**
 * Guards `src/styles/design-contract.css` — the token and variant vocabulary the
 * host and every plugin view share.
 *
 * The file is compiled twice from the same bytes: `src/index.css` imports it for
 * the host build, and the renderer's plugin Tailwind compiler receives it as text
 * (through `scripts/lib/plugin-style-contract.mjs`) to compile plugin classes. That second consumer is what makes
 * the contents a contract rather than a stylistic choice. Anything that is not a
 * token or a variant would either be silently dropped on the plugin side (the
 * compiler emits utilities only) or leak host chrome into every plugin root, so
 * the file is restricted to `@theme`, `@custom-variant`, `@utility` and comments.
 *
 * Also enforces that no custom property is declared twice. Tailwind resolves a
 * duplicate `--color-*` key to whichever declaration came last, with no warning
 * from any build step — a silent colour regression (#2687), and exactly the
 * failure mode an extraction like this invites.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "../..");
const CONTRACT = "src/styles/design-contract.css";
const INDEX = "src/index.css";

/** Top-level at-rules the contract file may declare. */
const ALLOWED_AT_RULES = new Set(["theme", "custom-variant", "utility"]);

let failed = false;
function fail(message) {
  console.error(`[check-design-contract] ${message}`);
  failed = true;
}

/**
 * Blank out comments and quoted strings, preserving length and newlines so both
 * line numbers and brace depth stay meaningful.
 *
 * Strings have to go too, not just comments. A brace inside a quoted value —
 * `--example: url("data:text/plain,{")` is legal CSS — would otherwise raise the
 * depth counter and never come back down, so every later top-level rule would
 * read as nested and slip past the structural check entirely. A quoted `}` fails
 * the other way, reporting rules that are not there.
 */
function blankNonStructural(source) {
  return source.replace(/\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (match) =>
    match.replace(/[^\n]/g, " ")
  );
}

/**
 * Every top-level construct, as `{ line, text }`. Brace depth is tracked so a
 * declaration nested inside `@theme { … }` is never mistaken for a top-level
 * rule — only what sits at depth 0 is a structural claim about the file.
 */
function topLevelConstructs(source) {
  const constructs = [];
  let depth = 0;
  let pending = "";
  let pendingLine = 0;

  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const char of line) {
      if (char === "{") {
        if (depth === 0) {
          constructs.push({ line: pendingLine || i + 1, text: pending.trim() });
          pending = "";
        }
        depth++;
      } else if (char === "}") {
        depth = Math.max(0, depth - 1);
        if (depth === 0) pending = "";
      } else if (depth === 0) {
        if (pending.trim() === "" && char.trim() !== "") pendingLine = i + 1;
        if (char === ";") {
          if (pending.trim()) constructs.push({ line: pendingLine, text: pending.trim() });
          pending = "";
        } else {
          pending += char;
        }
      }
    }
    if (depth === 0 && pending.trim()) pending += " ";
  }
  if (pending.trim()) constructs.push({ line: pendingLine, text: pending.trim() });
  return constructs;
}

const contractSource = readFileSync(path.join(root, CONTRACT), "utf-8");
const stripped = blankNonStructural(contractSource);

for (const { line, text } of topLevelConstructs(stripped)) {
  if (!text.startsWith("@")) {
    fail(
      `${CONTRACT}:${line} — bare selector \`${text}\` is not allowed. The contract file holds ` +
        `only tokens and variants; a raw selector belongs in ${INDEX}, because plugin views ` +
        `compile against this file and would never receive it.`
    );
    continue;
  }
  const name = /^@([\w-]+)/.exec(text)?.[1] ?? "";
  if (!ALLOWED_AT_RULES.has(name)) {
    fail(
      `${CONTRACT}:${line} — \`@${name}\` is not allowed. Permitted: ` +
        `${[...ALLOWED_AT_RULES].map((r) => `@${r}`).join(", ")}, and comments.`
    );
  }
}

// One declaration per token, across the whole file. A duplicate resolves to the
// later one silently (#2687), so a partial move that leaves a key behind — or a
// merge that reintroduces one — has to fail here rather than in a screenshot.
const seen = new Map();
for (const [, property, lineIndex] of (function* () {
  const lines = stripped.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*(--[\w-]+(?:-\*)?)\s*:/.exec(lines[i]);
    if (match) yield [null, match[1], i + 1];
  }
})()) {
  const previous = seen.get(property);
  if (previous !== undefined) {
    fail(
      `${CONTRACT}:${lineIndex} — \`${property}\` is already declared at line ${previous}. ` +
        `Tailwind keeps the last declaration silently; one token, one declaration.`
    );
  } else {
    seen.set(property, lineIndex);
  }
}

// The host must actually consume the contract, or the two compile paths diverge
// the moment someone edits it: plugins would follow the contract file and the
// host would not.
const indexSource = readFileSync(path.join(root, INDEX), "utf-8");
if (!indexSource.includes(`@import "./styles/design-contract.css"`)) {
  fail(`${INDEX} must \`@import "./styles/design-contract.css"\` — the host and the plugin
  compiler read the same bytes, and that import is what makes it the same bytes.`);
}

// A token or variant left behind in index.css is not shared with plugins, which
// is the drift this split exists to prevent.
const strippedIndex = blankNonStructural(indexSource);
for (const { line, text } of topLevelConstructs(strippedIndex)) {
  const name = /^@([\w-]+)/.exec(text)?.[1] ?? "";
  if (name === "theme" || name === "custom-variant") {
    fail(
      `${INDEX}:${line} — \`@${name}\` belongs in ${CONTRACT}. Tokens and variants declared ` +
        `here reach the host only; plugin views compile against the contract file.`
    );
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log(
    `[check-design-contract] ok — ${seen.size} tokens, ${CONTRACT} structurally clean and imported by ${INDEX}.`
  );
}
