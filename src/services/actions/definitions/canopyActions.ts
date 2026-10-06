import type { ActionRegistry } from "../actionTypes";
import { useCanopyStore } from "@/store/canopyStore";

/** The canopy panel: every agent, read off its screen and laid out by what it needs. */
export function registerCanopyActions(actions: ActionRegistry): void {
  actions.set("canopy.toggle", () => ({
    id: "canopy.toggle",
    title: "Open Canopy",
    description:
      "Open or close Canopy, the bird's-eye view of every agent across all projects, read off its screen and ordered by what it needs from the user",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    keywords: ["canopy", "inbox", "agents", "waiting", "summary", "overview", "fleet"],
    run: async () => {
      useCanopyStore.getState().toggle();
    },
  }));
}
