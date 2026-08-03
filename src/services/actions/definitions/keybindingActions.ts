import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { keybindingService } from "@/services/KeybindingService";

export function registerKeybindingActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  actions.set("keybinding.getOverrides", () => ({
    id: "keybinding.getOverrides",
    title: "Get Keybinding Overrides",
    description:
      "Read the keyboard shortcuts the user has deliberately customised. Only explicit overrides are included — the built-in defaults are not — so an empty result means the user has customised nothing, not that no shortcuts exist.",
    category: "settings",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    resultSchema: z.record(z.string(), z.array(z.string())),
    run: async () => {
      await keybindingService.loadOverrides();
      return keybindingService.getOverridesSnapshot();
    },
  }));

  actions.set("keybinding.setOverride", () => ({
    id: "keybinding.setOverride",
    title: "Set Keybinding Override",
    description: "Set keybinding override for an action",
    category: "settings",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ actionId: z.string(), combo: z.array(z.string()) }),
    run: async (args: unknown) => {
      const { actionId, combo } = args as { actionId: string; combo: string[] };
      await keybindingService.setOverride(actionId, combo);
      return keybindingService.getOverridesSnapshot();
    },
  }));

  actions.set("keybinding.removeOverride", () => ({
    id: "keybinding.removeOverride",
    title: "Remove Keybinding Override",
    description: "Remove keybinding override for an action",
    category: "settings",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ actionId: z.string() }),
    run: async (args: unknown) => {
      const { actionId } = args as { actionId: string };
      await keybindingService.removeOverride(actionId);
      return keybindingService.getOverridesSnapshot();
    },
  }));

  actions.set("keybinding.resetAll", () => ({
    id: "keybinding.resetAll",
    title: "Reset All Keybinding Overrides",
    description: "Reset all keybinding overrides",
    category: "settings",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    // danger:"confirm" with the confirm wired at the KeyboardShortcutsTab call
    // site, NOT in run() — ActionService doesn't gate user-source dispatch, so a
    // palette pick would wipe every custom shortcut with no confirmation. Hide
    // from the palette; it stays reachable from Settings (with confirm).
    palette: { mode: "hidden" },
    dangerRationale:
      "Resets all keybinding overrides to defaults. All custom shortcuts are permanently lost.",
    keywords: ["shortcuts", "hotkeys", "defaults", "restore"],
    mcpAnnotations: { openWorldHint: false },
    run: async () => {
      await keybindingService.resetAllOverrides();
      return keybindingService.getOverridesSnapshot();
    },
  }));
}
