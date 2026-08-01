#!/usr/bin/env tsx
// Verifies every `PROCESS_TOOL_REGISTRY` entry can actually render. The
// registry key doubles as the icon id and resolves through the renderer's
// `brands/*Icon.tsx` glob, which a Node script can reproduce with readdir —
// same directory, same filter, same lowercased-basename key derivation.
//
// Without this, a new tool with a typo'd key or a missing brand file ships
// silently: the tab falls back to the generic terminal glyph and renders the
// raw icon id as its label. #11612

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROCESS_TOOL_REGISTRY,
  type ProcessToolConfig,
} from "../../shared/config/processToolRegistry.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

const BRANDS_DIR = path.join(root, "src/components/icons/brands");
const BARREL_FILE = path.join(BRANDS_DIR, "index.ts");
const REGISTRY_FILE = path.join(root, "shared/config/processToolRegistry.ts");

const VALID_TIERS = new Set(["tool", "runtime", "package-manager"]);

let failures = 0;

function fail(file: string, message: string): void {
  console.error(`::error file=${file}::${message}`);
  failures++;
}

// `isFile()` because the Vite glob resolves modules: a directory or dangling
// symlink named `*Icon.tsx` would satisfy a name-only check but import as
// nothing.
const brandFiles = readdirSync(BRANDS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith("Icon.tsx"))
  .map((entry) => entry.name);

// Mirrors `src/config/agentIcons.ts`: key = filename minus `Icon.tsx`, lowercased.
const brandIconIds = new Map<string, string>();
for (const file of brandFiles) {
  const iconId = file.replace(/Icon\.tsx$/, "").toLowerCase();
  const existing = brandIconIds.get(iconId);
  if (existing !== undefined) {
    // Two files differing only by case collapse to one glob key, and which one
    // wins is filesystem-dependent.
    fail(
      path.join(BRANDS_DIR, file),
      `${file} and ${existing} both resolve to the id "${iconId}".`
    );
    continue;
  }
  brandIconIds.set(iconId, file);
}

const entries = Object.entries(PROCESS_TOOL_REGISTRY) as [string, ProcessToolConfig][];

// Fail closed: an empty registry means the import resolved to something
// unexpected, and every per-entry check below would vacuously pass.
if (entries.length === 0) {
  fail(REGISTRY_FILE, "PROCESS_TOOL_REGISTRY is empty — the registry failed to load.");
}

const seenCommands = new Map<string, string>();

for (const [iconId, config] of entries) {
  if (iconId !== iconId.toLowerCase()) {
    fail(REGISTRY_FILE, `"${iconId}" must be lowercase — the brand glob keys are lowercased.`);
  }

  if (typeof config.label !== "string" || config.label.trim() === "") {
    fail(REGISTRY_FILE, `"${iconId}" has no label — the tab would render the raw icon id.`);
  }

  if (!VALID_TIERS.has(config.tier)) {
    fail(REGISTRY_FILE, `"${iconId}" has an unknown tier "${config.tier}".`);
  }

  if (!Array.isArray(config.commands) || config.commands.length === 0) {
    fail(REGISTRY_FILE, `"${iconId}" declares no commands, so nothing can ever match it.`);
  }

  for (const command of config.commands ?? []) {
    if (typeof command !== "string" || command.trim() === "") {
      fail(REGISTRY_FILE, `"${iconId}" declares an empty command name.`);
      continue;
    }
    if (command !== command.toLowerCase()) {
      fail(REGISTRY_FILE, `"${iconId}" command "${command}" must be lowercase — lookups are too.`);
    }
    const owner = seenCommands.get(command);
    if (owner !== undefined) {
      fail(
        REGISTRY_FILE,
        `command "${command}" is claimed by both "${owner}" and "${iconId}" — ` +
          `the later entry silently wins at runtime.`
      );
      continue;
    }
    seenCommands.set(command, iconId);
  }

  if (!brandIconIds.has(iconId)) {
    fail(
      REGISTRY_FILE,
      `"${iconId}" has no brand mark. Add src/components/icons/brands/` +
        `${iconId.charAt(0).toUpperCase()}${iconId.slice(1)}Icon.tsx — without it the tab ` +
        `falls back to the generic terminal glyph.`
    );
  }
}

// The glob imports the DEFAULT export; the barrel is what named imports
// elsewhere reach. A file missing either drifts the two apart — and a missing
// default silently yields an undefined component rather than an error.
const barrel = readFileSync(BARREL_FILE, "utf8");
for (const [iconId, file] of brandIconIds) {
  const componentName = file.replace(/\.tsx$/, "");

  if (!/^export default \w+;?$/m.test(readFileSync(path.join(BRANDS_DIR, file), "utf8"))) {
    fail(
      path.join(BRANDS_DIR, file),
      `${componentName} has no default export. The brands glob imports defaults, so ` +
        `"${iconId}" would resolve to undefined and fall back to the terminal glyph.`
    );
  }

  if (!new RegExp(`\\bexport\\s*\\{[^}]*\\b${componentName}\\b[^}]*\\}`).test(barrel)) {
    fail(
      BARREL_FILE,
      `${componentName} (${iconId}) exists in brands/ but is not exported from the barrel.`
    );
  }
}

if (failures > 0) {
  console.error(`\nprocess tool registry: ${failures} issue(s). See ${REGISTRY_FILE}.`);
  process.exit(1);
}

console.log(
  `[check-process-tool-registry] OK — ${entries.length} tools, ` +
    `${seenCommands.size} commands, ${brandIconIds.size} brand marks`
);
