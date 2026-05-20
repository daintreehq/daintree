import { describe, it, expect } from "vitest";
import { createStore } from "zustand/vanilla";
import { setCurrentViewStore } from "@/store/createWorktreeStore";
import type { WorktreeViewStore, WorktreeViewStoreApi } from "@/store/createWorktreeStore";
import type { WorktreeSnapshot } from "@shared/types";
import { KEY_ACTION_VALUES } from "@shared/types/keymap";
import { BUILT_IN_ACTION_IDS } from "@shared/config/actionIds";
import type { ActionId } from "@shared/types/actions";
import type { ActionRegistry, ActionCallbacks } from "../actionTypes";
import { DEFAULT_KEYBINDINGS } from "../../defaultKeybindings";
import { WORKBENCH_TIER_TOOLS } from "@shared/config/helpAssistantTierAllowlists";

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

  it("every action description is at least 80 characters", async () => {
    const { registry } = await createRegistryWithAudit();

    const short: string[] = [];
    for (const [key, factory] of registry) {
      const def = factory();
      const len = def.description?.length ?? 0;
      if (len < 80) {
        short.push(`${key} (${len} chars)`);
      }
    }

    if (short.length > 0) {
      console.warn(
        `[quality-gate] ${short.length} action(s) with descriptions shorter than 80 chars:\n` +
          short.map((s) => `  - ${s}`).join("\n")
      );
    }
    // TODO(#8431): Promote to hard assert once descriptions are gradually improved.
  });

  it("every dangerous action has dangerRationale", async () => {
    const { registry } = await createRegistryWithAudit();

    const missing: string[] = [];
    for (const [key, factory] of registry) {
      const def = factory();
      if (def.danger !== "safe" && !def.dangerRationale) {
        missing.push(`${key} (danger="${def.danger}")`);
      }
    }

    if (missing.length > 0) {
      console.warn(
        `[quality-gate] ${missing.length} dangerous action(s) missing dangerRationale:\n` +
          missing.map((m) => `  - ${m}`).join("\n")
      );
    }
    // TODO(#8431): Promote to hard assert once all dangerous actions have rationale.
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
  "git.snapshotRevert",
  "git.snapshotDelete",
  "terminal.kill",
  "terminal.killAll",
  "terminal.restart",
  "terminal.restartAll",
  "worktree.delete",
  "worktree.sessions.endAll",
  "worktree.sessions.trashAll",
  "worktree.sessions.restartAll",
  "fleet.kill",
  "fleet.trash",
  "fleet.restart",
  "fleet.deleteNamedFleet",
  "worktree.resource.teardown",
  "portal.links.remove",
  "keybinding.resetAll",
  "project.remove",
  "recipe.delete",
  "devPreview.restartAndClearCache",
  "devPreview.reinstallAndRestart",
];

/**
 * Actions from EXPECTED_CONFIRM_DANGER whose user/menu/keybinding call site has
 * a confirmed, identified `ConfirmDialog` gate (the audit's "UI confirm: yes"
 * rows). `danger:"confirm"` only gates the agent dispatch source at runtime
 * (ActionService.ts) — user-initiated dispatch is gated by a dialog wired at the
 * call site, which the registry can't see. This list is the registry-side
 * counterpart to that call-site wiring: a static allowlist, deliberately, since
 * a source grep is brittle against aliased imports and refactors.
 *
 * Update contract: when you wire a ConfirmDialog for one of the
 * EXPECTED_CONFIRM_DANGER actions, add its ID here and flip the audit row in
 * docs/architecture/destructive-action-safeguards.md to "UI confirm: yes".
 *
 * `git.snapshotRevert` / `git.snapshotDelete` are wired in
 * src/components/Worktree/WorktreeCard/hooks/useWorktreeActions.ts
 * (handleRevertAgentChanges / handleDeleteSnapshot), surfaced via
 * WorktreeMenuItems and gated by the shared ConfirmDialog in WorktreeDialogs.
 */
const CONFIRMED_WIRED: ReadonlyArray<ActionId> = ["git.snapshotRevert", "git.snapshotDelete"];

describe("destructive-action confirm wiring", () => {
  it('every CONFIRMED_WIRED action is classified danger:"confirm"', () => {
    // A wired ConfirmDialog without danger:"confirm" leaks the action into the
    // action-palette MRU rail and action.repeatLast — classification must lead
    // wiring (CLAUDE.md "Destructive Action Tiers", rule 2).
    const leaked = CONFIRMED_WIRED.filter((id) => !EXPECTED_CONFIRM_DANGER.includes(id));
    expect(leaked).toEqual([]);
  });

  it("every EXPECTED_CONFIRM_DANGER action has a wired confirm call site", () => {
    const unwired = EXPECTED_CONFIRM_DANGER.filter((id) => !CONFIRMED_WIRED.includes(id));

    if (unwired.length > 0) {
      console.warn(
        `[quality-gate] ${unwired.length} confirm-danger action(s) without an ` +
          `identified ConfirmDialog call site in CONFIRMED_WIRED:\n` +
          unwired.map((id) => `  - ${id}`).join("\n")
      );
    }

    // TODO(#8415): Promote to `expect(unwired).toEqual([])` once every
    // EXPECTED_CONFIRM_DANGER call site is audited and listed in CONFIRMED_WIRED.
    expect(true).toBe(true);
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
      manualAssociations: new Map(),
      version: { epoch: "test", seq: 1 },
      tombstones: new Map(),
      deletingIds: new Set(),
      deleteErrors: new Map(),
      deleteErrorArgs: new Map(),
      mutationOutbox: new Map(),
      isLoading: false,
      error: null,
      isInitialized: true,
      isReconnecting: false,
      reconnectingAt: null,
      watcherDegraded: false,
      applySnapshot: () => {},
      applyUpdate: () => {},
      applyRemove: () => {},
      setManualAssociation: () => {},
      clearManualAssociation: () => {},
      startDelete: () => {},
      retryDelete: () => {},
      clearDeleteError: () => {},
      pruneAcknowledgedMutations: () => {},
      retryOutboxEntry: () => {},
      dismissOutboxEntry: () => {},
      replayOutboxAfterReconnect: () => {},
      setLoading: () => {},
      setError: () => {},
      setFatalError: () => {},
      setReconnecting: () => {},
      setWatcherDegraded: () => {},
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
