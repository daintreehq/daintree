import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { SettingsTabSchema } from "./schemas";
import { z } from "zod";
import { appClient } from "@/clients";

export function registerAppActions(actions: ActionRegistry, callbacks: ActionCallbacks): void {
  actions.set("app.settings", () => ({
    id: "app.settings",
    title: "Open Settings",
    description: "Open the settings modal",
    category: "app",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      callbacks.onOpenSettings();
    },
  }));

  actions.set("app.settings.openTab", () => ({
    id: "app.settings.openTab",
    title: "Open Settings Tab",
    description: "Open a specific settings tab",
    category: "app",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ tab: SettingsTabSchema }),
    run: async (args: unknown) => {
      const { tab } = args as { tab: string };
      callbacks.onOpenSettingsTab(tab);
    },
  }));

  actions.set("app.developerMode.set", () => ({
    id: "app.developerMode.set",
    title: "Set Developer Mode",
    description: "Update developer mode settings",
    category: "app",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      enabled: z.boolean(),
      autoOpenDiagnostics: z.boolean().optional(),
      focusEventsTab: z.boolean().optional(),
    }),
    resultSchema: z.object({
      enabled: z.boolean(),
      showStateDebug: z.boolean(),
      autoOpenDiagnostics: z.boolean(),
      focusEventsTab: z.boolean(),
    }),
    run: async (args: unknown) => {
      const { enabled, autoOpenDiagnostics, focusEventsTab } = args as {
        enabled: boolean;
        autoOpenDiagnostics?: boolean;
        focusEventsTab?: boolean;
      };

      const appState = await appClient.getState();
      const current = appState?.developerMode ?? {
        enabled: false,
        showStateDebug: false,
        autoOpenDiagnostics: false,
        focusEventsTab: false,
      };

      const nextAutoOpenDiagnostics = enabled
        ? (autoOpenDiagnostics ?? current.autoOpenDiagnostics)
        : false;
      const nextFocusEventsTab =
        enabled && nextAutoOpenDiagnostics ? (focusEventsTab ?? current.focusEventsTab) : false;

      const next = {
        enabled,
        showStateDebug: current.showStateDebug ?? false,
        autoOpenDiagnostics: nextAutoOpenDiagnostics,
        focusEventsTab: nextFocusEventsTab,
      };

      await appClient.setState({ developerMode: next });
      return next;
    },
  }));

  // ============================================
}
