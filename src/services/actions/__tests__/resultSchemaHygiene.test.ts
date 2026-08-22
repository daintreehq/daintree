import { describe, it, expect } from "vitest";
import { z } from "zod";

/**
 * `ActionService.dispatch` parses every result through its action's
 * `resultSchema` (#11539). Zod strips unknown keys, so that parse is what keeps
 * the delivered payload equal to the published projection — but only for nodes
 * the schema actually constrains. `z.unknown()`, `z.any()`, `.catchall()`, and
 * `z.record(k, z.unknown())` opt their subtree out of stripping entirely, which
 * silently returns that part of the result to pre-#11539 behavior: whatever
 * `run()` built ships, including fields nobody declared.
 *
 * This test walks the JSON Schema each `resultSchema` publishes and fails on any
 * node that would let an arbitrary value through unexamined. The JSON Schema is
 * the right representation to walk — it is what MCP clients are actually handed,
 * and unlike zod's `_zod.def` internals it is stable across minor zod releases.
 *
 * Findings are matched against {@link PERMISSIVE_ALLOWLIST} by exact JSON
 * pointer. Deliberately not per-action: muting a whole action would also mute
 * the next permissive node someone adds to it. An allowlist entry that stops
 * matching fails too, so entries cannot outlive the schema they excuse.
 */

/**
 * Keywords that actually narrow the set of accepted values. Deliberately an
 * allowlist rather than a list of annotations to ignore: an unknown keyword is
 * far more likely to be another annotation than a new constraint, and the
 * denylist form silently passed a root `z.unknown()` because zod stamps
 * `$schema` on the root node.
 */
const CONSTRAINING_KEYWORDS = new Set([
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "unevaluatedProperties",
  "patternProperties",
  "propertyNames",
  "minProperties",
  "maxProperties",
  "dependentRequired",
  "dependentSchemas",
  "items",
  "prefixItems",
  "unevaluatedItems",
  "contains",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "$ref",
  "$dynamicRef",
  // `contentSchema` narrows decoded content; `contentEncoding`/`contentMediaType`
  // are annotations that restrict nothing on their own, so they stay out.
  "contentSchema",
]);

/** A node that accepts any value: `true`, or a schema with no constraints. */
function isPermissive(node: unknown): boolean {
  if (node === true) return true;
  if (node === null || typeof node !== "object" || Array.isArray(node)) return false;
  return !Object.keys(node as Record<string, unknown>).some((k) => CONSTRAINING_KEYWORDS.has(k));
}

type Finding = { actionId: string; pointer: string };

/** RFC 6901 pointer escaping so a key containing `/` or `~` stays unambiguous. */
function escapeToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Keywords whose value IS a schema. */
const SCHEMA_VALUED = [
  "additionalProperties",
  "unevaluatedProperties",
  "items",
  "unevaluatedItems",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
] as const;

/** Keywords whose value is an ARRAY of schemas. */
const SCHEMA_ARRAY_VALUED = ["anyOf", "oneOf", "allOf", "prefixItems"] as const;

/** Keywords whose value is a MAP of name to schema. */
const SCHEMA_MAP_VALUED = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
] as const;

/**
 * Recurse only through positions that actually hold schemas. A blanket walk
 * descends into keyword *data* — `const: true` and `enum: [...]` are values, not
 * subschemas, and reading them as schemas reports a `z.literal(true)` as an
 * unconstrained node.
 */
function walk(
  node: unknown,
  actionId: string,
  pointer: string,
  out: Finding[],
  seen: WeakSet<object>
): void {
  if (node === true) {
    out.push({ actionId, pointer });
    return;
  }
  // `false` accepts nothing — the opposite of permissive.
  if (node === false || node === null || typeof node !== "object" || Array.isArray(node)) return;
  if (seen.has(node)) return;
  seen.add(node);

  if (isPermissive(node)) {
    out.push({ actionId, pointer });
    // Nothing below an unconstrained schema to inspect.
    return;
  }
  // `$ref` targets are walked once at their `$defs` site; following the ref
  // would report the same node under two pointers.
  if ("$ref" in node) return;

  const record = node as Record<string, unknown>;

  for (const key of SCHEMA_VALUED) {
    if (key in record) walk(record[key], actionId, `${pointer}/${key}`, out, seen);
  }
  for (const key of SCHEMA_ARRAY_VALUED) {
    const arr = record[key];
    if (!Array.isArray(arr)) continue;
    arr.forEach((sub, i) => walk(sub, actionId, `${pointer}/${key}/${i}`, out, seen));
  }
  for (const key of SCHEMA_MAP_VALUED) {
    const map = record[key];
    if (map === null || typeof map !== "object" || Array.isArray(map)) continue;
    for (const [name, sub] of Object.entries(map as Record<string, unknown>)) {
      walk(sub, actionId, `${pointer}/${key}/${escapeToken(name)}`, out, seen);
    }
  }
}

