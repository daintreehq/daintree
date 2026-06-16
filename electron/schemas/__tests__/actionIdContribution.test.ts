import { describe, it, expect } from "vitest";
import { getPluginManifestSchema } from "../plugin.js";

// A real built-in action id (see shared/config/actionIds.ts) — referencing one
// from a plugin contribution is valid and common.
const BUILT_IN_ACTION_ID = "terminal.list";

function manifestWith(overrides: Record<string, unknown>) {
  return {
    name: "acme.my-plugin",
    version: "1.0.0",
    ...overrides,
  };
}

// Build a valid contribution entry of each kind carrying the given actionId, so
// only the actionId namespace gate decides accept/reject.
const contributionEntry: Record<string, (actionId: string) => Record<string, unknown>> = {
  toolbarButtons: (actionId) => ({
    id: "btn",
    label: "Btn",
    iconId: "sparkles",
    actionId,
  }),
  menuItems: (actionId) => ({ label: "Item", actionId, location: "help" }),
  keybindings: (actionId) => ({ actionId, combo: "ctrl+k" }),
  contextMenus: (actionId) => ({ actionId, location: "terminal", label: "Item" }),
};

const CONTRIBUTION_ARRAYS = Object.keys(contributionEntry);

describe("manifest-level actionId namespace gate (issue #10565)", () => {
  const schema = getPluginManifestSchema(false);

  it("accepts a contribution referencing a built-in action", () => {
    const result = schema.safeParse(
      manifestWith({
        contributes: { toolbarButtons: [contributionEntry.toolbarButtons(BUILT_IN_ACTION_ID)] },
      })
    );
    expect(result.success).toBe(true);
  });

  it("accepts a keybinding-driven built-in action (BuiltInKeyAction half of the union)", () => {
    // BuiltInActionId = BuiltInKeyAction | BuiltInRuntimeActionId. The allowlist
    // must cover both halves, or a legitimate keybinding to a key-action like
    // app.settings is rejected and the whole plugin fails to load.
    const result = schema.safeParse(
      manifestWith({
        contributes: { keybindings: [contributionEntry.keybindings("app.settings")] },
      })
    );
    expect(result.success).toBe(true);
  });

  it("accepts an own-namespace actionId even without a matching contributes.commands entry", () => {
    // Plugin actions are frequently registered imperatively via
    // host.registerAction, which is invisible at parse time — so an id in the
    // plugin's own namespace must pass without a declared command. A typo within
    // the own namespace (e.g. acme.my-plugin.typoo) also passes — that is an
    // intentional consequence of namespace-ownership gating, not a gap to close;
    // catching a non-existent own-namespace suffix requires the runtime registry.
    const result = schema.safeParse(
      manifestWith({
        contributes: {
          toolbarButtons: [contributionEntry.toolbarButtons("acme.my-plugin.greet")],
        },
      })
    );
    expect(result.success).toBe(true);
  });

  it("rejects a foreign-namespace actionId with a precise error code and path", () => {
    const result = schema.safeParse(
      manifestWith({
        contributes: {
          toolbarButtons: [contributionEntry.toolbarButtons("other.plugin.foo")],
        },
      })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) =>
          (i as { params?: { errorCode?: string } }).params?.errorCode ===
          "action_id_unknown_namespace"
      );
      expect(issue).toBeDefined();
      expect(issue?.path).toEqual(["contributes", "toolbarButtons", 0, "actionId"]);
    }
  });

  it.each(CONTRIBUTION_ARRAYS)(
    "rejects a foreign-namespace actionId contributed via %s",
    (arrayName) => {
      const result = schema.safeParse(
        manifestWith({
          contributes: { [arrayName]: [contributionEntry[arrayName]("other.plugin.foo")] },
        })
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find(
          (i) =>
            (i as { params?: { errorCode?: string } }).params?.errorCode ===
            "action_id_unknown_namespace"
        );
        expect(issue).toBeDefined();
        expect(issue?.path).toEqual(["contributes", arrayName, 0, "actionId"]);
      }
    }
  );

  it("reports a separate issue at the correct index for each invalid entry", () => {
    const result = schema.safeParse(
      manifestWith({
        contributes: {
          toolbarButtons: [
            contributionEntry.toolbarButtons("acme.my-plugin.ok"),
            contributionEntry.toolbarButtons("other.plugin.foo"),
            contributionEntry.toolbarButtons("another.plugin.bar"),
          ],
        },
      })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const unknownNamespaceIssues = result.error.issues.filter(
        (i) =>
          (i as { params?: { errorCode?: string } }).params?.errorCode ===
          "action_id_unknown_namespace"
      );
      expect(unknownNamespaceIssues.map((i) => i.path)).toEqual([
        ["contributes", "toolbarButtons", 1, "actionId"],
        ["contributes", "toolbarButtons", 2, "actionId"],
      ]);
    }
  });

  it.each(CONTRIBUTION_ARRAYS)("accepts a built-in actionId contributed via %s", (arrayName) => {
    const result = schema.safeParse(
      manifestWith({
        contributes: { [arrayName]: [contributionEntry[arrayName](BUILT_IN_ACTION_ID)] },
      })
    );
    expect(result.success).toBe(true);
  });
});
