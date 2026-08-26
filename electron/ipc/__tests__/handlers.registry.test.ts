import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp/test-user-data"),
    on: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: () => [],
    fromWebContents: vi.fn(),
  },
}));

const registerMocks = vi.hoisted(() => ({
  registerWorktreeHandlers: vi.fn(),
  registerTerminalHandlers: vi.fn(),
  registerFilesHandlers: vi.fn(),
  registerCopyTreeHandlers: vi.fn(),
  registerAiHandlers: vi.fn(),
  registerSlashCommandHandlers: vi.fn(),
  registerSystemShellHandlers: vi.fn(),
  registerEditorConfigHandlers: vi.fn(),
  registerWindowChromeHandlers: vi.fn(),
  registerPaintFabricSurfaceHandlers: vi.fn(),
  registerAgentCliHandlers: vi.fn(),
  registerProjectCrudHandlers: vi.fn(),
  registerProjectRelocationHandlers: vi.fn(),
  registerProjectRecipesHandlers: vi.fn(),
  registerProjectPresetsHandlers: vi.fn(),
  registerGlobalRecipesHandlers: vi.fn(),
  registerGlobalEnvHandlers: vi.fn(),
  registerTerminalLayoutHandlers: vi.fn(),
  registerProjectInRepoSettingsHandlers: vi.fn(),
  registerAppHandlers: vi.fn(),
  registerPortalHandlers: vi.fn(),
  registerMenuHandlers: vi.fn(),
  registerHibernationHandlers: vi.fn(),
  registerIdleTerminalHandlers: vi.fn(),
  registerSystemSleepHandlers: vi.fn(),
  registerAppVersionInfoHandlers: vi.fn(),
  registerOsDndHandlers: vi.fn(),
  registerKeybindingHandlers: vi.fn(),
  registerWorktreeConfigHandlers: vi.fn(),
  registerNotificationHandlers: vi.fn(),
  registerGeminiHandlers: vi.fn(),
  registerCodexHandlers: vi.fn(),
  registerEventsHandlers: vi.fn(),
  registerDevPreviewHandlers: vi.fn(),
  registerCommandHandlers: vi.fn(),
  registerAppAgentHandlers: vi.fn(),
  registerAgentCapabilitiesHandlers: vi.fn(),
  registerCliHandlers: vi.fn(),
  registerHelpHandlers: vi.fn(),
  registerClipboardHandlers: vi.fn(),
  registerGitWriteHandlers: vi.fn(),
  registerGitReadHandlers: vi.fn(),
  registerTelemetryHandlers: vi.fn(),
  registerPrivacyHandlers: vi.fn(),
  registerSentryHandlers: vi.fn(),
  registerOnboardingHandlers: vi.fn(),
  registerMilestonesHandlers: vi.fn(),
  registerShortcutHintsHandlers: vi.fn(),
  registerForgeSettingsHandlers: vi.fn(),
  registerForgeHandlers: vi.fn(),
  registerForgeDataHandlers: vi.fn(),
  registerForgeAuditHandlers: vi.fn(),
  registerVoiceInputHandlers: vi.fn(),
  registerMcpServerHandlers: vi.fn(),
  registerHelpAssistantHandlers: vi.fn(),
  registerWebviewHandlers: vi.fn(),
  registerWebviewNavigationHandlers: vi.fn(),
  registerWebviewCaptureHandlers: vi.fn(),
  registerDiagnosticsHandlers: vi.fn(),

  registerAccessibilityHandlers: vi.fn(),
  registerDemoHandlers: vi.fn(),
  registerRecoveryHandlers: vi.fn(),
  registerSafeModeHandlers: vi.fn(),
  registerPluginHandlers: vi.fn(),
  registerPluginMcpHandlers: vi.fn(),
  registerPerfHandlers: vi.fn(),
  registerConnectivityHandlers: vi.fn(),
  registerScratchHandlers: vi.fn(),
  registerWatchdogHandlers: vi.fn(),
}));