/**
 * Nodes that stay permissive, with the reason each one is not simply unwritten.
 * This doubles as the standing inventory of what #11539's enforcement does NOT
 * reach: anything listed here still ships whatever `run()` built for that
 * subtree. Entries fall into three kinds —
 *
 *   "open by nature"  — the value genuinely has no fixed shape (user config
 *                       blobs, provider metadata, captured console arguments).
 *   "self-describing" — the payload IS schema/manifest data, so constraining it
 *                       would mean maintaining a schema of schemas.
 *   "deferred"        — a real shape exists and should be written; narrowing it
 *                       is a published-contract change, not part of turning
 *                       enforcement on. These are the follow-up work.
 */
const PERMISSIVE_ALLOWLIST: ReadonlyArray<{ actionId: string; pointer: string; reason: string }> = [
  // --- self-describing -----------------------------------------------------
  {
    actionId: "actions.getSchema",
    pointer: "/properties/entry/anyOf/0/additionalProperties",
    reason: "self-describing: an action manifest entry, whose own field is a JSON Schema",
  },
  {
    actionId: "actions.list",
    pointer: "/properties/actions/items",
    reason: "self-describing: action manifest entries carrying arbitrary input/output schemas",
  },
  {
    actionId: "actions.search",
    pointer: "/properties/results/items",
    reason: "self-describing: same manifest entries as actions.list",
  },

  // --- open by nature ------------------------------------------------------
  {
    actionId: "agentSettings.get",
    pointer: "/properties/agents/additionalProperties/additionalProperties",
    reason: "open by nature: per-agent user settings, keyed and shaped by each agent's own config",
  },
  {
    actionId: "browser.getConsoleMessages",
    pointer: "/properties/messages/items/properties/args/items",
    reason: "open by nature: console.log arguments are arbitrary page-supplied JS values",
  },
  {
    actionId: "browser.getConsoleMessages",
    pointer: "/properties/messages/items/properties/stackTrace",
    reason: "open by nature: CDP stack trace object, shaped by the protocol not by us",
  },
  {
    actionId: "project.getSettings",
    pointer: "/properties/copyTreeSettings/additionalProperties",
    reason: "open by nature: user-authored CopyTree config blob",
  },
  {
    actionId: "project.getSettings",
    pointer: "/properties/notificationOverrides/additionalProperties",
    reason: "open by nature: per-event-kind overrides keyed by a runtime-extensible enum",
  },
  {
    actionId: "worktree.resource.config.get",
    pointer: "/additionalProperties",
    reason: "open by nature: resource config is defined by each resource provider",
  },
  {
    actionId: "worktree.resource.status",
    pointer: "/properties/status/anyOf/0/properties/meta/additionalProperties",
    reason: "open by nature: provider-supplied status metadata",
  },

  // --- deliberate escape, documented at the definition ---------------------
  {
    actionId: "forge.listIssues",
    pointer: "/properties/items/items/anyOf/1",
    reason:
      "deliberate: the view:'full' arm in forgeListProjection.ts — the provider's own normalized object, and load-bearing for run()'s return type inference",
  },
  {
    actionId: "forge.listPRs",
    pointer: "/properties/items/items/anyOf/1",
    reason: "deliberate: same view:'full' arm as forge.listIssues",
  },

  // --- deferred: a real shape exists, narrowing it changes a published contract
  {
    actionId: "copyTree.getFileTree",
    pointer: "/properties/nodes/items",
    reason: "deferred: recursive file-tree node has a real but self-referential shape",
  },
  {
    actionId: "errors.recent",
    pointer: "/properties/errors/items",
    reason: "deferred: errorStore entry; diagnostics payload, no secrets",
  },
  {
    actionId: "eventInspector.getEvents",
    pointer: "/properties/items/items",
    reason: "deferred: captured event record; diagnostics payload",
  },
  {
    actionId: "eventInspector.getFiltered",
    pointer: "/properties/events/items",
    reason: "deferred: same event record as eventInspector.getEvents",
  },
  {
    actionId: "logs.getAll",
    pointer: "/properties/entries/items",
    reason: "deferred: log entry record; diagnostics payload",
  },
  {
    actionId: "notifications.recent",
    pointer: "/properties/notifications/items",
    reason: "deferred: notification record; diagnostics payload",
  },
  {
    actionId: "panel.list",
    pointer: "/properties/panels/items/properties/type/anyOf/0",
    reason:
      "deferred: legacy field that run() hard-codes to undefined — the honest fix is removing it from the published shape, which is a contract change",
  },
  {
    actionId: "terminal.list",
    pointer: "/properties/terminals/items/properties/type/anyOf/0",
    reason: "deferred: same always-undefined legacy field as panel.list",
  },
  {
    actionId: "project.detectRunners",
    pointer: "/properties/runners/items",
    reason: "deferred: runner descriptor has a documented { id, name, command } shape",
  },
  {
    actionId: "project.getAll",
    pointer: "/properties/projects/items",
    reason: "deferred: project record has a real shape; narrowing it needs a persisted-data audit",
  },
  {
    actionId: "project.getCurrent",
    pointer: "/properties/project/anyOf/0",
    reason: "deferred: same project record as project.getAll",
  },
];

