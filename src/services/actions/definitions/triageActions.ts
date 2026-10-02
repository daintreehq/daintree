import type { ActionRegistry } from "../actionTypes";
import { useTriageStore } from "@/store/triageStore";

/** The triage panel: every agent, read off its screen and laid out by what it needs. */
export function registerTriageActions(actions: ActionRegistry): void {
  actions.set("triage.toggle", () => ({
    id: "triage.toggle",
    title: "Triage agents",
    description:
      "Open or close the triage panel: every agent across all projects, read off its screen and ordered by what it needs from the user",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    keywords: ["triage", "agents", "waiting", "summary", "overview", "fleet"],
    run: async () => {
      useTriageStore.getState().toggle();
    },
  }));
}
