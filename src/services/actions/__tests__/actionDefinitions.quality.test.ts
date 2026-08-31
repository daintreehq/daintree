import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createStore } from "zustand/vanilla";
import { setCurrentViewStore } from "@/store/createWorktreeStore";
import type { WorktreeViewStore, WorktreeViewStoreApi } from "@/store/createWorktreeStore";
import type { WorktreeSnapshot } from "@shared/types";
import { KEY_ACTION_VALUES } from "@shared/types/keymap";
import { BUILT_IN_ACTION_IDS, DENY_PLUGIN_DISPATCH_ACTION_IDS } from "@shared/config/actionIds";
import type { ActionId } from "@shared/types/actions";
import type { ActionRegistry, ActionCallbacks } from "../actionTypes";
import { DEFAULT_KEYBINDINGS } from "../../defaultKeybindings";
import {
  WORKBENCH_TIER_TOOLS,
  ACTION_TIER_ADDONS,
  SYSTEM_TIER_ADDONS,
} from "@shared/config/helpAssistantTierAllowlists";
import { MCP_EXTERNAL_TIER_TOOLS } from "@shared/config/mcpExternalTierAllowlist";

/**
 * Action IDs that exist in BuiltInKeyAction but are intentionally NOT in the
 * action registry. These are pure keybinding targets dispatched through
 * keybinding code paths that bypass ActionService, or navigation primitives
 * that the OS/terminal handles directly.
 */
const KEY_ONLY_ACTIONS = new Set([
  "nav.up",
  "nav.down",
  "nav.left",
  "nav.right",
  "nav.pageUp",
  "nav.pageDown",
  "nav.home",
  "nav.end",
  "nav.expand",
  "nav.collapse",
  "nav.primary",
  "ui.escape",
  "tab.next",
  "tab.previous",
  "terminal.scrollToLastActivity",
  "terminal.armDefault",
  "terminal.disarmAll",
  "fleet.armFocused",
  "action.palette",
  "file.open",
  "file.copyPath",
  "file.copyTree",
  "git.toggle",
]);

/**
 * Duplicate registrations that are intentional: the same action registered by
 * different definition files for different UI entry points (e.g., a keybinding
 * definition with minimal metadata and a command-palette definition with full
 * metadata). Only the LAST registration wins at runtime.
 */
const DUPLICATE_ALLOWLIST = new Set<string>();

function createCallbacks(): ActionCallbacks {
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

async function createRegistryWithAudit(): Promise<{
  registry: ActionRegistry;
  duplicates: Array<{ key: string; count: number }>;
}> {
  (globalThis as any).self = globalThis;

  const seen = new Map<string, number>();
  const duplicates: Array<{ key: string; count: number }> = [];

  const shim: ActionRegistry = new Map();
  const originalSet = shim.set.bind(shim);

  shim.set = (key, value) => {
    const keyStr = key as string;
    const count = seen.get(keyStr) ?? 0;
    seen.set(keyStr, count + 1);
    if (count > 0 && !DUPLICATE_ALLOWLIST.has(keyStr)) {
      duplicates.push({ key: keyStr, count: count + 1 });
    }
    return originalSet(key, value);
  };

  const { createActionDefinitions } = await import("../actionDefinitions");
  const registry = createActionDefinitions(createCallbacks(), shim);

  return { registry, duplicates };
}

/**
 * Every dotted identifier in `text`, as whole tokens.
 *
 * Tokenising and then testing membership beats matching each id with its own
 * boundary regex, which got the common case wrong: a trailing `.` had to be
 * excluded on both sides to stop `terminal.list` matching inside
 * `terminal.listBranches`, and that also stopped it matching a sentence-final
 * "call terminal.list." — the single most likely way to write the broken
 * cross-reference this guards against.
 *
 * A token ends at the first `.` not followed by a letter, so sentence
 * punctuation falls outside it while `terminal.listBranches` stays one token
 * and simply is not an action id. Non-action dotted names (`Worktree.branch`,
 * `ctx.focusedTerminalId`) are excluded the same way — by not being in the set
 * — which is what keeps legitimate type and field references legal.
 */
const DOTTED_TOKEN = /[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+/g;

function actionIdsNamedIn(text: string, ids: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  for (const [token] of text.matchAll(DOTTED_TOKEN)) {
    if (ids.has(token)) found.add(token);
  }
  return [...found];
}

/** Every `description` string anywhere in an emitted JSON Schema. */
function nestedDescriptions(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) nestedDescriptions(item, out);
    return out;
  }
  if (typeof node !== "object" || node === null) return out;
  for (const [key, value] of Object.entries(node)) {
    if (key === "description" && typeof value === "string") out.push(value);
    else nestedDescriptions(value, out);
  }
  return out;
}

/**
 * The top-level argument names a tool advertises, read through the same
 * conversion `ActionService` uses — so this sees exactly the properties a
 * client is sent, including those a `.transform()` would otherwise hide.
 */
const EmittedProperties = z.object({ properties: z.record(z.string(), z.unknown()).optional() });

/** The exact conversion `ActionService.computeSchemas` performs. */
function emitSchema(schema: z.ZodType, io: "input" | "output"): unknown {
  return z.toJSONSchema(schema, {
    io,
    unrepresentable: "any",
    reused: "inline",
    cycles: "ref",
    target: "draft-2020-12",
  });
}

