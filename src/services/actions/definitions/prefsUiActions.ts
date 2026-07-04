import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { usePreferencesStore } from "@/store/preferencesStore";

export function registerPrefsUiActions(actions: ActionRegistry, _callbacks: ActionCallbacks): void {
  actions.set("preferences.showProjectPulse.set", () => ({
    id: "preferences.showProjectPulse.set",
    title: "Set Project Pulse Visibility",
    description: "Show or hide the project pulse panel",
    category: "preferences",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ show: z.boolean() }),
    safeBreadcrumbArgs: ["show"],
    run: async (args: unknown) => {
      const { show } = args as { show: boolean };
      usePreferencesStore.getState().setShowProjectPulse(show);
    },
  }));

  actions.set("preferences.showDeveloperTools.set", () => ({
    id: "preferences.showDeveloperTools.set",
    title: "Set Developer Tools Visibility",
    description: "Show or hide developer tools in the UI",
    category: "preferences",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ show: z.boolean() }),
    safeBreadcrumbArgs: ["show"],
    run: async (args: unknown) => {
      const { show } = args as { show: boolean };
      usePreferencesStore.getState().setShowDeveloperTools(show);
    },
  }));

  actions.set("preferences.showGridAgentHighlights.set", () => ({
    id: "preferences.showGridAgentHighlights.set",
    title: "Set Grid Agent Highlights Visibility",
    description: "Show or hide agent state borders on grid panels",
    category: "preferences",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ show: z.boolean() }),
    run: async (args: unknown) => {
      const { show } = args as { show: boolean };
      usePreferencesStore.getState().setShowGridAgentHighlights(show);
    },
  }));

  actions.set("preferences.showDockAgentHighlights.set", () => ({
    id: "preferences.showDockAgentHighlights.set",
    title: "Set Dock Agent Highlights Visibility",
    description: "Show or hide agent state borders on dock items",
    category: "preferences",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ show: z.boolean() }),
    run: async (args: unknown) => {
      const { show } = args as { show: boolean };
      usePreferencesStore.getState().setShowDockAgentHighlights(show);
    },
  }));

  actions.set("preferences.showAgentTaskTitles.set", () => ({
    id: "preferences.showAgentTaskTitles.set",
    title: "Set Agent Task Titles Visibility",
    description: "Compose the agent's current task into terminal tab and header titles",
    category: "preferences",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ show: z.boolean() }),
    run: async (args: unknown) => {
      const { show } = z.object({ show: z.boolean() }).parse(args);
      usePreferencesStore.getState().setShowAgentTaskTitles(show);
    },
  }));

  actions.set("preferences.reduceAnimations.set", () => ({
    id: "preferences.reduceAnimations.set",
    title: "Set Reduce UI Animations",
    description: "Minimize motion across the interface, independent of OS settings",
    category: "preferences",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ value: z.boolean() }),
    run: async (args: unknown) => {
      const { value } = args as { value: boolean };
      usePreferencesStore.getState().setReduceAnimations(value);
    },
  }));
}
