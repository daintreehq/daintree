#!/usr/bin/env node
/**
 * Generates the plugin Tailwind vocabulary in `docs/plugins/views.md` and
 * `docs/plugins/agent-brief.md` from `src/styles/design-contract.css`.
 *
 * The docs used to tell plugin authors that Tailwind did not work, and stayed
 * wrong for as long as they did because nothing checked them. The vocabulary is
 * the part most likely to rot the same way — it is a list of token names that
 * changes whenever the design system does — so the values come from the contract
 * file rather than from someone's memory of it.
 *
 * What is NOT generated: which namespaces plugins may use. That is a design
 * decision (`--color-terminal-*` and `--color-syntax-*` are host internals, not
 * plugin API), so the list below is deliberately hand-maintained and adding to
 * it is a deliberate act.
 *
 *   node scripts/codegen/plugin-style-vocabulary.mjs           # write
 *   node scripts/codegen/plugin-style-vocabulary.mjs --check    # verify
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "../..");
const CONTRACT = path.join(root, "src/styles/design-contract.css");

const BEGIN = "<!-- BEGIN generated: plugin-style-vocabulary -->";
const END = "<!-- END generated: plugin-style-vocabulary -->";

const TARGETS = ["docs/plugins/views.md", "docs/plugins/agent-brief.md"];

/**
 * The families that are plugin API, in the order they appear in the docs.
 *
 * `prefix` is the custom-property namespace in the contract file; `utilities`
 * are the Tailwind prefixes the resulting suffix composes with.
 */
const FAMILIES = [
  {
    title: "Surfaces",
    prefix: "--color-surface-",
    keep: (name) => `surface-${name}`,
    utilities: ["bg-", "border-", "text-"],
  },
  {
    title: "Text",
    prefix: "--color-text-",
    keep: (name) => `text-${name}`,
    utilities: ["text-"],
  },
  {
    title: "Borders",
    prefix: "--color-border-",
    keep: (name) => `border-${name}`,
    utilities: ["border-", "divide-", "ring-"],
  },
  {
    title: "Status",
    prefix: "--color-status-",
    keep: (name) => `status-${name}`,
    utilities: ["bg-", "text-", "border-"],
  },
  {
    title: "Accent",
    prefix: "--color-accent-",
    keep: (name) => `accent-${name}`,
    utilities: ["bg-", "text-", "border-"],
  },
  {
    title: "Radii",
    prefix: "--radius-",
    keep: (name) => name,
    utilities: ["rounded-"],
  },
  {
    title: "Type scale below Tailwind's floor",
    prefix: "--text-",
    keep: (name) => name,
    utilities: ["text-"],
  },
  {
    title: "Durations",
    prefix: "--duration-",
    keep: (name) => name,
    utilities: ["duration-"],
  },
  {
    title: "Easings",
    prefix: "--ease-",
    keep: (name) => name,
    utilities: ["ease-"],
  },
];

/**
 * Tokens that exist in the contract but are not usable as a utility value.
 * `--color-accent-rgb` holds a bare `R, G, B` triple for composing
 * `rgb(… / alpha)`, so `bg-accent-rgb` would emit an invalid declaration.
 */
const EXCLUDED_TOKENS = new Set(["--color-accent-rgb"]);

/** Category hues are a cross product, so they are rendered as one. */
const CATEGORY_PREFIX = "--color-category-";

function readContract() {
  // Comments can contain token-shaped text; strip them so a documented example
  // never becomes a documented token.
  return readFileSync(CONTRACT, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Declared custom-property names, in declaration order, without duplicates. */
function declaredTokens(source) {
  const names = [];
  const seen = new Set();
  for (const match of source.matchAll(/^\s*(--[\w-]+)\s*:/gm)) {
    if (match[1].endsWith("-*") || seen.has(match[1]) || EXCLUDED_TOKENS.has(match[1])) continue;
    seen.add(match[1]);
    names.push(match[1]);
  }
  return names;
}

function customVariants(source) {
  return [...source.matchAll(/@custom-variant\s+([\w-]+)/g)].map((m) => m[1]);
}

function inlineList(values) {
  return values.map((value) => `\`${value}\``).join(" ");
}

function renderVocabulary() {
  const source = readContract();
  const tokens = declaredTokens(source);
  const lines = [];

  for (const family of FAMILIES) {
    const suffixes = tokens
      .filter((token) => token.startsWith(family.prefix))
      .map((token) => family.keep(token.slice(family.prefix.length)))
      // Category tokens share the `--color-` root but are rendered separately.
      .filter((name) => !name.startsWith("category-"));
    if (suffixes.length === 0) continue;
    lines.push(
      `**${family.title}** — ${family.utilities.map((u) => `\`${u}\``).join(", ")}`,
      "",
      inlineList(suffixes),
      ""
    );
  }

  const categories = tokens.filter((token) => token.startsWith(CATEGORY_PREFIX));
  if (categories.length > 0) {
    const hues = new Set();
    const variants = new Set();
    for (const token of categories) {
      const rest = token.slice(CATEGORY_PREFIX.length);
      const [hue, ...variant] = rest.split("-");
      hues.add(hue);
      variants.add(variant.length > 0 ? variant.join("-") : "");
    }
    const suffixes = [...variants].map((v) => (v === "" ? "(bare)" : `-${v}`));
    lines.push(
      "**Category hues** — `bg-`, `text-`, `border-`, as `category-<hue>` plus a variant suffix",
      "",
      `hues: ${inlineList([...hues])}`,
      "",
      `variants: ${inlineList(suffixes)}`,
      ""
    );
  }

  const variants = customVariants(source);
  if (variants.length > 0) {
    lines.push(
      "**Custom variants** — write as `variant:utility`",
      "",
      inlineList(variants.map((name) => `${name}:`)),
      ""
    );
  }

  return lines.join("\n").trimEnd();
}

function applyTo(relativePath, body) {
  const file = path.join(root, relativePath);
  const source = readFileSync(file, "utf-8");
  const begin = source.indexOf(BEGIN);
  const end = source.indexOf(END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(
      `${relativePath} is missing the generated-vocabulary markers. Add:\n${BEGIN}\n${END}`
    );
  }
  const next = `${source.slice(0, begin + BEGIN.length)}\n\n${body}\n\n${source.slice(end)}`;
  return { file, relativePath, source, next };
}

const check = process.argv.includes("--check");
const body = renderVocabulary();
let stale = false;

for (const relativePath of TARGETS) {
  const { file, source, next } = applyTo(relativePath, body);
  if (source === next) continue;
  if (check) {
    console.error(
      `[plugin-style-vocabulary] ${relativePath} is out of date. ` +
        `Run \`npm run codegen:plugin-style-vocabulary\`.`
    );
    stale = true;
  } else {
    writeFileSync(file, next, "utf-8");
    console.log(`[plugin-style-vocabulary] wrote ${relativePath}`);
  }
}

if (stale) process.exitCode = 1;
else if (check) console.log("[plugin-style-vocabulary] ok — docs match the design contract.");
