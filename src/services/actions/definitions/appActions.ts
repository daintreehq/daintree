import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { SettingsNavTarget } from "@/components/Settings";
import { SettingsNavTargetSchema } from "./schemas";
import { z } from "zod";
import { appClient } from "@/clients";
import { appThemeClient } from "@/clients/appThemeClient";
import { useUserAgentRegistryStore } from "@/store/userAgentRegistryStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useAppThemeStore } from "@/store/appThemeStore";
import { notify } from "@/lib/notify";
import { keybindingService } from "@/services/KeybindingService";
import { actionService } from "@/services/ActionService";
import { getBuiltInAppSchemeForType, resolveAppTheme } from "@shared/theme";
import { logError } from "@/utils/logger";

async function refreshRendererConfig(): Promise<void> {
  await Promise.all([
    useUserAgentRegistryStore.getState().refresh(),
    useAgentSettingsStore.getState().refresh(),
    keybindingService.loadOverrides(),
  ]);
  actionService.dispatch("cliAvailability.refresh", undefined, { source: "agent" });
}

interface AppConfigReloadListenerState {
  refresh: (() => Promise<void>) | null;
  subscribed: boolean;
}

const APP_CONFIG_RELOAD_LISTENER_STATE_KEY = "__daintreeAppConfigReloadListenerState";

function getAppConfigReloadListenerState(): AppConfigReloadListenerState {
  const target = globalThis as typeof globalThis & {
    [APP_CONFIG_RELOAD_LISTENER_STATE_KEY]?: AppConfigReloadListenerState;
  };
  const existing = target[APP_CONFIG_RELOAD_LISTENER_STATE_KEY];
  if (existing) {
    return existing;
  }

  const created: AppConfigReloadListenerState = {
    refresh: null,
    subscribed: false,
  };
  target[APP_CONFIG_RELOAD_LISTENER_STATE_KEY] = created;
  return created;
}

export function registerAppActions(actions: ActionRegistry, callbacks: ActionCallbacks): void {
  actions.set("app.newWindow", () => ({
    id: "app.newWindow",
    title: "New Window",
    description: "Open a new Daintree window",
    category: "app",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ projectPath: z.string().optional() }).optional(),
    run: async (args: unknown) => {
      const projectPath = (args as { projectPath?: string } | undefined)?.projectPath;
      await window.electron.window.openNew(projectPath);
    },
  }));

  actions.set("app.settings", () => ({
    id: "app.settings",
    title: "Open Settings",
    description: "Open the settings modal",
    category: "app",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
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
    nonRepeatable: true,
    run: async (args: unknown) => {
      callbacks.onOpenSettingsTab(args as SettingsNavTarget);
    },
  }));

  actions.set("app.reloadConfig", () => ({
    id: "app.reloadConfig",
    title: "Reload Configuration",
    description: "Reload config from disk and refresh agent, keybinding, CLI, and menu state.",
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
  // Dedup across repeated register calls and module reloads (tests/HMR)
  // while keeping the active refresh implementation hot-swappable.
  const listenerState = getAppConfigReloadListenerState();
  listenerState.refresh = async () => {
    try {
      await refreshRendererConfig();
    } catch (e) {
      logError("[app.reloadConfig] Failed to refresh renderer config", e);
    }
  };
  if (
    !listenerState.subscribed &&
    typeof window !== "undefined" &&
    typeof window.electron?.app?.onConfigReloaded === "function"
  ) {
    listenerState.subscribed = true;
    window.electron.app.onConfigReloaded(async () => {
      await listenerState.refresh?.();
    });
  }

  actions.set("app.theme.pick", () => ({
    id: "app.theme.pick",
    title: "Pick Theme...",
    description: "Open the theme palette to browse and preview themes",
    category: "app",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    run: async () => {
      window.dispatchEvent(new CustomEvent("daintree:open-theme-palette"));
    },
  }));

  actions.set("app.theme.browser.open", () => ({
    id: "app.theme.browser.open",
    title: "Change Theme...",
    description: "Open the theme browser to preview and commit a new theme",
    category: "app",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    run: async () => {
      window.dispatchEvent(new CustomEvent("daintree:open-theme-browser"));
    },
  }));

  actions.set("app.theme.toggle", () => ({
    id: "app.theme.toggle",
    title: "Toggle Dark/Light Theme",
    description: "Switch between preferred dark and light themes",
    category: "app",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const {
        selectedSchemeId,
        customSchemes,
        preferredDarkSchemeId,
        preferredLightSchemeId,
        setSelectedSchemeId,
      } = useAppThemeStore.getState();
      const current = resolveAppTheme(selectedSchemeId, customSchemes);
      const targetType: "dark" | "light" = current.type === "light" ? "dark" : "light";
      const preferredTargetId =
        targetType === "dark" ? preferredDarkSchemeId : preferredLightSchemeId;
      let target = resolveAppTheme(preferredTargetId, customSchemes);
      // resolveAppTheme silently falls back to BUILT_IN_APP_SCHEMES[0] when the
      // preferred ID points to a deleted scheme, which may be the wrong type.
      // Guarantee we always land on a scheme of the opposite type.
      if (target.type !== targetType) {
        target = getBuiltInAppSchemeForType(targetType);
      }
      if (target.id === selectedSchemeId) return;
      setSelectedSchemeId(target.id);
      try {
        await appThemeClient.setColorScheme(target.id);
      } catch (error) {
        logError("Failed to persist theme toggle", error);
        notify({
          type: "error",
          priority: "high",
          message: `Failed to save theme: ${target.name}`,
          duration: 3000,
        });
        return;
      }
      notify({
        type: "info",
        priority: "high",
        message: `Theme: ${target.name}`,
        duration: 2000,
        // Confirmation of a user-triggered toggle — the user already knows; no
        // need to bump the unread badge in the notification center.
        countable: false,
      });
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
}
