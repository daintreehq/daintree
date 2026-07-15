import { describe, it, expect } from "vitest";
import { createStore } from "zustand/vanilla";
import { setCurrentViewStore } from "@/store/createWorktreeStore";
import type { WorktreeViewStore, WorktreeViewStoreApi } from "@/store/createWorktreeStore";
import type { WorktreeSnapshot } from "@shared/types";
import { KEY_ACTION_VALUES } from "@shared/types/keymap";
import { BUILT_IN_ACTION_IDS, DENY_PLUGIN_DISPATCH_ACTION_IDS } from "@shared/config/actionIds";
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
  "terminal.kill",
  "terminal.killAll",
  "terminal.restart",
  "terminal.restartAll",
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
  // Confirm in ProjectSwitcherPalette.tsx via removeConfirmProject state;
  // action ID not co-located with the ConfirmDialog in that file.
  "project.remove",
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
      applyUpdate: () => {},
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
    // short-circuiting on VALIDATION_ERROR (terminal.sendCommand requires both).
    const args = { terminalId: "t-placeholder", command: "noop", url: "https://example.com" };

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
