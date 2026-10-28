import type { ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";
import { applyPluginLayout } from "@/services/layout/applyPluginLayout";

export function registerLayoutActions(actions: ActionRegistry): void {
  // The palette offers one row per layout (`usePluginLayouts`), so this id is
  // the entry point a plugin's own command dispatches. Agents are refused in
  // `applyPluginLayout`, not only left unlisted.
  actions.set("layout.apply", () =>
    defineAction({
      id: "layout.apply",
      title: "Apply layout",
      description:
        "Open or move the panels a plugin's named layout lists, leaving every other panel where it is. A layout that runs a recipe asks the user first. A plugin applies only its own layouts. Undo with layout.undo.",
      category: "panel",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      palette: { mode: "hidden" },
      mcpVisibility: "hidden",
      nonRepeatable: true,
      argsSchema: z.object({
        layoutId: z
          .string()
          .min(1)
          .describe("The layout's id: the plugin's own manifest id, or the qualified one."),
      }),
      run: async ({ layoutId }, ctx) => applyPluginLayout(layoutId, ctx),
    })
  );
}
