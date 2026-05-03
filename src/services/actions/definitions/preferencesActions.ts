import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { AgentIdSchema, AgentSettingsEntrySchema } from "./schemas";
import { z } from "zod";
import {
  agentSettingsClient,
  appClient,
  hibernationClient,
  idleTerminalClient,
  terminalConfigClient,
  worktreeConfigClient,
} from "@/clients";
import { dispatchEscape } from "@/lib/escapeStack";
import { suppressSidebarResizes } from "@/lib/sidebarToggle";
import { notify } from "@/lib/notify";
import { actionService } from "@/services/ActionService";
import { keybindingService } from "@/services/KeybindingService";
import { useAgentPreferencesStore } from "@/store/agentPreferencesStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { useProjectStore } from "@/store/projectStore";
import { logError } from "@/utils/logger";
import { getDefaultAgentId } from "@/lib/resolveAgentId";
import { usePerformanceModeStore } from "@/store/performanceModeStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useScreenReaderStore } from "@/store/screenReaderStore";
import { useCachedProjectViewsStore } from "@/store/cachedProjectViewsStore";
import { useScrollbackStore } from "@/store/scrollbackStore";
import { useTerminalFontStore } from "@/store/terminalFontStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";

export function registerPreferencesActions(
  actions: ActionRegistry,
  callbacks: ActionCallbacks
): void {
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

  actions.set("window.toggleFullscreen", () => ({
    id: "window.toggleFullscreen",
    title: "Toggle Fullscreen",
    description: "Toggle fullscreen mode for the application window",
    category: "ui",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["maximize", "presentation", "immersive", "expand"],
    run: async () => {
      await window.electron.window.toggleFullscreen();
    },
  }));

  actions.set("window.reload", () => ({
    id: "window.reload",
    title: "Reload Window",
    description: "Reload the renderer via Electron webContents",
    category: "ui",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    keywords: ["refresh", "restart", "renderer", "soft"],
    run: async () => {
      await window.electron.window.reload();
    },
  }));

  actions.set("window.forceReload", () => ({
    id: "window.forceReload",
    title: "Force Reload Window",
    description: "Reload the renderer ignoring cache",
    category: "ui",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    keywords: ["refresh", "cache", "hard", "renderer"],
    run: async () => {
      await window.electron.window.forceReload();
    },
  }));

  actions.set("window.toggleDevTools", () => ({
    id: "window.toggleDevTools",
    title: "Toggle DevTools",
    description: "Toggle Electron DevTools for the current window",
    category: "ui",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    keywords: ["developer", "inspect", "console", "debug"],
    run: async () => {
      await window.electron.window.toggleDevTools();
    },
  }));

  actions.set("window.zoomIn", () => ({
    id: "window.zoomIn",
    title: "Zoom In",
    description: "Increase zoom level",
    category: "ui",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["larger", "increase", "scale", "magnify"],
    run: async () => {
      await window.electron.window.zoomIn();
    },
  }));

  actions.set("window.zoomOut", () => ({
    id: "window.zoomOut",
    title: "Zoom Out",
    description: "Decrease zoom level",
    category: "ui",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["smaller", "decrease", "scale", "shrink"],
    run: async () => {
      await window.electron.window.zoomOut();
    },
  }));

  actions.set("window.zoomReset", () => ({
    id: "window.zoomReset",
    title: "Reset Zoom",
    description: "Reset zoom level to default",
    category: "ui",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["default", "normal", "scale", "restore"],
    run: async () => {
      await window.electron.window.zoomReset();
    },
  }));

  actions.set("window.close", () => ({
    id: "window.close",
    title: "Close Window",
    description: "Close the current window",
    category: "ui",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    keywords: ["dismiss", "shut", "exit", "hide"],
    run: async () => {
      await window.electron.window.close();
    },
  }));

  actions.set("hibernation.getConfig", () => ({
    id: "hibernation.getConfig",
    title: "Get Hibernation Config",
    description: "Get auto-hibernation configuration",
    category: "settings",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      return await hibernationClient.getConfig();
    },
  }));

  actions.set("hibernation.updateConfig", () => ({
    id: "hibernation.updateConfig",
    title: "Update Hibernation Config",
    description: "Update auto-hibernation configuration",
    category: "settings",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      enabled: z.boolean().optional(),
      inactiveThresholdHours: z.number().int().positive().optional(),
    }),
    run: async (args: unknown) => {
      const config = args as { enabled?: boolean; inactiveThresholdHours?: number };
      return await hibernationClient.updateConfig(config);
    },
  }));

  actions.set("idleTerminalNotify.getConfig", () => ({
    id: "idleTerminalNotify.getConfig",
    title: "Get Idle Terminal Notification Config",
    description: "Get idle terminal notification configuration",
    category: "settings",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      return await idleTerminalClient.getConfig();
    },
  }));

  actions.set("idleTerminalNotify.updateConfig", () => ({
    id: "idleTerminalNotify.updateConfig",
    title: "Update Idle Terminal Notification Config",
    description: "Update idle terminal notification configuration",
    category: "settings",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      enabled: z.boolean().optional(),
      thresholdMinutes: z.number().int().positive().optional(),
    }),
    run: async (args: unknown) => {
      const config = args as { enabled?: boolean; thresholdMinutes?: number };
      return await idleTerminalClient.updateConfig(config);
    },
  }));

  actions.set("agentSettings.get", () => ({
    id: "agentSettings.get",
    title: "Get Agent Settings",
    description: "Get agent settings",
    category: "settings",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const settings = await agentSettingsClient.get();
      useAgentSettingsStore.setState({
        settings,
        isLoading: false,
        error: null,
        isInitialized: true,
      });
      return settings;
    },
  }));

  actions.set("agentSettings.set", () => ({
    id: "agentSettings.set",
    title: "Update Agent Settings",
    description: "Update settings for an agent",
    category: "settings",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    argsSchema: z.object({ agentId: z.string(), settings: AgentSettingsEntrySchema }),
    run: async (args: unknown) => {
      const { agentId, settings } = args as { agentId: string; settings: Record<string, unknown> };
      const updated = await agentSettingsClient.set(agentId, settings as any);
      useAgentSettingsStore.setState({
        settings: updated,
        isLoading: false,
        error: null,
        isInitialized: true,
      });
      return updated;
    },
  }));

  actions.set("agentSettings.reset", () => ({
    id: "agentSettings.reset",
    title: "Reset Agent Settings",
    description: "Reset settings for one agent or all agents",
    category: "settings",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    keywords: ["defaults", "restore", "clear", "agents"],
    argsSchema: z
      .object({
        agentId: z.string().optional(),
      })
      .optional(),
    run: async (args: unknown) => {
      const { agentId } = (args as { agentId?: string } | undefined) ?? {};
      const updated = await agentSettingsClient.reset(agentId);
      useAgentSettingsStore.setState({
        settings: updated,
        isLoading: false,
        error: null,
        isInitialized: true,
      });
      return updated;
    },
  }));

  actions.set("keybinding.getOverrides", () => ({
    id: "keybinding.getOverrides",
    title: "Get Keybinding Overrides",
    description: "Get configured keybinding overrides",
    category: "settings",
    kind: "query",
    danger: "safe",
    scope: "renderer",
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
    keywords: ["shortcuts", "hotkeys", "defaults", "restore"],
    run: async () => {
      await keybindingService.resetAllOverrides();
      return keybindingService.getOverridesSnapshot();
    },
  }));

  actions.set("terminalConfig.get", () => ({
    id: "terminalConfig.get",
    title: "Get Terminal Config",
    description: "Get persisted terminal configuration",
    category: "settings",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      return await terminalConfigClient.get();
    },
  }));

  actions.set("terminalConfig.setScrollback", () => ({
    id: "terminalConfig.setScrollback",
    title: "Set Scrollback",
    description: "Set terminal scrollback lines",
    category: "settings",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ scrollbackLines: z.number().int().min(100).max(10000) }),
    run: async (args: unknown) => {
      const { scrollbackLines } = args as { scrollbackLines: number };
      const state = useScrollbackStore.getState();
      const previous = state.scrollbackLines;
      state.setScrollbackLines(scrollbackLines);

      try {
        await terminalConfigClient.setScrollback(scrollbackLines);
      } catch (error) {
        state.setScrollbackLines(previous);
        throw error;
      }
    },
  }));

  actions.set("terminalConfig.setPerformanceMode", () => ({
    id: "terminalConfig.setPerformanceMode",
    title: "Set Performance Mode",
    description: "Enable or disable performance mode",
    category: "settings",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ performanceMode: z.boolean() }),
    run: async (args: unknown) => {
      const { performanceMode } = args as { performanceMode: boolean };
      const state = usePerformanceModeStore.getState();
      const previous = state.performanceMode;
      state.setPerformanceMode(performanceMode);

      try {
        await terminalConfigClient.setPerformanceMode(performanceMode);
      } catch (error) {
        state.setPerformanceMode(previous);
        throw error;
      }
    },
  }));

  actions.set("terminalConfig.setFontSize", () => ({
    id: "terminalConfig.setFontSize",
    title: "Set Terminal Font Size",
    description: "Set terminal font size",
    category: "settings",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ fontSize: z.number().int().min(8).max(48) }),
    run: async (args: unknown) => {
      const { fontSize } = args as { fontSize: number };
      const state = useTerminalFontStore.getState();
      const previous = state.fontSize;
      state.setFontSize(fontSize);

      try {
        await terminalConfigClient.setFontSize(fontSize);
      } catch (error) {
        state.setFontSize(previous);
        throw error;
      }
    },
  }));

  actions.set("terminalConfig.setFontFamily", () => ({
    id: "terminalConfig.setFontFamily",
    title: "Set Terminal Font Family",
    description: "Set terminal font family",
    category: "settings",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ fontFamily: z.string().min(1) }),
    run: async (args: unknown) => {
      const { fontFamily } = args as { fontFamily: string };
      const state = useTerminalFontStore.getState();
      const previous = state.fontFamily;
      state.setFontFamily(fontFamily);

      try {
        await terminalConfigClient.setFontFamily(fontFamily);
      } catch (error) {
        state.setFontFamily(previous);
        throw error;
      }
    },
  }));

  actions.set("terminalConfig.setHybridInputEnabled", () => ({
    id: "terminalConfig.setHybridInputEnabled",
    title: "Set Hybrid Input Enabled",
    description: "Enable or disable the hybrid input bar",
    category: "settings",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ enabled: z.boolean() }),
    run: async (args: unknown) => {
      const { enabled } = args as { enabled: boolean };
      const state = useTerminalInputStore.getState();
      const previous = state.hybridInputEnabled;
      state.setHybridInputEnabled(enabled);

      try {
        await terminalConfigClient.setHybridInputEnabled(enabled);
      } catch (error) {
        state.setHybridInputEnabled(previous);
        throw error;
      }
    },
  }));

  actions.set("terminalConfig.setHybridInputAutoFocus", () => ({
    id: "terminalConfig.setHybridInputAutoFocus",
    title: "Set Hybrid Input Auto Focus",
    description: "Enable or disable auto-focus for the hybrid input bar",
    category: "settings",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ enabled: z.boolean() }),
    run: async (args: unknown) => {
      const { enabled } = args as { enabled: boolean };
      const state = useTerminalInputStore.getState();
      const previous = state.hybridInputAutoFocus;
      state.setHybridInputAutoFocus(enabled);

      try {
        await terminalConfigClient.setHybridInputAutoFocus(enabled);
      } catch (error) {
        state.setHybridInputAutoFocus(previous);
        throw error;
      }
    },
  }));

  actions.set("terminalConfig.setScreenReaderMode", () => ({
    id: "terminalConfig.setScreenReaderMode",
    title: "Set Screen Reader Mode",
    description: "Set screen reader mode for terminals (auto, on, or off)",
    category: "settings",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ mode: z.enum(["auto", "on", "off"]) }),
    run: async (args: unknown) => {
      const { mode } = args as { mode: "auto" | "on" | "off" };
      const state = useScreenReaderStore.getState();
      const previous = state.screenReaderMode;
      state.setScreenReaderMode(mode);

      try {
        await terminalConfigClient.setScreenReaderMode(mode);
      } catch (error) {
        state.setScreenReaderMode(previous);
        throw error;
      }
    },
  }));

  actions.set("terminalConfig.setCachedProjectViews", () => ({
    id: "terminalConfig.setCachedProjectViews",
    title: "Set Cached Project Views",
    description: "Set the number of project views to keep cached in memory (1–5)",
    category: "settings",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ cachedProjectViews: z.number().int().min(1).max(5) }),
    run: async (args: unknown) => {
      const { cachedProjectViews } = args as { cachedProjectViews: number };
      const state = useCachedProjectViewsStore.getState();
      const previous = state.cachedProjectViews;
      state.setCachedProjectViews(cachedProjectViews);

      try {
        await terminalConfigClient.setCachedProjectViews(cachedProjectViews);
      } catch (error) {
        state.setCachedProjectViews(previous);
        throw error;
      }
    },
  }));

  actions.set("worktreeConfig.get", () => ({
    id: "worktreeConfig.get",
    title: "Get Worktree Config",
    description: "Get worktree configuration",
    category: "settings",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      return await worktreeConfigClient.get();
    },
  }));

  actions.set("worktreeConfig.setPattern", () => ({
    id: "worktreeConfig.setPattern",
    title: "Set Worktree Path Pattern",
    description: "Update the default worktree path pattern",
    category: "settings",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ pattern: z.string().min(1) }),
    run: async (args: unknown) => {
      const { pattern } = args as { pattern: string };
      return await worktreeConfigClient.setPattern(pattern);
    },
  }));

  actions.set("help.shortcuts", () => ({
    id: "help.shortcuts",
    title: "Keyboard Shortcuts",
    description: "Show keyboard shortcuts reference",
    category: "help",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["hotkeys", "keys", "reference", "bindings"],
    run: async () => {
      callbacks.onOpenShortcuts();
    },
  }));

  actions.set("help.shortcutsAlt", () => ({
    id: "help.shortcutsAlt",
    title: "Keyboard Shortcuts (Alt)",
    description: "Show keyboard shortcuts reference",
    category: "help",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["hotkeys", "keys", "reference", "bindings"],
    run: async () => {
      callbacks.onOpenShortcuts();
    },
  }));

  actions.set("help.launchAgent", () => ({
    id: "help.launchAgent",
    title: "Launch Help Agent",
    description: "Open an AI agent in the help workspace folder",
    category: "help",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["assistant", "support", "docs", "guide"],
    argsSchema: z.object({ agentId: AgentIdSchema.optional() }).optional(),
    run: async (args?: unknown) => {
      const folderPath = await window.electron.help.getFolderPath();
      if (!folderPath) {
        notify({
          type: "error",
          title: "Help Agent",
          message: "Help folder not available. Please ensure the help workspace is configured.",
        });
        return;
      }

      const parsed = args as { agentId?: string } | undefined;
      let agentId: string;
      if (parsed?.agentId) {
        agentId = parsed.agentId;
      } else {
        const { defaultAgent } = useAgentPreferencesStore.getState();
        const { availability, isInitialized } = useCliAvailabilityStore.getState();
        const resolved = isInitialized
          ? getDefaultAgentId(defaultAgent, undefined, availability)
          : null;
        agentId = resolved ?? "claude";
      }

      const helpPrompt =
        "I need help with Daintree, an Electron-based IDE for orchestrating AI coding agents. Please briefly tell me how you can help.";

      const project = useProjectStore.getState().currentProject;
      let session: Awaited<ReturnType<typeof window.electron.help.provisionSession>> | null = null;
      if (project) {
        try {
          session = await window.electron.help.provisionSession({
            projectId: project.id,
            projectPath: project.path,
          });
        } catch (err) {
          logError("Failed to provision help session", err);
        }
      }

      const cwd = session?.sessionPath ?? folderPath;
      const env: Record<string, string> | undefined = session
        ? {
            DAINTREE_MCP_TOKEN: session.token,
            DAINTREE_WINDOW_ID: String(session.windowId),
            ...(session.mcpUrl ? { DAINTREE_MCP_URL: session.mcpUrl } : {}),
            ...(project ? { DAINTREE_PROJECT_ID: project.id } : {}),
          }
        : undefined;

      const result = await actionService.dispatch<{ terminalId: string | null }>(
        "agent.launch",
        {
          agentId,
          cwd,
          location: "dock",
          prompt: helpPrompt,
          ephemeral: true,
          ...(env && { env }),
        },
        { source: "user" }
      );

      // Store the terminal in the help panel
      if (result.ok && result.result?.terminalId) {
        useHelpPanelStore
          .getState()
          .setTerminal(result.result.terminalId, agentId, session?.sessionId ?? null);
        if (!useHelpPanelStore.getState().isOpen) {
          suppressSidebarResizes();
          useHelpPanelStore.getState().setOpen(true);
        }
        window.electron.help.markTerminal(result.result.terminalId).catch(() => {});
      } else if (session) {
        window.electron.help.revokeSession(session.sessionId).catch((err) => {
          logError("Failed to revoke help session after failed launch", err);
        });
      }
    },
  }));

  actions.set("help.togglePanel", () => ({
    id: "help.togglePanel",
    title: "Toggle Help Panel",
    description: "Show or hide the help panel",
    category: "help",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["docs", "support", "guide", "assistant"],
    run: async () => {
      suppressSidebarResizes();
      useHelpPanelStore.getState().toggle();
    },
  }));

  actions.set("modal.close", () => ({
    id: "modal.close",
    title: "Close Modal",
    description: "Close the active modal or dialog",
    category: "app",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["dismiss", "escape", "dialog", "overlay"],
    nonRepeatable: true,
    run: async () => {
      dispatchEscape();
    },
  }));

  actions.set("app.quit", () => ({
    id: "app.quit",
    title: "Quit App",
    description: "Quit Daintree",
    category: "app",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    keywords: ["exit", "close", "shutdown", "leave"],
    run: async () => {
      await appClient.quit();
    },
  }));

  actions.set("app.forceQuit", () => ({
    id: "app.forceQuit",
    title: "Force Quit App",
    description: "Force quit Daintree immediately (no graceful shutdown)",
    category: "app",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    keywords: ["exit", "kill", "shutdown", "terminate"],
    run: async () => {
      await appClient.forceQuit();
    },
  }));
}
