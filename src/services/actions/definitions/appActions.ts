import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { SettingsNavTarget } from "@/components/Settings";
import { SettingsNavTargetSchema } from "./schemas";
import { z } from "zod";
import { appClient } from "@/clients";
import { useUserAgentRegistryStore } from "@/store/userAgentRegistryStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { keybindingService } from "@/services/KeybindingService";
import { actionService } from "@/services/ActionService";

async function refreshRendererConfig(): Promise<void> {
  await Promise.all([
    useUserAgentRegistryStore.getState().refresh(),
    useAgentSettingsStore.getState().refresh(),
    keybindingService.loadOverrides(),
  ]);
  actionService.dispatch("cliAvailability.refresh", undefined, { source: "agent" });
}

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
    argsSchema: SettingsNavTargetSchema,
    run: async (args: unknown) => {
      callbacks.onOpenSettingsTab(args as SettingsNavTarget);
    },
  }));

  actions.set("app.reloadConfig", () => ({
    id: "app.reloadConfig",
    title: "Reload Configuration",
    description:
      "Re-read config.json from disk and refresh all derived in-memory state (agent registry, agent settings, keybindings, CLI availability, application menu)",
    category: "app",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      // Main process reloads config and broadcasts APP_CONFIG_RELOADED,
      // which triggers the onConfigReloaded subscription below to refresh renderer stores.
      await window.electron.app.reloadConfig();
    },
  }));

  // Subscribe to config reloaded events from main process.
  // Fires after both action-triggered and menu-triggered reloads.
  if (
    typeof window !== "undefined" &&
    typeof window.electron?.app?.onConfigReloaded === "function"
  ) {
    window.electron.app.onConfigReloaded(async () => {
      try {
        await refreshRendererConfig();
      } catch (e) {
        console.error("[app.reloadConfig] Failed to refresh renderer config:", e);
      }
    });
  }

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
}
