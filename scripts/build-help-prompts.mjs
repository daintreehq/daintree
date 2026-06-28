#!/usr/bin/env node
// Concatenates per-agent source partials in `scripts/help-src/` into the
// committed help-assistant prompt files in `help/`. Run after editing any
// partial; CI runs `--check` mode via `npm run check` to detect drift.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const SRC_DIR = path.join(root, "scripts/help-src");
const HELP_DIR = path.join(root, "help");

const SHARED = path.join(SRC_DIR, "SHARED.md");
const TARGETS = [
  {
    out: path.join(HELP_DIR, "CLAUDE.md"),
    parts: [
      path.join(SRC_DIR, "CLAUDE.head.md"),
      path.join(SRC_DIR, "CLAUDE.tasks.md"),
      path.join(SRC_DIR, "CLAUDE.tier.md"),
      SHARED,
      path.join(SRC_DIR, "CLAUDE.tail.md"),
    ],
  },
  {
    out: path.join(HELP_DIR, "AGENTS.md"),
    parts: [path.join(SRC_DIR, "AGENTS.head.md"), SHARED],
  },
];

function read(file) {
  return readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

function compose(parts) {
  const sections = parts.map((p) => read(p).replace(/\n+$/, ""));
  return sections.join("\n\n") + "\n";
}

function relative(file) {
  return path.relative(root, file);
}

function main() {
  const checkMode = process.argv.includes("--check");
  let failures = 0;

  for (const { out, parts } of TARGETS) {
    const expected = compose(parts);
    if (checkMode) {
      let actual;
      try {
        actual = read(out);
      } catch (err) {
        console.error(
          `::error file=${relative(out)}::missing generated file ${relative(out)} — run \`npm run build:help\``
        );
        failures++;
        continue;
      }
      if (actual !== expected) {
        console.error(
          `::error file=${relative(out)}::${relative(out)} is out of sync with sources in scripts/help-src/. ` +
            `Run \`npm run build:help\` and commit the result.`
        );
        failures++;
      }
    } else {
      writeFileSync(out, expected);
      console.log(`[build-help-prompts] wrote ${relative(out)}`);
    }
  }

  if (checkMode) {
    if (failures > 0) {
      console.error(
        `\nhelp-prompt drift detected: ${failures} file(s) out of sync. ` +
          `Edit sources in scripts/help-src/, then \`npm run build:help\` and commit.`
      );
      process.exit(1);
    }
    console.log("[build-help-prompts] OK — generated files match sources");
  }
}

main();
