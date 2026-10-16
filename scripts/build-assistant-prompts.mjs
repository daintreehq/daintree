#!/usr/bin/env node
// Concatenates per-agent source partials in `scripts/assistant-src/` into the
// committed assistant prompt files in `assistant/`. Run after editing any
// partial; CI runs `--check` mode via `npm run check` to detect drift.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const SRC_DIR = path.join(root, "scripts/assistant-src");
const ASSISTANT_DIR = path.join(root, "assistant");

const SHARED_HEAD = path.join(SRC_DIR, "SHARED.head.md");
const SHARED_TASKS = path.join(SRC_DIR, "SHARED.tasks.md");
const SHARED = path.join(SRC_DIR, "SHARED.md");
const SHARED_TAIL = path.join(SRC_DIR, "SHARED.tail.md");
const TARGETS = [
  {
    out: path.join(ASSISTANT_DIR, "CLAUDE.md"),
    parts: [
      path.join(SRC_DIR, "CLAUDE.head.md"),
      SHARED_HEAD,
      SHARED_TASKS,
      SHARED,
      path.join(SRC_DIR, "CLAUDE.transcript.md"),
      SHARED_TAIL,
      path.join(SRC_DIR, "CLAUDE.tail.md"),
    ],
  },
  {
    out: path.join(ASSISTANT_DIR, "AGENTS.md"),
    parts: [
      path.join(SRC_DIR, "AGENTS.head.md"),
      SHARED_HEAD,
      SHARED_TASKS,
      SHARED,
      path.join(SRC_DIR, "AGENTS.transcript.md"),
      SHARED_TAIL,
    ],
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
          `::error file=${relative(out)}::missing generated file ${relative(out)} — run \`npm run build:assistant\``
        );
        failures++;
        continue;
      }
      if (actual !== expected) {
        console.error(
          `::error file=${relative(out)}::${relative(out)} is out of sync with sources in scripts/assistant-src/. ` +
            `Run \`npm run build:assistant\` and commit the result.`
        );
        failures++;
      }
    } else {
      writeFileSync(out, expected);
      console.log(`[build-assistant-prompts] wrote ${relative(out)}`);
    }
  }

  if (checkMode) {
    if (failures > 0) {
      console.error(
        `\nassistant-prompt drift detected: ${failures} file(s) out of sync. ` +
          `Edit sources in scripts/assistant-src/, then \`npm run build:assistant\` and commit.`
      );
      process.exit(1);
    }
    console.log("[build-assistant-prompts] OK — generated files match sources");
  }
}

main();
