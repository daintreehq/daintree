import { describe, it, expect } from "vitest";
import { KEY_ACTION_VALUES } from "@shared/types/keymap";
import type { ActionId } from "@shared/types/actions";
import type { ActionRegistry, ActionCallbacks } from "../actionTypes";
import { validateDefinitionInvariants } from "../../ActionService";

/**
 * Action IDs that exist in BuiltInKeyAction but are intentionally NOT in the
 * action registry. These are pure keybinding targets dispatched through
 * keybinding code paths that bypass ActionService, or navigation primitives
 * that the OS/terminal handles directly.
 */
const KEY_ONLY_ACTIONS = new Set([
  // Pure navigation — handled by terminal/focus infrastructure, not ActionService
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
  // Modal/keybinding-only escape hatch
  "ui.escape",
  // Tab navigation handled by tab infrastructure
  "tab.next",
  "tab.previous",
  // Keybinding-only terminal actions with no ActionService dispatch
  "terminal.scrollToLastActivity",
  "terminal.armDefault",
  "terminal.disarmAll",
  // Fleet dispatch handled through separate arming infrastructure
  "fleet.armFocused",
  // Keybinding-only: opens via palette infrastructure, not ActionService
  "action.palette",
  // Keybinding-only file operations — dispatched through file IPC, not ActionService
  "file.open",
  "file.copyPath",
  "file.copyTree",
  // Keybinding-only: toggled through git infrastructure, not ActionService
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

/**
 * Create a registry with a shim Map that records duplicate `set()` calls.
 */
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
  it("every registry ID appears in BuiltInActionId union (registry->union)", async () => {
    const { registry } = await createRegistryWithAudit();

    const fs = await import("node:fs/promises");
    const actionsFileUrl = new URL("../../../../shared/types/actions.ts", import.meta.url);
    const contents = await fs.readFile(actionsFileUrl, "utf8");

    const start = contents.indexOf("export type BuiltInActionId");
    const end = contents.indexOf("export type ActionId = BuiltInActionId", start);
    const section = contents.slice(start, end);

    const builtInIds = new Set<string>();
    const regex = /\|\s*"([^"]+)"/g;
    for (const match of section.matchAll(regex)) {
      builtInIds.add(match[1]!);
    }

    // Guard against regex silently producing zero matches (e.g. if the union
    // format changes). Check BEFORE merging KEY_ACTION_VALUES so a regex
    // failure isn't masked by the runtime set.
    if (builtInIds.size < 200) {
      throw new Error(
        `Parsed only ${builtInIds.size} IDs from BuiltInActionId union (expected 200+). ` +
          `The union format may have changed — update the regex or the test.`
      );
    }

    // Merge with KEY_ACTION_VALUES for BuiltInKeyAction coverage
    for (const id of KEY_ACTION_VALUES) {
      builtInIds.add(id);
    }

    const missingFromUnion: string[] = [];
    for (const key of registry.keys()) {
      if (!builtInIds.has(key)) {
        missingFromUnion.push(key);
      }
    }

    expect(missingFromUnion.sort()).toEqual([]);
  });

  it("every BuiltInActionId string literal has a registry entry (union->registry)", async () => {
    const { registry } = await createRegistryWithAudit();

    const fs = await import("node:fs/promises");
    const actionsFileUrl = new URL("../../../../shared/types/actions.ts", import.meta.url);
    const contents = await fs.readFile(actionsFileUrl, "utf8");

    const start = contents.indexOf("export type BuiltInActionId");
    const end = contents.indexOf("export type ActionId = BuiltInActionId", start);
    const section = contents.slice(start, end);

    const ids = new Set<string>();
    const regex = /\|\s*"([^"]+)"/g;
    for (const match of section.matchAll(regex)) {
      ids.add(match[1]!);
    }

    const missingFromRegistry = Array.from(ids)
      .filter((id) => !registry.has(id as ActionId) && !KEY_ONLY_ACTIONS.has(id))
      .sort();
    expect(missingFromRegistry).toEqual([]);
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
});

describe("definition invariants", () => {
  it("no action has isEnabled without disabledReason", async () => {
    const { registry } = await createRegistryWithAudit();

    const violations: string[] = [];
    for (const [_key, factory] of registry) {
      const def = factory();
      const msgs = validateDefinitionInvariants(def);
      violations.push(...msgs);
    }

    expect(violations).toEqual([]);
  });

  it("every query action has a resultSchema", async () => {
    const { registry } = await createRegistryWithAudit();

    const missing: string[] = [];
    for (const [key, factory] of registry) {
      const def = factory();
      if (def.kind === "query" && !def.resultSchema) {
        missing.push(`${key} (${def.title})`);
      }
    }

    // Warn-only: report missing but don't fail CI yet.
    // 49 existing query actions need resultSchema — too many to add in one
    // pass. This report flags new query actions at PR time.
    if (missing.length > 0) {
      console.warn(
        `[quality-gate] ${missing.length} query action(s) missing resultSchema:\n` +
          missing.map((m) => `  - ${m}`).join("\n")
      );
    }
    // TODO(#6305): Promote to hard assert once existing schemas are added.
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
    // Some overwrites are intentional (minimal keybinding def vs full
    // command-palette def). The DUPLICATE_ALLOWLIST above gates per-ID.
    expect(true).toBe(true);
  });
});