vi.mock("../handlers/worktree/index.js", () => ({
  registerWorktreeHandlers: registerMocks.registerWorktreeHandlers,
}));
vi.mock("../handlers/terminal/index.js", () => ({
  registerTerminalHandlers: registerMocks.registerTerminalHandlers,
}));
vi.mock("../handlers/files.js", () => ({
  registerFilesHandlers: registerMocks.registerFilesHandlers,
}));
vi.mock("../handlers/copyTree.js", () => ({
  registerCopyTreeHandlers: registerMocks.registerCopyTreeHandlers,
}));
vi.mock("../handlers/ai.js", () => ({
  registerAiHandlers: registerMocks.registerAiHandlers,
}));
vi.mock("../handlers/slashCommands.js", () => ({
  registerSlashCommandHandlers: registerMocks.registerSlashCommandHandlers,
}));
vi.mock("../handlers/systemShell.js", () => ({
  registerSystemShellHandlers: registerMocks.registerSystemShellHandlers,
}));
vi.mock("../handlers/editorConfig.js", () => ({
  registerEditorConfigHandlers: registerMocks.registerEditorConfigHandlers,
}));
vi.mock("../handlers/windowChrome.js", () => ({
  registerWindowChromeHandlers: registerMocks.registerWindowChromeHandlers,
}));
vi.mock("../handlers/paintFabricSurface.js", () => ({
  registerPaintFabricSurfaceHandlers: registerMocks.registerPaintFabricSurfaceHandlers,
}));
vi.mock("../handlers/agentCli.js", () => ({
  registerAgentCliHandlers: registerMocks.registerAgentCliHandlers,
}));
vi.mock("../handlers/projectCrud/index.js", () => ({
  registerProjectCrudHandlers: registerMocks.registerProjectCrudHandlers,
}));
vi.mock("../handlers/projectRelocation.js", () => ({
  registerProjectRelocationHandlers: registerMocks.registerProjectRelocationHandlers,
}));
vi.mock("../handlers/projectRecipes.js", () => ({
  registerProjectRecipesHandlers: registerMocks.registerProjectRecipesHandlers,
}));
vi.mock("../handlers/projectPresets.js", () => ({
  registerProjectPresetsHandlers: registerMocks.registerProjectPresetsHandlers,
}));
vi.mock("../handlers/globalRecipes.js", () => ({
  registerGlobalRecipesHandlers: registerMocks.registerGlobalRecipesHandlers,
}));
vi.mock("../handlers/globalEnv.js", () => ({
  registerGlobalEnvHandlers: registerMocks.registerGlobalEnvHandlers,
}));
vi.mock("../handlers/terminalLayout.js", () => ({
  registerTerminalLayoutHandlers: registerMocks.registerTerminalLayoutHandlers,
}));
vi.mock("../handlers/projectInRepoSettings.js", () => ({
  registerProjectInRepoSettingsHandlers: registerMocks.registerProjectInRepoSettingsHandlers,
}));
vi.mock("../handlers/app.js", () => ({
  registerAppHandlers: registerMocks.registerAppHandlers,
}));
vi.mock("../handlers/portal.js", () => ({
  registerPortalHandlers: registerMocks.registerPortalHandlers,
}));
vi.mock("../handlers/menu.js", () => ({
  registerMenuHandlers: registerMocks.registerMenuHandlers,
}));
vi.mock("../handlers/hibernation.js", () => ({
  registerHibernationHandlers: registerMocks.registerHibernationHandlers,
}));
vi.mock("../handlers/idleTerminals.js", () => ({
  registerIdleTerminalHandlers: registerMocks.registerIdleTerminalHandlers,
}));
vi.mock("../handlers/systemSleep.js", () => ({
  registerSystemSleepHandlers: registerMocks.registerSystemSleepHandlers,
}));
vi.mock("../handlers/appVersionInfo.js", () => ({
  registerAppVersionInfoHandlers: registerMocks.registerAppVersionInfoHandlers,
}));
vi.mock("../handlers/osDnd.js", () => ({
  registerOsDndHandlers: registerMocks.registerOsDndHandlers,
}));
vi.mock("../handlers/keybinding.js", () => ({
  registerKeybindingHandlers: registerMocks.registerKeybindingHandlers,
}));
vi.mock("../handlers/worktreeConfig.js", () => ({
  registerWorktreeConfigHandlers: registerMocks.registerWorktreeConfigHandlers,
}));
vi.mock("../handlers/notifications.js", () => ({
  registerNotificationHandlers: registerMocks.registerNotificationHandlers,
}));
vi.mock("../handlers/gemini.js", () => ({
  registerGeminiHandlers: registerMocks.registerGeminiHandlers,
}));
vi.mock("../handlers/codex.js", () => ({
  registerCodexHandlers: registerMocks.registerCodexHandlers,
}));
vi.mock("../handlers/events.js", () => ({
  registerEventsHandlers: registerMocks.registerEventsHandlers,
}));
vi.mock("../handlers/devPreview.js", () => ({
  registerDevPreviewHandlers: registerMocks.registerDevPreviewHandlers,
}));
vi.mock("../handlers/commands.js", () => ({
  registerCommandHandlers: registerMocks.registerCommandHandlers,
}));
vi.mock("../handlers/appAgent.js", () => ({
  registerAppAgentHandlers: registerMocks.registerAppAgentHandlers,
}));
vi.mock("../handlers/agentCapabilities.js", () => ({
  registerAgentCapabilitiesHandlers: registerMocks.registerAgentCapabilitiesHandlers,
}));
vi.mock("../handlers/cli.js", () => ({
  registerCliHandlers: registerMocks.registerCliHandlers,
}));
vi.mock("../handlers/help.js", () => ({
  registerHelpHandlers: registerMocks.registerHelpHandlers,
}));
vi.mock("../handlers/clipboard.js", () => ({
  registerClipboardHandlers: registerMocks.registerClipboardHandlers,
}));
vi.mock("../handlers/git-write.js", () => ({
  registerGitWriteHandlers: registerMocks.registerGitWriteHandlers,
}));
vi.mock("../handlers/git-read.js", () => ({
  registerGitReadHandlers: registerMocks.registerGitReadHandlers,
}));
vi.mock("../handlers/telemetry.js", () => ({
  registerTelemetryHandlers: registerMocks.registerTelemetryHandlers,
}));
vi.mock("../handlers/privacy.js", () => ({
  registerPrivacyHandlers: registerMocks.registerPrivacyHandlers,
}));
vi.mock("../handlers/sentry.js", () => ({
  registerSentryHandlers: registerMocks.registerSentryHandlers,
}));
vi.mock("../handlers/onboarding.js", () => ({
  registerOnboardingHandlers: registerMocks.registerOnboardingHandlers,
}));
vi.mock("../handlers/milestones.js", () => ({
  registerMilestonesHandlers: registerMocks.registerMilestonesHandlers,
}));
vi.mock("../handlers/shortcutHints.js", () => ({
  registerShortcutHintsHandlers: registerMocks.registerShortcutHintsHandlers,
}));
vi.mock("../handlers/forgeSettings.js", () => ({
  registerForgeSettingsHandlers: registerMocks.registerForgeSettingsHandlers,
}));
vi.mock("../handlers/forge.js", () => ({
  registerForgeHandlers: registerMocks.registerForgeHandlers,
}));
vi.mock("../handlers/forgeData.js", () => ({
  registerForgeDataHandlers: registerMocks.registerForgeDataHandlers,
}));
vi.mock("../handlers/forgeAudit.js", () => ({
  registerForgeAuditHandlers: registerMocks.registerForgeAuditHandlers,
}));
vi.mock("../handlers/voiceInput.js", () => ({
  registerVoiceInputHandlers: registerMocks.registerVoiceInputHandlers,
}));
vi.mock("../handlers/mcpServer.js", () => ({
  registerMcpServerHandlers: registerMocks.registerMcpServerHandlers,
}));
vi.mock("../handlers/helpAssistant.js", () => ({
  registerHelpAssistantHandlers: registerMocks.registerHelpAssistantHandlers,
}));
vi.mock("../handlers/webview.js", () => ({
  registerWebviewHandlers: registerMocks.registerWebviewHandlers,
}));
vi.mock("../handlers/webviewNavigation.js", () => ({
  registerWebviewNavigationHandlers: registerMocks.registerWebviewNavigationHandlers,
}));
vi.mock("../handlers/webviewCapture.js", () => ({
  registerWebviewCaptureHandlers: registerMocks.registerWebviewCaptureHandlers,
}));
vi.mock("../handlers/diagnostics.js", () => ({
  registerDiagnosticsHandlers: registerMocks.registerDiagnosticsHandlers,
}));
vi.mock("../handlers/accessibility.js", () => ({
  registerAccessibilityHandlers: registerMocks.registerAccessibilityHandlers,
}));
vi.mock("../handlers/demo.js", () => ({
  registerDemoHandlers: registerMocks.registerDemoHandlers,
}));
vi.mock("../handlers/recovery.js", () => ({
  registerRecoveryHandlers: registerMocks.registerRecoveryHandlers,
}));
vi.mock("../handlers/safeMode.js", () => ({
  registerSafeModeHandlers: registerMocks.registerSafeModeHandlers,
}));
vi.mock("../handlers/plugin.js", () => ({
  registerPluginHandlers: registerMocks.registerPluginHandlers,
}));
vi.mock("../handlers/pluginMcp.js", () => ({
  registerPluginMcpHandlers: registerMocks.registerPluginMcpHandlers,
}));
vi.mock("../handlers/perf.js", () => ({
  registerPerfHandlers: registerMocks.registerPerfHandlers,
}));
vi.mock("../handlers/connectivity.js", () => ({
  registerConnectivityHandlers: registerMocks.registerConnectivityHandlers,
}));
vi.mock("../handlers/scratch/index.js", () => ({
  registerScratchHandlers: registerMocks.registerScratchHandlers,
}));
vi.mock("../handlers/watchdog.js", () => ({
  registerWatchdogHandlers: registerMocks.registerWatchdogHandlers,
}));
vi.mock("../../services/events.js", () => ({
  events: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
}));