function createCallbacks() {
  return {
    onOpenSettings: () => {},
    onOpenSettingsTab: () => {},
    onToggleSidebar: () => {},
    onToggleFocusMode: () => {},
    onFocusRegionNext: () => {},
    onFocusRegionPrev: () => {},
    onOpenActionPalette: () => {},
    onOpenQuickSwitcher: () => {},
    onOpenWorktreePalette: () => {},
    onOpenQuickCreatePalette: () => {},
    onToggleWorktreeOverview: () => {},
    onOpenWorktreeOverview: () => {},
    onCloseWorktreeOverview: () => {},
    onOpenPanelPalette: () => {},
    onOpenResumeSessionsPalette: () => {},
    onOpenProjectSwitcherPalette: () => {},
    onConfirmCloseActiveProject: () => {},
    onOpenShortcuts: () => {},
    onLaunchAgent: async () => null,
    onInject: () => {},
    onAddTerminal: async () => {},
    getDefaultCwd: () => "/",
    getActiveWorktreeId: () => undefined,
    getWorktrees: () => [],
    getFocusedId: () => null,
    getIsSettingsOpen: () => false,
    getGridNavigation: () => ({
      findNearest: () => null,
      findByIndex: () => null,
      findDockByIndex: () => null,
      getCurrentLocation: () => null,
    }),
  };
}

async function collectFindings(): Promise<Finding[]> {
  (globalThis as unknown as { self: unknown }).self = globalThis;
  const { createActionDefinitions } = await import("../actionDefinitions");
  const built = createActionDefinitions(createCallbacks());

  const findings: Finding[] = [];
  for (const [actionId, factory] of built) {
    const definition = factory();
    const schema = definition.resultSchema;
    if (!schema) continue;
    let json: unknown;
    try {
      json = z.toJSONSchema(schema, {
        io: "output",
        unrepresentable: "any",
        reused: "inline",
        cycles: "ref",
        target: "draft-2020-12",
      });
    } catch {
      // Fails closed. A schema that cannot be rendered still governs dispatch's
      // parse, so skipping it would hide a permissive node rather than clear
      // it — and "we could not inspect this" is itself worth failing on.
      findings.push({ actionId: actionId as string, pointer: "<unconvertible>" });
      continue;
    }
    walk(json, actionId as string, "", findings, new WeakSet());
  }
  return findings;
}

describe("resultSchema hygiene", () => {
  it("no resultSchema opts a node out of stripping without an allowlisted reason", async () => {
    const findings = await collectFindings();
    const allowed = new Set(PERMISSIVE_ALLOWLIST.map((e) => `${e.actionId}${e.pointer}`));

    const unexpected = findings
      .filter((f) => !allowed.has(`${f.actionId}${f.pointer}`))
      .map((f) => `${f.actionId} at ${f.pointer || "<root>"}`)
      .sort();

    expect(unexpected).toEqual([]);
  });

  it("every allowlist entry still matches a real permissive node", async () => {
    const findings = await collectFindings();
    const found = new Set(findings.map((f) => `${f.actionId}${f.pointer}`));

    const stale = PERMISSIVE_ALLOWLIST.filter((e) => !found.has(`${e.actionId}${e.pointer}`)).map(
      (e) => `${e.actionId} at ${e.pointer || "<root>"}`
    );

    expect(stale).toEqual([]);
  });
});