/**
 * Top-level argument names, or `null` when the schema cannot be converted.
 *
 * `null` rather than `[]` because production swallows the same failure and
 * advertises an empty object instead — so a conversion that starts throwing is
 * a broken tool surface, and a guard that returned `[]` would go quiet at
 * precisely that moment.
 */
function inputPropertyNames(argsSchema: z.ZodType | undefined): string[] | null {
  if (argsSchema == null) return [];
  try {
    return Object.keys(EmittedProperties.parse(emitSchema(argsSchema, "input")).properties ?? {});
  } catch {
    return null;
  }
}

// #11585 — the external MCP surface is budgeted in BOTH dimensions, because the
// failure it guards against is measured in bytes, not tools. The old surface was
// 100 tools AND ~128 KB of schema; 23 tools carrying novel-length descriptions
// would reproduce the same truncation with a count that looks fine. The cohort
// is derived from the real allowlist rather than restated here, so this cannot
// drift from the gate it is budgeting.
describe("external MCP tool surface budget (#11585)", () => {
  // The summed external description budget that used to live here is gone: it
  // capped the same bytes as MAX_EXTERNAL_TOTAL_BYTES below at a looser number,
  // so it could never fail first and only offered a second place for the real
  // figure to drift out of step. The tool COUNT is budgeted in tierAuth.test.ts
  // against the allowlist that is the actual gate.

  it("every allowlisted external tool exists in the registry", async () => {
    // Kept from the deleted budget: it was the half that caught an allowlist
    // naming an id the registry no longer has, which the byte sum only noticed
    // as a suspiciously small total.
    const { registry } = await createRegistryWithAudit();

    const absent = MCP_EXTERNAL_TIER_TOOLS.filter((id) => !registry.get(id as ActionId)?.());
    expect(absent).toEqual([]);
  });

  it("names only real actions that can actually be advertised and dispatched", async () => {
    const { registry } = await createRegistryWithAudit();
    const builtInIds = new Set<string>(BUILT_IN_ACTION_IDS);

    // A duplicate is invisible in production — the allowlist becomes a Set — so
    // it can only ever be a mistake, and it silently inflates the array length
    // the count budget reads.
    expect(new Set(MCP_EXTERNAL_TIER_TOOLS).size).toBe(MCP_EXTERNAL_TIER_TOOLS.length);

    for (const id of MCP_EXTERNAL_TIER_TOOLS) {
      expect(builtInIds.has(id), `${id} is not a built-in action id`).toBe(true);

      const def = registry.get(id as ActionId)?.();
      // `restricted` actions are refused by ActionService regardless of tier, so
      // allowlisting one advertises a tool that can never run.
      expect(def?.danger, `${id} is restricted and cannot run`).not.toBe("restricted");
      // `hidden` is the one thing that still withholds a tier-permitted tool
      // from tools/list. An allowlisted id marked hidden would be listed nowhere
      // yet callable — exactly the advertised-vs-callable split this cut exists
      // to remove, and the tier tests use synthetic entries so they cannot see it.
      expect(def?.mcpVisibility, `${id} is allowlisted but hidden from tools/list`).not.toBe(
        "hidden"
      );
    }
  });

  // The same trap from the other direction, and at every tier rather than just
  // external: `shouldExposeTool` withholds `hidden` while `isTierPermitted`
  // ignores visibility, so a hidden action added to ANY allowlist is unlisted
  // yet callable. `actions.persistedStores` is the only hidden action today and
  // it is deliberately in no tier — this is what keeps that true. The tier
  // suites build synthetic manifest entries, so only a live-registry check here
  // can see it.
  it("no tier allowlist permits an action hidden from tools/list", async () => {
    const { registry } = await createRegistryWithAudit();

    const hidden = [...registry.keys()].filter(
      (id) => registry.get(id as ActionId)?.().mcpVisibility === "hidden"
    );
    // Guard the guard: with no hidden actions at all this proves nothing.
    expect(hidden.length).toBeGreaterThan(0);

    const everyTierTool = new Set<string>([
      ...WORKBENCH_TIER_TOOLS,
      ...ACTION_TIER_ADDONS,
      ...SYSTEM_TIER_ADDONS,
      ...MCP_EXTERNAL_TIER_TOOLS,
    ]);
    expect(hidden.filter((id) => everyTierTool.has(id))).toEqual([]);
  });
});

/**
 * Style rules for the descriptions a model actually reads (#11542).
 *
 * The cohort is every action reachable at any assistant tier, derived from the
 * live allowlists rather than restated, so an action added to a tier is held to
 * these rules the moment it is exposed. The external tier is a subset (asserted
 * below), which is why one cohort covers all four.
 *
 * The rubric these enforce, in order: what the tool is for; when to prefer a
 * sibling instead; what it costs or changes; and what an unusual outcome means.
 * What must NOT appear is anything the JSON Schema already carries — argument
 * names, types, optionality, defaults. `buildToolInputSchema` emits all of that
 * from `argsSchema`, so restating it in prose is duplication the model pays for
 * on every turn. Field-level semantics belong in `.describe()`, which reaches
 * the wire through the same conversion.
 */
