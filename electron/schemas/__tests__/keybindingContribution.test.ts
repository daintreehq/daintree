import { describe, it, expect } from "vitest";
import { KeybindingContributionSchema, getPluginManifestSchema } from "../plugin.js";
import {
  RETIRED_PLUGIN_KEYBINDING_SCOPES,
  isRetiredPluginKeybindingScope,
} from "../../../shared/config/pluginKeybindingScopes.js";

const base = { actionId: "acme.plugin.action", combo: "Cmd+Shift+9" };

function scopeError(scope: string): string | undefined {
  const result = KeybindingContributionSchema.safeParse({ ...base, scope });
  if (result.success) return undefined;
  return result.error.issues.map((i) => i.message).join("\n");
}

describe("KeybindingContributionSchema scope", () => {
  it("accepts every live scope and an omitted one, none of them retired", () => {
    expect(KeybindingContributionSchema.safeParse(base).success).toBe(true);
    for (const scope of ["global", "worktreeGrid", "dev-preview"]) {
      expect(KeybindingContributionSchema.safeParse({ ...base, scope }).success).toBe(true);
      expect(isRetiredPluginKeybindingScope(scope)).toBe(false);
    }
  });

  it("keeps every retired scope declarable, and an omitted scope is never retired", () => {
    for (const scope of RETIRED_PLUGIN_KEYBINDING_SCOPES) {
      expect(KeybindingContributionSchema.safeParse({ ...base, scope }).success).toBe(true);
      expect(isRetiredPluginKeybindingScope(scope)).toBe(true);
    }
    expect(isRetiredPluginKeybindingScope("portal")).toBe(true);
    expect(isRetiredPluginKeybindingScope(undefined)).toBe(false);
  });

  it("parses a whole manifest that binds a key in the retired portal scope (#17245)", () => {
    for (const origin of ["user", "project"] as const) {
      const result = getPluginManifestSchema(origin).safeParse({
        name: "acme.plugin",
        version: "1.0.0",
        ...(origin === "project" ? { scope: "project" } : {}),
        contributes: { keybindings: [{ ...base, actionId: "nav.quickSwitcher", scope: "portal" }] },
      });
      expect(result.success).toBe(true);
      expect(result.data?.contributes.keybindings[0]?.scope).toBe("portal");
    }
  });

  it("parses a manifest naming a retired built-in action, alongside a live contribution (#17256)", () => {
    const result = getPluginManifestSchema("user").safeParse({
      name: "acme.plugin",
      version: "1.0.0",
      contributes: {
        keybindings: [
          { actionId: "portal.closeTab", combo: "Cmd+W", scope: "portal" },
          { actionId: "nav.quickSwitcher", combo: "Cmd+Shift+9" },
        ],
        toolbarButtons: [{ id: "chat", label: "Chat", iconId: "globe", actionId: "portal.toggle" }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("still rejects a built-in-looking id that never existed", () => {
    const result = getPluginManifestSchema("user").safeParse({
      name: "acme.plugin",
      version: "1.0.0",
      contributes: { keybindings: [{ actionId: "portal.nonsense", combo: "Cmd+Shift+9" }] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects the removed scopes with migration hints", () => {
    expect(scopeError("terminal")).toContain('when: "terminalFocused"');
    expect(scopeError("modal")).toContain('when: "modalOpen"');
    expect(scopeError("worktreeList")).toContain("not bindable");
  });

  it("rejects unknown scopes with the default enum error", () => {
    const message = scopeError("galaxy");
    expect(message).toBeDefined();
    expect(message).not.toContain("was removed");
  });
});
