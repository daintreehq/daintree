// Generates schemas/plugin.schema.json and schemas/plugin.project.schema.json
// from electron/schemas/plugin.ts — the Zod schema the loader actually runs.
// Run: npm run codegen:plugin-schema   Verify (CI): npm run check:plugin-schema
//
// Two files because the manifest schema is origin-keyed and the two origins
// genuinely disagree: a project plugin must declare `scope` and is refused
// eight contribution types an installed plugin may use. One merged file would
// have to accept the union, which is the one thing neither origin does.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import { getPluginManifestSchema } from "../../electron/schemas/plugin.js";
import type { PluginOrigin } from "../../shared/types/plugin.js";

const SCHEMA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../schemas");

const RAW_BASE_URL = "https://raw.githubusercontent.com/daintreehq/daintree/develop/schemas";

interface Target {
  file: string;
  origin: PluginOrigin;
  title: string;
  intro: string;
}

const TARGETS: Target[] = [
  {
    file: "plugin.schema.json",
    origin: "user",
    title: "Daintree plugin manifest",
    intro:
      "Manifest for a Daintree plugin installed into the user's own plugins directory. A plugin committed into a project's .daintree/plugins/ is held to different rules — use plugin.project.schema.json for those.",
  },
  {
    file: "plugin.project.schema.json",
    origin: "project",
    title: "Daintree project plugin manifest",
    intro:
      'Manifest for a Daintree plugin committed into a project\'s .daintree/plugins/ directory. Such a plugin must declare "scope": "project", and eight contribution types available to installed plugins are refused here.',
  },
];

// What a structural schema cannot say. Zod's JSON Schema emitter drops
// `.refine()`/`.superRefine()` closures silently rather than failing, so every
// cross-field rule in the manifest schema is absent from the output. Stating
// that in the schema's own description is the only way a reader learns it —
// otherwise a manifest that validates here and is still refused at load looks
// like a host bug.
const UNENCODED_RULES = [
  "A view's id must equal the id of a declared panel, and a surface's viewId must name a declared view whose panel is not a PTY panel.",
  'Under project scope, menuItems, agents, skills, recipes, fileDecorationProviders, processTools, mcpServers and forgeProviders are refused, and "scope": "project" is required.',
  "The reserved daintree.* publisher namespace is accepted only for built-in plugins.",
  "A command id may not collide with a built-in action id, and some built-in ids refuse plugin dispatch outright.",
];

function build({ file, origin, title, intro }: Target): string {
  const emitted = z.toJSONSchema(getPluginManifestSchema(origin), {
    target: "draft-2020-12",
    io: "input",
    // A node with no JSON Schema mapping must fail the build rather than be
    // quietly widened to `true` — a schema that silently accepts anything at
    // one branch is worse than no schema on that branch.
    unrepresentable: "throw",
  }) as Record<string, unknown>;

  const { $schema, ...body } = emitted;
  const document = {
    $schema: $schema ?? "https://json-schema.org/draft/2020-12/schema",
    $id: `${RAW_BASE_URL}/${file}`,
    title,
    description: [
      intro,
      "",
      "Generated from Daintree's own manifest schema — do not edit by hand.",
      "",
      "Structural rules only. These cross-field rules are enforced when the plugin loads and cannot be expressed here:",
      ...UNENCODED_RULES.map((rule) => `- ${rule}`),
    ].join("\n"),
    ...body,
  };

  return JSON.stringify(document, null, 2) + "\n";
}

const isCheck = process.argv.includes("--check");
let stale = false;

for (const target of TARGETS) {
  const expected = build(target);
  const filePath = path.join(SCHEMA_DIR, target.file);
  if (isCheck) {
    let actual = "";
    try {
      actual = readFileSync(filePath, "utf-8");
    } catch {
      // Missing file fails the comparison below.
    }
    if (actual !== expected) {
      console.error(`schemas/${target.file} is stale.`);
      stale = true;
    }
  } else {
    writeFileSync(filePath, expected);
    console.log(`Wrote schemas/${target.file}`);
  }
}

if (isCheck) {
  if (stale) {
    console.error("Run `npm run codegen:plugin-schema` and commit the result.");
    process.exit(1);
  }
  console.log("Plugin manifest JSON Schemas are up to date.");
}