import { registerIpcHandlers } from "../handlers.js";

const allRegisterMocks: Mock[] = Object.values(registerMocks) as Mock[];

describe("registerIpcHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const register of allRegisterMocks) {
      register.mockImplementation(() => vi.fn());
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function registerWithTrackedCleanups(): Mock[] {
    const cleanups: Mock[] = [];
    for (const register of allRegisterMocks) {
      register.mockImplementation(() => {
        const cleanup = vi.fn();
        cleanups.push(cleanup);
        return cleanup;
      });
    }
    return cleanups;
  }

  it("registers every handler module exactly once", () => {
    registerIpcHandlers({} as never);

    for (const register of allRegisterMocks) {
      expect(register).toHaveBeenCalledTimes(1);
    }
  });

  it("cleans up already-registered handlers when registration fails mid-stream", () => {
    const cleanups = registerWithTrackedCleanups();
    registerMocks.registerAppHandlers.mockImplementation(() => {
      throw new Error("app registration failed");
    });

    expect(() => registerIpcHandlers({} as never)).toThrow("app registration failed");

    expect(cleanups.length).toBeGreaterThan(0);
    for (const cleanup of cleanups) {
      expect(cleanup).toHaveBeenCalledTimes(1);
    }
  });

  it("attempts every cleanup even if one throws", () => {
    const cleanups = registerWithTrackedCleanups();
    const cleanupAll = registerIpcHandlers({} as never);

    cleanups[0].mockImplementation(() => {
      throw new Error("cleanup failed");
    });

    expect(() => cleanupAll()).not.toThrow();
    for (const cleanup of cleanups) {
      expect(cleanup).toHaveBeenCalledTimes(1);
    }
  });
});
