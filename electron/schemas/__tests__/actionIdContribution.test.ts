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

// A valid contributes.commands entry whose bare id namespaces to
// `${manifest.name}.${id}` at load time. Used to test the own-namespace
// declared-command cross-check (#10580).
function commandEntry(id: string): Record<string, unknown> {
  return {
    id,
    title: "Cmd",
    description: "A command",
    category: "general",
    kind: "command",
    danger: "safe",
  };
}

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

  it("accepts an own-namespace actionId when no commands are declared (imperative escape hatch)", () => {
    // Plugin actions are frequently registered imperatively via
    // host.registerAction, which is invisible at parse time — so when the plugin
    // declares no contributes.commands, any id in its own namespace must pass.
    const result = schema.safeParse(
      manifestWith({
        contributes: {
          toolbarButtons: [contributionEntry.toolbarButtons("acme.my-plugin.greet")],
        },
      })
    );
    expect(result.success).toBe(true);
  });

  it("accepts an own-namespace actionId that matches a declared command", () => {
    const result = schema.safeParse(
      manifestWith({
        contributes: {
          commands: [commandEntry("greet")],
          toolbarButtons: [contributionEntry.toolbarButtons("acme.my-plugin.greet")],
        },
      })
    );
    expect(result.success).toBe(true);
  });

  it("rejects a typo'd own-namespace actionId when commands are declared (issue #10580)", () => {
    // With commands declared, an own-namespace id matching none of them is a typo
    // for a command that will never exist — it must be caught at parse time.
    const result = schema.safeParse(
      manifestWith({
        contributes: {
          commands: [commandEntry("openInBrowser")],
          toolbarButtons: [contributionEntry.toolbarButtons("acme.my-plugin.openInBrowswer")],
        },
      })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) =>
          (i as { params?: { errorCode?: string } }).params?.errorCode ===
          "action_id_undeclared_command"
      );
      expect(issue).toBeDefined();
      expect(issue?.path).toEqual(["contributes", "toolbarButtons", 0, "actionId"]);
    }
  });

  it.each(CONTRIBUTION_ARRAYS)(
    "rejects a typo'd own-namespace actionId contributed via %s",
    (arrayName) => {
      const result = schema.safeParse(
        manifestWith({
          contributes: {
            commands: [commandEntry("greet")],
            [arrayName]: [contributionEntry[arrayName]("acme.my-plugin.greet-typo")],
          },
        })
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find(
          (i) =>
            (i as { params?: { errorCode?: string } }).params?.errorCode ===
            "action_id_undeclared_command"
        );
        expect(issue).toBeDefined();
        expect(issue?.path).toEqual(["contributes", arrayName, 0, "actionId"]);
      }
    }
  );

  it("rejects a contribution referencing a denyPluginDispatch built-in (issue #10580)", () => {
    // terminal.sendCommand exists as a built-in but is closed to plugin dispatch
    // — wiring a contribution to it paints a button the host will never fire.
    const result = schema.safeParse(
      manifestWith({
        contributes: {
          toolbarButtons: [contributionEntry.toolbarButtons("terminal.sendCommand")],
        },
      })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) =>
          (i as { params?: { errorCode?: string } }).params?.errorCode ===
          "action_id_plugin_dispatch_denied"
      );
      expect(issue).toBeDefined();
      expect(issue?.path).toEqual(["contributes", "toolbarButtons", 0, "actionId"]);
    }
  });

  it.each(CONTRIBUTION_ARRAYS)(
    "rejects a denyPluginDispatch built-in actionId contributed via %s",
    (arrayName) => {
      const result = schema.safeParse(
        manifestWith({
          contributes: { [arrayName]: [contributionEntry[arrayName]("fleet.accept")] },
        })
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find(
          (i) =>
            (i as { params?: { errorCode?: string } }).params?.errorCode ===
            "action_id_plugin_dispatch_denied"
        );
        expect(issue).toBeDefined();
        expect(issue?.path).toEqual(["contributes", arrayName, 0, "actionId"]);
      }
    }
  );

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
