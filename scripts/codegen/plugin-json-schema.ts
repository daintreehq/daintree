// Generates schemas/plugin.schema.json and schemas/plugin.project.schema.json
// from electron/schemas/plugin.ts — the Zod schema the loader actually runs.
// Run: npm run codegen:plugin-schema   Verify (CI): npm run check:plugin-schema
//
// Two files because the manifest schema is origin-keyed and the two origins
// genuinely disagree: a project plugin must declare `scope` and is refused
// seven contribution types an installed plugin may use. One merged file would
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
      'Manifest for a Daintree plugin committed into a project\'s .daintree/plugins/ directory. Such a plugin must declare "scope": "project", and seven contribution types available to installed plugins are refused here.',
  },
];

// What a structural schema cannot say. Zod's JSON Schema emitter drops
// `.refine()`/`.superRefine()` closures silently rather than failing, so every
// cross-field rule in the manifest schema is absent from the output. Stating
// that in the schema's own description is the only way a reader learns it —
// otherwise a manifest that validates here and is still refused at load looks
// like a host bug.
const UNENCODED_RULES = [
  'A panel view\'s id must equal the id of a declared panel. A location: "settings" view is the exception: at most one per plugin, with an id no panel uses; so is a location: "fileEditor" view, with an id no panel uses. A surface\'s viewId must name a declared panel view whose panel is not a PTY panel.',
  "A toolbar button declares exactly one of actionId or popover. A popover's viewId must name a declared panel view whose panel is not a PTY panel.",
  "A panel's menu may name only this plugin's own actions (written \"<plugin name>.<id>\", matching a declared command when the plugin declares commands), each at most once, and a hasPty panel may not have menu entries.",
  'A "project" database needs "scope": "project" and the "fs:project-write" capability; path applies only to a "project" database.',
  'A database query\'s sql must be one statement: for a "read" query, one SELECT, WITH or VALUES statement with no INSERT, UPDATE, DELETE or REPLACE; for a "write" query, one INSERT, REPLACE, UPDATE or DELETE statement, optionally after WITH. Its named placeholders must match its params exactly, and positional (?) placeholders are refused. Query names must be unique across all of a plugin\'s databases, may not be database_schema or database_query, and number at most 16 in all; with any tools the plugin registers, at most 16 together.',
  'A secret setting (type "secret" or secret: true) may not declare a default, since it would ship in plugin.json.',
  'Under project scope, menuItems, agents, processTools, mcpServers, themes, forgeProviders and projectTemplates are refused, and "scope": "project" is required.',
  'A fileEditors entry names exactly one of slot or view. A slot is accepted only for built-in plugins and takes no mode or paths; a view must name one of the plugin\'s location: "fileEditor" views and needs a mode. Every entry declares extensions, paths or both, and paths are accepted only under "scope": "project". default is accepted only under "scope": "project", on a view-backed "mode": "edit" entry with paths, and a pattern may be the default for one entry of a plugin.',
  'A contextMenus entry may declare kind, extensions or paths only at location "file", and extensions may not be combined with kind "folder". Paths are globs relative to the worktree root.',
  'A terminalLinks entry sets exactly one of pattern or url, and its actionId must be one of this plugin\'s own actions (written "<plugin name>.<id>", matching a declared command when the plugin declares commands). A pattern must compile as a JavaScript regular expression with the u flag, match no empty text, have at most 16 capture groups, and use no backreference, lookaround or named group; a repeated group may not itself repeat or alternate, and the product of every quantifier\'s maximum (512 for an unbounded one) and every alternation\'s branch count may not exceed 1,000,000. ignoreCase applies only to a pattern. A url host must be a lowercase public domain with at least two labels: no IP address, port, path or wildcard, and nothing loopback, private or local-only. A pathPrefix starts with "/" and has no query, fragment or dot segments.',
  "The reserved daintree.* publisher namespace is accepted only for built-in plugins.",
  "previewTools and guestAdapters are accepted only for built-in plugins, each id must be namespaced under the plugin's own name, and a preview tool's guestAdapter must name an adapter the same manifest declares.",
  "A command id may not collide with a built-in action id, and some built-in ids refuse plugin dispatch outright.",
  "An agent's session-id resume must use {sessionId} exactly once across its args, and nowhere else; a project-scoped resume's args may not contain it. A sessionIdPattern must compile as a JavaScript regular expression with exactly one capture group.",
  "assistantKnowledge needs contributes.agentMcp or contributes.databases, must declare instructions, skills or references, and its skill and reference ids must each be unique.",
  "A tour's panelKind must name a declared panel; its chapter ids must be unique; every cue and caption must fall inside its chapter's duration; and a remote chapter audioUrl must be https on a host listed in that tour's audioHosts.",
  "A command's resultSchema must compile as JSON Schema 2020-12 (or draft-07, when its $schema says so) with every reference resolving inside it and no $async; the command is refused when it registers otherwise.",
  "worksWith may not repeat an entry or name the plugin itself.",
  'application needs "scope": "project" and engines.daintree. Its destination "home" needs contributes.surfaces.projectHome; sidebarViewId and settingsViewId must name declared views at location "sidebar" and "settings"; welcomeTour.id a declared tour with no panelKind; firstWorkflow a declared command of kind "command"; each requiredTools entry a declared agentMcp id; and presentation only features and levels the host offers.',
  'An eventRoutes entry routes each event at most once, and its command must be the id of a contributes.commands entry that is not danger "confirm". Routing "agentWaiting" requires the "agent:read" capability.',
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