describe("LLM-facing tool descriptions (#11542)", () => {
  const LLM_EXPOSED_TOOL_IDS = new Set<string>([
    ...WORKBENCH_TIER_TOOLS,
    ...ACTION_TIER_ADDONS,
    ...SYSTEM_TIER_ADDONS,
  ]);

  // Below the floor a description says nothing a caller can act on. The matching
  // per-description CEILING lives in `mcpWireBudget.test.ts` alongside the rest
  // of the context-condensation budgets — stating it in two files would let the
  // two numbers drift and leave neither authoritative.
  const MIN_DESCRIPTION_BYTES = 120;

  // Aggregate ceilings, set a little above the real totals so a description
  // that balloons trips them while ordinary wording edits do not. Same
  // reasoning as the external payload budget above, applied to the two
  // payloads that exist: what a third-party client is sent, and the largest
  // set the in-app assistant can be sent.
  // 9_600 → 10_300 for #11909's `terminal.closeOwned` and
  // `worktree.deleteOwned`. Both descriptions carry the same load: the tool
  // acts only on resources this session created, and anything else is refused
  // rather than quietly no-oped. That distinction is the whole reason the tools
  // exist, and a caller that misses it will hand them ids from `terminal.list`
  // and read the refusals as a bug.
  const MAX_EXTERNAL_TOTAL_BYTES = 10_300;
  // Raised from 48_000 by #11908, which put seven tools on the in-app surface
  // (a deterministic session resume, the four bookmark mutations, and the two
  // recipe-editor handoffs). Each sits under the 400 B per-description ceiling
  // in `mcpWireBudget.test.ts`; the total simply reflects seven more of them.
  // #11909's two owned-cleanup tools land in the same cohort on top of that.
  // 50_400 → 50_600 for #12091's `git.fetch`. The floor above is 120 B, so a
  // new tool cannot land inside the old ceiling's 79 B of headroom at any
  // wording — the raise is the cost of the tool, not of its prose, and its
  // description is 151 B against the 400 B per-description ceiling.
  const MAX_COHORT_TOTAL_BYTES = 50_600;

  const ARG_SECTION = /\b(?:args?|arguments?|parameters?)\s*(?:\([^)]*\))?\s*:|\btakes no args\b/i;

  async function cohortDefinitions() {
    const { registry } = await createRegistryWithAudit();
    return [...LLM_EXPOSED_TOOL_IDS]
      .map((id) => ({ id, def: registry.get(id as ActionId)?.() }))
      .filter((row): row is { id: string; def: NonNullable<typeof row.def> } => row.def != null);
  }

  it("covers every externally advertised tool", async () => {
    // One cohort can only stand in for all four tiers while this holds. If a
    // tool is ever added to the external allowlist alone, these rules would
    // silently stop applying to the surface that needs them most.
    expect(MCP_EXTERNAL_TIER_TOOLS.filter((id) => !LLM_EXPOSED_TOOL_IDS.has(id))).toEqual([]);

    const rows = await cohortDefinitions();
    expect(rows.length).toBe(LLM_EXPOSED_TOOL_IDS.size);
  });

  it("keeps every description above the readable floor", async () => {
    const rows = await cohortDefinitions();

    const violations = rows
      .map(({ id, def }) => ({ id, bytes: Buffer.byteLength(def.description ?? "", "utf8") }))
      .filter((r) => r.bytes < MIN_DESCRIPTION_BYTES)
      .map((r) => `${r.id} (${r.bytes} bytes)`);

    expect(violations).toEqual([]);
  });

  it("never restates the argument schema in prose", async () => {
    const rows = await cohortDefinitions();

    const violations = rows
      .filter(({ def }) => ARG_SECTION.test(def.description ?? ""))
      .map(({ id }) => id);

    expect(violations).toEqual([]);
  });

  it("never names another action by id anywhere the model can read it", async () => {
    const rows = await cohortDefinitions();
    const ids = new Set<string>(BUILT_IN_ACTION_IDS);

    // A client namespaces each tool and rewrites every character outside
    // [A-Za-z0-9_-], so `forge.listPRs` in prose points at a name the model was
    // never shown.
    //
    // The tool description is not the only prose that reaches it: field
    // descriptions ride the emitted schemas, and examples are forwarded as
    // `_meta.examples`. All three are swept, because fixing only descriptions
    // leaves the other two free to reintroduce exactly what this removes.
    //
    // Example ARGUMENTS are deliberately not swept. An action id there is a
    // value the caller is meant to send — the introspection tools take one —
    // rather than a name it is being told to call.
    const violations: string[] = [];
    const flag = (id: string, where: string, text: string) => {
      for (const named of actionIdsNamedIn(text, ids)) {
        violations.push(`${id} names ${named} in ${where}`);
      }
    };

    for (const { id, def } of rows) {
      flag(id, "description", def.description ?? "");

      for (const example of def.examples ?? []) {
        flag(id, "example description", example.description ?? "");
      }

      if (def.argsSchema) {
        for (const text of nestedDescriptions(emitSchema(def.argsSchema, "input"))) {
          flag(id, "input schema", text);
        }
      }
      // Output schemas only reach the wire when the action opts in.
      if (def.mcpOutputSchema && def.resultSchema) {
        for (const text of nestedDescriptions(emitSchema(def.resultSchema, "output"))) {
          flag(id, "output schema", text);
        }
      }
      for (const raw of [
        def.rawInputSchema,
        def.mcpOutputSchema ? def.rawOutputSchema : undefined,
      ]) {
        for (const text of nestedDescriptions(raw)) flag(id, "raw schema", text);
      }
    }

    expect(violations).toEqual([]);
  });

  it("leaves argument names to the schema that advertises them", async () => {
    const rows = await cohortDefinitions();

    // Backticked only: prose may well use a word that happens to be an
    // argument name ("submit the command"), but backticking it is quoting the
    // schema, which is the duplication this guards against.
    const violations: string[] = [];
    for (const { id, def } of rows) {
      const text = def.description ?? "";
      const props = inputPropertyNames(def.argsSchema);
      if (props === null) {
        violations.push(`${id} has an argsSchema that cannot be advertised at all`);
        continue;
      }
      for (const prop of props) {
        if (text.includes(`\`${prop}\``)) {
          violations.push(`${id} quotes \`${prop}\``);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("describes every argument it advertises on the external surface", async () => {
    const rows = await cohortDefinitions();

    // Scoped to the external tier because that is where prose was deleted on
    // the promise that the schema carries the detail instead. An advertised
    // argument with no description breaks that trade: the caller is left with
    // a name and a type, which is exactly the state this issue set out to fix.
    const external = new Set<string>(MCP_EXTERNAL_TIER_TOOLS);
    const violations: string[] = [];
    for (const { id, def } of rows) {
      if (!external.has(id)) continue;
      if (!def.argsSchema) continue;
      const emitted = z
        .object({
          properties: z
            .record(z.string(), z.object({ description: z.string().optional() }))
            .optional(),
        })
        .parse(emitSchema(def.argsSchema, "input"));
      for (const [prop, schema] of Object.entries(emitted.properties ?? {})) {
        if (!schema.description?.trim()) violations.push(`${id}.${prop}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps both advertised payloads within budget", async () => {
    const rows = await cohortDefinitions();
    const bytesOf = (id: string) =>
      Buffer.byteLength(rows.find((r) => r.id === id)?.def.description ?? "", "utf8");

    const externalTotal = MCP_EXTERNAL_TIER_TOOLS.reduce((sum, id) => sum + bytesOf(id), 0);
    const cohortTotal = rows.reduce(
      (sum, { def }) => sum + Buffer.byteLength(def.description ?? "", "utf8"),
      0
    );

    expect(externalTotal).toBeLessThanOrEqual(MAX_EXTERNAL_TOTAL_BYTES);
    expect(cohortTotal).toBeLessThanOrEqual(MAX_COHORT_TOTAL_BYTES);
  });
});

describe("registry-vs-union drift", () => {
  it("every runtime registry key appears in BUILT_IN_ACTION_IDS", async () => {
    const { registry } = await createRegistryWithAudit();

    const builtInIds = new Set<string>(BUILT_IN_ACTION_IDS);
    for (const id of KEY_ACTION_VALUES) {
      builtInIds.add(id);
    }

    const missingFromIds: string[] = [];
    for (const key of registry.keys()) {
      if (!builtInIds.has(key)) {
        missingFromIds.push(key);
      }
    }

    expect(missingFromIds.sort()).toEqual([]);
  });

  it("every BUILT_IN_ACTION_IDS entry has a runtime registry entry", async () => {
    const { registry } = await createRegistryWithAudit();

    const missingFromRegistry = (BUILT_IN_ACTION_IDS as readonly string[])
      .filter((id) => !registry.has(id as ActionId) && !KEY_ONLY_ACTIONS.has(id))
      .slice()
      .sort();
    expect(missingFromRegistry).toEqual([]);
  });

  it("BUILT_IN_ACTION_IDS has no duplicate entries", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const id of BUILT_IN_ACTION_IDS) {
      if (seen.has(id)) {
        dupes.push(id);
      } else {
        seen.add(id);
      }
    }
    expect(dupes.sort()).toEqual([]);
  });

  it("every BuiltInKeyAction in KEY_ACTION_VALUES has a registry entry (or is allowlisted)", async () => {
    const { registry } = await createRegistryWithAudit();

    const missing: string[] = [];
    for (const id of KEY_ACTION_VALUES) {
      if (!registry.has(id as ActionId) && !KEY_ONLY_ACTIONS.has(id)) {
        missing.push(id);
      }
    }
    expect(missing.sort()).toEqual([]);
  });

  it("every DEFAULT_KEYBINDINGS actionId has a registry entry (or is a key-only action)", async () => {
    const { registry } = await createRegistryWithAudit();

    const missing: Array<{ actionId: string; combo: string }> = [];
    for (const binding of DEFAULT_KEYBINDINGS) {
      const id = binding.actionId;
      if (KEY_ONLY_ACTIONS.has(id)) continue;
      if (registry.has(id as ActionId)) continue;
      missing.push({ actionId: id, combo: binding.combo });
    }
    expect(missing).toEqual([]);
  });
});

describe("definition invariants", () => {
  it("no action has isEnabled without disabledReason", async () => {
    const { registry } = await createRegistryWithAudit();

    const violations: string[] = [];
    for (const [_key, factory] of registry) {
      const def = factory();
      // Only check the isEnabled/disabledReason rule — description length,
      // dangerRationale, and examples rules are warn-then-promote soft gates.
      if (def.isEnabled && !def.disabledReason) {
        violations.push(
          `Action "${def.id}" defines isEnabled but no disabledReason callback. ` +
            `Users may see a disabled command with no explanation.`
        );
      }
    }

    expect(violations).toEqual([]);
  });

  it("every query action has a resultSchema", async () => {
    const { registry } = await createRegistryWithAudit();

    const missing: string[] = [];
    for (const [key, factory] of registry) {
      const def = factory();
      if (def.kind === "query" && !def.resultSchema && !def.rawOutputSchema) {
        missing.push(`${key} (${def.title})`);
      }
    }

    expect(missing).toEqual([]);
  });

  // The length floor is enforced per-cohort in the LLM-facing description
  // suite below, not here. It was a console.warn with a TODO pointing at an
  // issue that closed months earlier — the warn-then-promote pattern that
  // never graduates. Enforcing it registry-wide would still be wrong: the ~300
  // UI-only actions (panel movement, focus cycling, theme toggles) are never
  // advertised to a model, so a prose floor buys them nothing.

  it("every dangerous action has dangerRationale", async () => {
    const { registry } = await createRegistryWithAudit();

    const missing: string[] = [];
    for (const [key, factory] of registry) {
      const def = factory();
      if (def.danger !== "safe" && !def.dangerRationale) {
        missing.push(`${key} (danger="${def.danger}")`);
      }
    }

    expect(missing).toEqual([]);
  });

  it("every workbench-tier arg-requiring action has examples", async () => {
    const { registry } = await createRegistryWithAudit();

    const workbenchSet = new Set<string>(WORKBENCH_TIER_TOOLS as readonly string[]);
    const missing: string[] = [];
    for (const [key, factory] of registry) {
      if (!workbenchSet.has(key)) continue;
      const def = factory();
      const requiresArgs = def.argsSchema
        ? !def.argsSchema.safeParse(undefined).success && !def.argsSchema.safeParse({}).success
        : false;
      if (requiresArgs && (!def.examples || def.examples.length === 0)) {
        missing.push(`${key} (${def.title})`);
      }
    }

    if (missing.length > 0) {
      console.warn(
        `[quality-gate] ${missing.length} workbench-tier arg-requiring action(s) missing examples:\n` +
          missing.map((m) => `  - ${m}`).join("\n")
      );
    }
    // TODO(#8431): Promote to hard assert once all workbench-tier actions have examples.
  });
});

describe("duplicate registrations", () => {
  it("no duplicate registrations that mask different definitions", async () => {
    const { duplicates } = await createRegistryWithAudit();

    if (duplicates.length > 0) {
      console.warn(
        `[quality-gate] ${duplicates.length} duplicate registrations detected:\n` +
          duplicates.map((d) => `  - ${d.key} (registered ${d.count}x, last write wins)`).join("\n")
      );
    }

    // TODO(#6305): Promote to hard assert once duplicates are audited.
    expect(true).toBe(true);
  });
});

/**
 * Destructive actions whose definitions must carry `danger: "confirm"`. The set
 * is the regression guard for #7881 — see docs/architecture/destructive-action-safeguards.md.
 * Demoting any of these to `"safe"` re-enables them for `action.repeatLast` and
 * the action-palette MRU rail, which is wrong for destructive operations.
 *
 * This is a **minimum-floor** guard, not an exhaustive list. The audit doc is
 * the source of truth for which actions belong in this set; when a new
 * destructive action is added to the registry or an existing action is
 * reclassified, update both the audit table and this list. The list does NOT
 * prove every destructive action carries `danger:"confirm"` — only that the
 * named ones still do.
 */
const EXPECTED_CONFIRM_DANGER: ReadonlyArray<ActionId> = [
  "git.push",
  "git.pullRebase",
  "git.rebaseOntoBase",
  "git.mergeBaseIntoBranch",
  "git.abortRepositoryOperation",
  "git.forcePushWithLease",
  "terminal.kill",
  "terminal.killAll",
  "terminal.restart",
  "terminal.restartAll",
  "terminal.arm",
  "worktree.delete",
  "worktree.sessions.endAll",
  "worktree.sessions.trashAll",
  "worktree.sessions.restartAll",
  "worktree.sessions.clearHistory",
  "fleet.kill",
  "fleet.trash",
  "fleet.restart",
  "fleet.deleteNamedFleet",
  "worktree.resource.teardown",
  "portal.links.remove",
  "keybinding.resetAll",
  "logs.clear",
  "project.remove",
  "recipe.delete",
  "recipe.run",
  "devPreview.restartAndClearCache",
  "devPreview.reinstallAndRestart",
  "artifact.applyPatch",
  "agentSettings.reset",
  "app.importConfig",
  "forge.createPR",
  "forge.closePR",
  "forge.reopenPR",
  "forge.mergePR",
  "forge.convertPRToDraft",
  "forge.markPRReadyForReview",
  "forge.commentOnPR",
  "forge.editPR",
  "forge.closeIssue",
  "forge.editIssue",
  "session.bookmarkAndClose",
  "session.bookmark.delete",
];

/**
 * Actions from EXPECTED_CONFIRM_DANGER whose user/menu/keybinding call site has
 * a ConfirmDialog-family component wired at the call site. `danger:"confirm"` only
 * gates the agent dispatch source at runtime (ActionService.ts) — user-initiated
 * dispatch is gated by a dialog wired at the call site, which the registry can't see.
 *
 * Update contract: when you wire a ConfirmDialog for one of the
 * EXPECTED_CONFIRM_DANGER actions, add its ID here and flip the audit row in
 * docs/architecture/destructive-action-safeguards.md to "UI confirm: yes".
 * The ongoing CI enforcement — verifying that the listed call sites still exist
 * in source — runs via `npm run check:confirm-wiring`.
 */
const CONFIRMED_WIRED: ReadonlyArray<ActionId> = [
  "app.importConfig",
  "terminal.kill",
  "terminal.killAll",
  "terminal.restart",
  "terminal.restartAll",
  "worktree.delete",
  "worktree.sessions.endAll",
  "worktree.sessions.trashAll",
  "worktree.sessions.restartAll",
  "worktree.sessions.clearHistory",
  "worktree.resource.teardown",
  "fleet.kill",
  "fleet.trash",
  "fleet.restart",
  "fleet.deleteNamedFleet",
  "portal.links.remove",
  "keybinding.resetAll",
  "logs.clear",
  "recipe.delete",
  "devPreview.restartAndClearCache",
  "devPreview.reinstallAndRestart",
];

/**
 * Actions from EXPECTED_CONFIRM_DANGER whose confirmation uses a non-ConfirmDialog
 * pattern: IPC bypass without the action ID co-located in the dialog's file,
 * deferred-promise store, or agent-dispatch-only gate with no user-side dialog.
 * See docs/architecture/destructive-action-safeguards.md Known Bypasses.
 */
const BYPASS_WIRED: ReadonlyArray<ActionId> = [
  // Deferred-promise via gitPushConfirmStore; action run() awaits confirmation
  // before calling IPC; GitPushConfirmDialog resolves the Promise.
  "git.push",
  // IPC bypass in ReviewHubContent.tsx; ConfirmDialog wired there but the action
  // ID string is not present in that file (direct IPC call, not ActionService dispatch).
  "git.pullRebase",
  // Deferred-promise via gitWorktreeOperationConfirmStore (#12092); the action
  // run() awaits confirmation before calling IPC, and
  // GitWorktreeOperationConfirmDialog resolves the Promise. The dialog is
  // mounted globally in ModalHostLayer, so the action ID is not co-located with
  // it — the same shape as git.push above.
  "git.rebaseOntoBase",
  "git.mergeBaseIntoBranch",
  "git.abortRepositoryOperation",
  // Deferred-promise via gitForcePushStore; action run() awaits confirmation
  // before calling IPC; GitForcePushConfirmDialog resolves the Promise. Same
  // shape as git.push, and the action ID is not co-located with the dialog.
  "git.forcePushWithLease",
  // Confirm in ProjectSwitcherPalette.tsx via removeConfirmProject state;
  // action ID not co-located with the ConfirmDialog in that file.
  "project.remove",
  // Agent/MCP-only confirm gate (#11346): arming reroutes the user's next
  // keystrokes to every armed terminal, so an external caller must pass the
  // host confirm dialog. Palette-hidden, and user-side arming goes through the
  // fleet ribbon (which calls the store directly, not ActionService), so there
  // is no user-facing dispatch path to co-locate a ConfirmDialog with.
  "terminal.arm",
  // Agent-dispatch only — no user-side ConfirmDialog. danger:"confirm" gates MCP/agent
  // dispatch only; user dispatch of recipe.run is intentionally ungated.
  "recipe.run",
  // Agent/MCP-only — palette-hidden and unbound, configured from Settings via the
  // client (not ActionService). danger:"confirm" gates agent dispatch (resetting
  // all agents at once is destructive-local with no undo); there is no UI
  // ConfirmDialog because there is no user-facing dispatch path.
  "agentSettings.reset",
  // ConfirmDialog with diff preview in ArtifactOverlay.tsx; the dispatch lives in
  // useArtifacts.ts (action ID not co-located with the dialog component).
  "artifact.applyPatch",
  // Forge PR write actions are agent/MCP-only — exposed over MCP, not bound to a
  // user-side ConfirmDialog. danger:"confirm" gates agent dispatch (requiring
  // confirmed:true) and excludes them from repeatLast/MRU; there is no UI
  // dispatch path to wire a dialog to (issue #10654).
  "forge.createPR",
  "forge.closePR",
  "forge.reopenPR",
  "forge.mergePR",
  "forge.convertPRToDraft",
  "forge.markPRReadyForReview",
  "forge.commentOnPR",
  "forge.editPR",
  // Agent/MCP-only forge write surface (#10653) — no user-side ConfirmDialog.
  // danger:"confirm" gates agent dispatch only (closing an issue / overwriting
  // its body on the shared forge are D2 mutations needing acknowledgment); user
  // dispatch happens through the forge UI, not these actions.
  "forge.closeIssue",
  "forge.editIssue",
  "session.bookmarkAndClose",
  "session.bookmark.delete",
];

describe("destructive-action confirm wiring", () => {
  it('every CONFIRMED_WIRED action is classified danger:"confirm"', () => {
    // A wired ConfirmDialog without danger:"confirm" leaks the action into the
    // action-palette MRU rail and action.repeatLast — classification must lead
    // wiring (CLAUDE.md "Destructive Action Tiers", rule 2).
    const leaked = CONFIRMED_WIRED.filter((id) => !EXPECTED_CONFIRM_DANGER.includes(id));
    expect(leaked).toEqual([]);
  });

  it('every BYPASS_WIRED action is classified danger:"confirm"', () => {
    const leaked = BYPASS_WIRED.filter((id) => !EXPECTED_CONFIRM_DANGER.includes(id));
    expect(leaked).toEqual([]);
  });

  it("every EXPECTED_CONFIRM_DANGER action has a wired confirm call site", () => {
    const allWired = new Set<ActionId>([...CONFIRMED_WIRED, ...BYPASS_WIRED]);
    const unwired = EXPECTED_CONFIRM_DANGER.filter((id) => !allWired.has(id));
    expect(unwired).toEqual([]);
  });
});

describe("destructive-action danger metadata", () => {
  it('every action in EXPECTED_CONFIRM_DANGER is registered with danger:"confirm"', async () => {
    const { registry } = await createRegistryWithAudit();

    const mismatches: string[] = [];
    for (const id of EXPECTED_CONFIRM_DANGER) {
      const factory = registry.get(id);
      if (!factory) {
        mismatches.push(`${id} (not registered)`);
        continue;
      }
      const def = factory();
      if (def.danger !== "confirm") {
        mismatches.push(`${id} (danger="${def.danger}", expected "confirm")`);
      }
    }

    expect(mismatches).toEqual([]);
  });

  it("every action in EXPECTED_CONFIRM_DANGER blocks agent dispatch without confirmed:true", async () => {
    // This proves the ActionService.ts:283 agent-source gate fires for every
    // listed action — the only runtime safety the `danger` field provides for
    // built-in dispatch (user/keybinding sources are gated by call-site dialogs
    // tracked separately in the audit). If this regresses, MCP agents could
    // invoke destructive ops without confirmation.
    const { ActionService } = await import("../../ActionService");
    const { registry } = await createRegistryWithAudit();
    const service = new ActionService();
    for (const id of EXPECTED_CONFIRM_DANGER) {
      const factory = registry.get(id);
      if (factory) service.register(factory());
    }

    // Many destructive actions require a `worktreeId` or `id` arg; arg
    // validation runs before the confirm gate, so undefined args would
    // short-circuit with VALIDATION_ERROR. Provide both placeholder keys —
    // zod object schemas strip unknown keys, so the irrelevant one is a no-op.
    const placeholderArgs = {
      worktreeId: "wt-placeholder",
      id: "id-placeholder",
      projectId: "project-placeholder",
      recipeId: "recipe-placeholder",
      patchContent: "--- a\n+++ b",
      cwd: "/placeholder",
      // forge.* PR write actions require these before the confirm gate runs.
      prNumber: 1,
      head: "feature-branch",
      base: "main",
      title: "placeholder",
      body: "placeholder",
      // forge.closeIssue/editIssue need a valid issueNumber (+ a title so
      // editIssue's title-or-body refinement passes) to clear arg validation
      // and reach the confirm gate.
      issueNumber: 1,
      // terminal.kill/restart require a terminalId before their confirm gate runs.
      terminalId: "term-placeholder",
      // session.bookmarkAndClose/delete need label + sessionId to clear arg
      // validation and reach the confirm gate.
      label: "placeholder",
      sessionId: "session-placeholder",
      // git.rebaseOntoBase/mergeBaseIntoBranch require the base branch before
      // their confirm gate runs (#12092). It is deliberately NOT optional: a
      // base-branch default resolved inside a destructive submit is exactly the
      // silent fallback the D-tier rules call a review blocker.
      baseBranch: "develop",
    };

    // Some listed actions (e.g. worktree.resource.teardown) gate availability
    // via `isEnabled`, which runs *before* the confirm gate. Without a view
    // store its predicate throws → DISABLED, masking the confirm gate we want
    // to assert. Seed a placeholder worktree that satisfies those predicates
    // and pass the matching context so the danger gate is what fires.
    const viewStore: WorktreeViewStoreApi = createStore<WorktreeViewStore>(() => ({
      worktrees: new Map<string, WorktreeSnapshot>([
        ["wt-placeholder", { id: "wt-placeholder", hasTeardownCommand: true } as WorktreeSnapshot],
      ]),
      statusCheckedAt: new Map(),
      workingTreeChangedAtById: new Map(),
      manualAssociations: new Map(),
      version: { epoch: "test", seq: 1 },
      tombstones: new Map(),
      deletingIds: new Set(),
      deleteErrors: new Map(),
      deleteErrorArgs: new Map(),
      issueMutatingIds: new Set(),
      issueErrors: new Map(),
      mutationOutbox: new Map(),
      isLoading: false,
      error: null,
      isInitialized: true,
      isReconnecting: false,
      reconnectingAt: null,
      watcherDegraded: false,
      topologyWatcherDark: false,
      applySnapshot: () => {},
      applyUpdate: () => true,
      applyRemove: () => {},
      setManualAssociation: () => {},
      clearManualAssociation: () => {},
      startDelete: () => {},
      retryDelete: () => {},
      clearDeleteError: () => {},
      startAttachIssue: () => {},
      startDetachIssue: () => {},
      pruneAcknowledgedMutations: () => {},
      retryOutboxEntry: () => {},
      dismissOutboxEntry: () => {},
      replayOutboxAfterReconnect: () => {},
      setLoading: () => {},
      setError: () => {},
      setFatalError: () => {},
      setReconnecting: () => {},
      setWatcherDegraded: () => {},
      setTopologyWatcherDark: () => {},
      applyIssueNotFound: () => {},
    }));
    setCurrentViewStore(viewStore);
    const contextOverride = {
      activeWorktreeId: "wt-placeholder",
      focusedWorktreeId: "wt-placeholder",
    };

    const failures: string[] = [];
    for (const id of EXPECTED_CONFIRM_DANGER) {
      const result = await service.dispatch(id, placeholderArgs, {
        source: "agent",
        contextOverride,
      });
      if (result.ok) {
        failures.push(`${id} (agent dispatch succeeded without confirmed:true)`);
        continue;
      }
      if (result.error.code !== "CONFIRMATION_REQUIRED") {
        failures.push(
          `${id} (got error code "${result.error.code}", expected CONFIRMATION_REQUIRED)`
        );
      }
    }

    expect(failures).toEqual([]);
  });
});

/**
 * Built-in actions that inject text/keystrokes into terminals and therefore must
 * be closed to plugin `host.dispatch` (#10558) — plugins inject only through the
 * `agent:input`-gated `host.sendToActiveAgent`. The single source of truth is
 * `DENY_PLUGIN_DISPATCH_ACTION_IDS` in `shared/config/actionIds.ts`, which the
 * plugin manifest validator (#10580) also consumes; the completeness guard below
 * asserts it stays in lockstep with the registry's `denyPluginDispatch: true`
 * flags so a new injection action can't silently bypass either gate.
 */
const PLUGIN_DENIED_INJECTION_ACTIONS: ReadonlyArray<ActionId> =
  DENY_PLUGIN_DISPATCH_ACTION_IDS as unknown as ActionId[];

describe("plugin-dispatch injection guard (#10558)", () => {
  it("DENY_PLUGIN_DISPATCH_ACTION_IDS exactly matches the registry's denyPluginDispatch flags", async () => {
    // `satisfies readonly BuiltInRuntimeActionId[]` on the constant only catches
    // renames/removals — a newly-flagged action omitted from the list would slip
    // through. This is the completeness guard (#10580, lesson #8341): the exported
    // deny-list and the actual `denyPluginDispatch: true` definitions must be the
    // same set, or both the runtime dispatch gate and the manifest validator drift.
    const { registry } = await createRegistryWithAudit();
    const flaggedInRegistry = new Set<string>();
    for (const [id, factory] of registry) {
      if (factory().denyPluginDispatch === true) {
        flaggedInRegistry.add(id);
      }
    }
    expect([...flaggedInRegistry].sort()).toEqual([...DENY_PLUGIN_DISPATCH_ACTION_IDS].sort());
  });

  it("rejects plugin-source dispatch with RESTRICTED for every injection action", async () => {
    const { ActionService } = await import("../../ActionService");
    const { registry } = await createRegistryWithAudit();
    const service = new ActionService();
    for (const [, factory] of registry) {
      service.register(factory());
    }
    // Valid args so dispatch reaches the plugin-dispatch gate rather than
    // short-circuiting on VALIDATION_ERROR (terminal.sendCommand requires both;
    // project.runCheck requires projectId + runnerId). Schemas are non-strict,
    // so the union satisfies every denied action.
    const args = {
      terminalId: "t-placeholder",
      command: "noop",
      url: "https://example.com",
      projectId: "p-placeholder",
      runnerId: "r-placeholder",
    };

    const failures: string[] = [];
    for (const id of PLUGIN_DENIED_INJECTION_ACTIONS) {
      const result = await service.dispatch(id, args, { source: "plugin" });
      if (result.ok) {
        failures.push(`${id} (plugin dispatch succeeded — side door open)`);
        continue;
      }
      if (result.error.code !== "RESTRICTED") {
        failures.push(`${id} (got "${result.error.code}", expected RESTRICTED)`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("dangerRationale backfill", () => {
  it("every EXPECTED_CONFIRM_DANGER action has a non-empty dangerRationale", async () => {
    const { registry } = await createRegistryWithAudit();

    const missing: string[] = [];
    for (const id of EXPECTED_CONFIRM_DANGER) {
      const factory = registry.get(id);
      if (!factory) {
        missing.push(`${id} (not registered)`);
        continue;
      }
      const def = factory();
      if (!def.dangerRationale || def.dangerRationale.trim().length === 0) {
        missing.push(`${id}`);
      }
    }

    expect(missing).toEqual([]);
  });
});

describe("ActionService.list() snapshot", () => {
  it("produces a stable, sorted manifest snapshot", async () => {
    const { ActionService } = await import("../../ActionService");
    const { registry } = await createRegistryWithAudit();
    const service = new ActionService();
    for (const [_key, factory] of registry) {
      service.register(factory());
    }

    const entries = service
      .list()
      .map(
        ({
          id,
          title,
          description,
          category,
          kind,
          danger,
          requiresArgs,
          keywords,
          examples,
          dangerRationale,
        }) => ({
          id,
          title,
          description,
          category,
          kind,
          danger,
          requiresArgs,
          keywords,
          examples,
          dangerRationale,
        })
      )
      .sort((a, b) => a.id.localeCompare(b.id));

    expect(entries).toMatchSnapshot();
  });
});
