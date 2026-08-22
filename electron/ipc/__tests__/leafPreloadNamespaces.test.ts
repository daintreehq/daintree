import { describe, expect, it, vi } from "vitest";

import { CHANNELS } from "../channels.js";
import {
  SLASH_COMMANDS_METHOD_CHANNELS,
  buildSlashCommandsPreloadBindings,
} from "../handlers/slashCommands.preload.js";
import {
  GLOBAL_ENV_METHOD_CHANNELS,
  buildGlobalEnvPreloadBindings,
} from "../handlers/globalEnv.preload.js";
import { HELP_METHOD_CHANNELS, buildHelpPreloadBindings } from "../handlers/help.preload.js";
import {
  ACCESSIBILITY_METHOD_CHANNELS,
  buildAccessibilityPreloadBindings,
} from "../handlers/accessibility.preload.js";
import {
  EVENT_INSPECTOR_METHOD_CHANNELS,
  buildEventInspectorPreloadBindings,
} from "../handlers/eventInspector.preload.js";
import {
  COMMANDS_METHOD_CHANNELS,
  buildCommandsPreloadBindings,
} from "../handlers/commands.preload.js";
import { PORTAL_METHOD_CHANNELS, buildPortalPreloadBindings } from "../handlers/portal.preload.js";
import {
  DEV_PREVIEW_METHOD_CHANNELS,
  buildDevPreviewPreloadBindings,
} from "../handlers/devPreview.preload.js";
import { PLUGIN_METHOD_CHANNELS, buildPluginPreloadBindings } from "../handlers/plugin.preload.js";
import {
  SCRATCH_METHOD_CHANNELS,
  buildScratchPreloadBindings,
} from "../handlers/scratch/preload.js";
import { SENTRY_METHOD_CHANNELS, buildSentryPreloadBindings } from "../handlers/sentry.preload.js";
import {
  MILESTONES_METHOD_CHANNELS,
  buildMilestonesPreloadBindings,
} from "../handlers/milestones.preload.js";
import {
  SHORTCUT_HINTS_METHOD_CHANNELS,
  buildShortcutHintsPreloadBindings,
} from "../handlers/shortcutHints.preload.js";
import {
  FORGE_RECOMMENDATION_METHOD_CHANNELS,
  buildForgeRecommendationPreloadBindings,
} from "../handlers/forgeRecommendation.preload.js";
import { CLI_METHOD_CHANNELS, buildCliPreloadBindings } from "../handlers/cli.preload.js";
import { GEMINI_METHOD_CHANNELS, buildGeminiPreloadBindings } from "../handlers/gemini.preload.js";
import {
  AGENT_CAPABILITIES_METHOD_CHANNELS,
  buildAgentCapabilitiesPreloadBindings,
} from "../handlers/agentCapabilities.preload.js";
import {
  GLOBAL_RECIPES_METHOD_CHANNELS,
  buildGlobalRecipesPreloadBindings,
} from "../handlers/globalRecipes.preload.js";
import {
  CONNECTIVITY_METHOD_CHANNELS,
  buildConnectivityPreloadBindings,
} from "../handlers/connectivity.preload.js";
import {
  PRIVACY_METHOD_CHANNELS,
  buildPrivacyPreloadBindings,
} from "../handlers/privacy.preload.js";
import {
  ONBOARDING_METHOD_CHANNELS,
  buildOnboardingPreloadBindings,
} from "../handlers/onboarding.preload.js";

describe("leaf preload namespace bindings", () => {
  describe("METHOD_CHANNELS stay in sync with CHANNELS", () => {
    it("slashCommands matches", () => {
      expect(SLASH_COMMANDS_METHOD_CHANNELS.list).toBe(CHANNELS.SLASH_COMMANDS_LIST);
    });

    it("globalEnv matches", () => {
      expect(GLOBAL_ENV_METHOD_CHANNELS.get).toBe(CHANNELS.GLOBAL_ENV_GET);
      expect(GLOBAL_ENV_METHOD_CHANNELS.set).toBe(CHANNELS.GLOBAL_ENV_SET);
    });

    it("help matches", () => {
      expect(HELP_METHOD_CHANNELS.getFolderPath).toBe(CHANNELS.HELP_GET_FOLDER_PATH);
      expect(HELP_METHOD_CHANNELS.markTerminal).toBe(CHANNELS.HELP_MARK_TERMINAL);
      expect(HELP_METHOD_CHANNELS.unmarkTerminal).toBe(CHANNELS.HELP_UNMARK_TERMINAL);
      expect(HELP_METHOD_CHANNELS.getPinnedActionContext).toBe(
        CHANNELS.HELP_GET_PINNED_ACTION_CONTEXT
      );
    });

    it("accessibility matches", () => {
      expect(ACCESSIBILITY_METHOD_CHANNELS.getEnabled).toBe(CHANNELS.ACCESSIBILITY_GET_ENABLED);
    });

    it("eventInspector matches", () => {
      expect(EVENT_INSPECTOR_METHOD_CHANNELS.getEvents).toBe(CHANNELS.EVENT_INSPECTOR_GET_EVENTS);
      expect(EVENT_INSPECTOR_METHOD_CHANNELS.getFiltered).toBe(
        CHANNELS.EVENT_INSPECTOR_GET_FILTERED
      );
      expect(EVENT_INSPECTOR_METHOD_CHANNELS.clear).toBe(CHANNELS.EVENT_INSPECTOR_CLEAR);
    });

    it("commands matches", () => {
      expect(COMMANDS_METHOD_CHANNELS.list).toBe(CHANNELS.COMMANDS_LIST);
      expect(COMMANDS_METHOD_CHANNELS.get).toBe(CHANNELS.COMMANDS_GET);
      expect(COMMANDS_METHOD_CHANNELS.execute).toBe(CHANNELS.COMMANDS_EXECUTE);
      expect(COMMANDS_METHOD_CHANNELS.getBuilder).toBe(CHANNELS.COMMANDS_GET_BUILDER);
    });

    it("portal matches", () => {
      expect(PORTAL_METHOD_CHANNELS.create).toBe(CHANNELS.PORTAL_CREATE);
      expect(PORTAL_METHOD_CHANNELS.show).toBe(CHANNELS.PORTAL_SHOW);
      expect(PORTAL_METHOD_CHANNELS.hide).toBe(CHANNELS.PORTAL_HIDE);
      expect(PORTAL_METHOD_CHANNELS.resize).toBe(CHANNELS.PORTAL_RESIZE);
      expect(PORTAL_METHOD_CHANNELS.closeTab).toBe(CHANNELS.PORTAL_CLOSE_TAB);
      expect(PORTAL_METHOD_CHANNELS.navigate).toBe(CHANNELS.PORTAL_NAVIGATE);
      expect(PORTAL_METHOD_CHANNELS.goBack).toBe(CHANNELS.PORTAL_GO_BACK);
      expect(PORTAL_METHOD_CHANNELS.goForward).toBe(CHANNELS.PORTAL_GO_FORWARD);
      expect(PORTAL_METHOD_CHANNELS.reload).toBe(CHANNELS.PORTAL_RELOAD);
      expect(PORTAL_METHOD_CHANNELS.showNewTabMenu).toBe(CHANNELS.PORTAL_SHOW_NEW_TAB_MENU);
    });

    it("devPreview matches", () => {
      expect(DEV_PREVIEW_METHOD_CHANNELS.ensure).toBe(CHANNELS.DEV_PREVIEW_ENSURE);
      expect(DEV_PREVIEW_METHOD_CHANNELS.restart).toBe(CHANNELS.DEV_PREVIEW_RESTART);
      expect(DEV_PREVIEW_METHOD_CHANNELS.restartAndClearCache).toBe(
        CHANNELS.DEV_PREVIEW_RESTART_AND_CLEAR_CACHE
      );
      expect(DEV_PREVIEW_METHOD_CHANNELS.reinstallAndRestart).toBe(
        CHANNELS.DEV_PREVIEW_REINSTALL_AND_RESTART
      );
      expect(DEV_PREVIEW_METHOD_CHANNELS.stop).toBe(CHANNELS.DEV_PREVIEW_STOP);
      expect(DEV_PREVIEW_METHOD_CHANNELS.stopByPanel).toBe(CHANNELS.DEV_PREVIEW_STOP_BY_PANEL);
      expect(DEV_PREVIEW_METHOD_CHANNELS.getState).toBe(CHANNELS.DEV_PREVIEW_GET_STATE);
      expect(DEV_PREVIEW_METHOD_CHANNELS.getByWorktree).toBe(CHANNELS.DEV_PREVIEW_GET_BY_WORKTREE);
    });

    it("plugin matches (plugin:invoke intentionally excluded)", () => {
      expect(PLUGIN_METHOD_CHANNELS.list).toBe(CHANNELS.PLUGIN_LIST);
      expect(PLUGIN_METHOD_CHANNELS.setEnabled).toBe(CHANNELS.PLUGIN_SET_ENABLED);
      expect(PLUGIN_METHOD_CHANNELS.toolbarButtons).toBe(CHANNELS.PLUGIN_TOOLBAR_BUTTONS);
      expect(PLUGIN_METHOD_CHANNELS.validateActionIds).toBe(CHANNELS.PLUGIN_VALIDATE_ACTION_IDS);
      expect(PLUGIN_METHOD_CHANNELS.getActions).toBe(CHANNELS.PLUGIN_ACTIONS_GET);
      expect(PLUGIN_METHOD_CHANNELS.registerAction).toBe(CHANNELS.PLUGIN_ACTIONS_REGISTER);
      expect(PLUGIN_METHOD_CHANNELS.unregisterAction).toBe(CHANNELS.PLUGIN_ACTIONS_UNREGISTER);
      expect(PLUGIN_METHOD_CHANNELS.getPanelKinds).toBe(CHANNELS.PLUGIN_PANEL_KINDS_GET);
      expect(PLUGIN_METHOD_CHANNELS.getAuditRecords).toBe(CHANNELS.PLUGIN_GET_AUDIT_RECORDS);
      expect(PLUGIN_METHOD_CHANNELS.getAuditConfig).toBe(CHANNELS.PLUGIN_GET_AUDIT_CONFIG);
      expect(PLUGIN_METHOD_CHANNELS.clearAuditLog).toBe(CHANNELS.PLUGIN_CLEAR_AUDIT_LOG);
      expect(PLUGIN_METHOD_CHANNELS.setAuditEnabled).toBe(CHANNELS.PLUGIN_SET_AUDIT_ENABLED);
      expect(PLUGIN_METHOD_CHANNELS.setAuditMaxRecords).toBe(CHANNELS.PLUGIN_SET_AUDIT_MAX_RECORDS);
      expect(PLUGIN_METHOD_CHANNELS.exportAuditLog).toBe(CHANNELS.PLUGIN_EXPORT_AUDIT_LOG);
      expect(PLUGIN_METHOD_CHANNELS.getDiagnosticsSnapshot).toBe(
        CHANNELS.PLUGIN_GET_DIAGNOSTICS_SNAPSHOT
      );
    });

    it("scratch matches", () => {
      expect(SCRATCH_METHOD_CHANNELS.getAll).toBe(CHANNELS.SCRATCH_GET_ALL);
      expect(SCRATCH_METHOD_CHANNELS.getCurrent).toBe(CHANNELS.SCRATCH_GET_CURRENT);
      expect(SCRATCH_METHOD_CHANNELS.create).toBe(CHANNELS.SCRATCH_CREATE);
      expect(SCRATCH_METHOD_CHANNELS.update).toBe(CHANNELS.SCRATCH_UPDATE);
      expect(SCRATCH_METHOD_CHANNELS.remove).toBe(CHANNELS.SCRATCH_REMOVE);
      expect(SCRATCH_METHOD_CHANNELS.switch).toBe(CHANNELS.SCRATCH_SWITCH);
      expect(SCRATCH_METHOD_CHANNELS.saveAsProject).toBe(CHANNELS.SCRATCH_SAVE_AS_PROJECT);
    });

    it("sentry matches", () => {
      expect(SENTRY_METHOD_CHANNELS.getConsentState).toBe(CHANNELS.SENTRY_GET_CONSENT_STATE);
    });

    it("milestones matches", () => {
      expect(MILESTONES_METHOD_CHANNELS.get).toBe(CHANNELS.MILESTONES_GET);
      expect(MILESTONES_METHOD_CHANNELS.markShown).toBe(CHANNELS.MILESTONES_MARK_SHOWN);
    });

    it("shortcutHints matches", () => {
      expect(SHORTCUT_HINTS_METHOD_CHANNELS.getCounts).toBe(CHANNELS.SHORTCUT_HINTS_GET_COUNTS);
      expect(SHORTCUT_HINTS_METHOD_CHANNELS.incrementCount).toBe(
        CHANNELS.SHORTCUT_HINTS_INCREMENT_COUNT
      );
      expect(SHORTCUT_HINTS_METHOD_CHANNELS.getHintedHover).toBe(
        CHANNELS.SHORTCUT_HINTS_GET_HINTED_HOVER
      );
      expect(SHORTCUT_HINTS_METHOD_CHANNELS.setHintedHover).toBe(
        CHANNELS.SHORTCUT_HINTS_SET_HINTED_HOVER
      );
    });

    it("forgeRecommendation matches", () => {
      expect(FORGE_RECOMMENDATION_METHOD_CHANNELS.getDismissed).toBe(
        CHANNELS.FORGE_RECOMMENDATION_GET_DISMISSED
      );
      expect(FORGE_RECOMMENDATION_METHOD_CHANNELS.markDismissed).toBe(
        CHANNELS.FORGE_RECOMMENDATION_MARK_DISMISSED
      );
    });

    it("cli matches", () => {
      expect(CLI_METHOD_CHANNELS.install).toBe(CHANNELS.CLI_INSTALL);
      expect(CLI_METHOD_CHANNELS.getStatus).toBe(CHANNELS.CLI_GET_STATUS);
    });

    it("gemini matches", () => {
      expect(GEMINI_METHOD_CHANNELS.getStatus).toBe(CHANNELS.GEMINI_GET_STATUS);
      expect(GEMINI_METHOD_CHANNELS.enableAlternateBuffer).toBe(
        CHANNELS.GEMINI_ENABLE_ALTERNATE_BUFFER
      );
    });

    it("agentCapabilities matches", () => {
      expect(AGENT_CAPABILITIES_METHOD_CHANNELS.getRegistry).toBe(
        CHANNELS.AGENT_CAPABILITIES_GET_REGISTRY
      );
      expect(AGENT_CAPABILITIES_METHOD_CHANNELS.getAgentIds).toBe(
        CHANNELS.AGENT_CAPABILITIES_GET_AGENT_IDS
      );
      expect(AGENT_CAPABILITIES_METHOD_CHANNELS.getAgentMetadata).toBe(
        CHANNELS.AGENT_CAPABILITIES_GET_AGENT_METADATA
      );
      expect(AGENT_CAPABILITIES_METHOD_CHANNELS.isAgentEnabled).toBe(
        CHANNELS.AGENT_CAPABILITIES_IS_AGENT_ENABLED
      );
      expect(AGENT_CAPABILITIES_METHOD_CHANNELS.getCcrPresets).toBe(
        CHANNELS.AGENT_CAPABILITIES_GET_CCR_PRESETS
      );
    });

    it("globalRecipes matches", () => {
      expect(GLOBAL_RECIPES_METHOD_CHANNELS.getRecipes).toBe(CHANNELS.GLOBAL_GET_RECIPES);
      expect(GLOBAL_RECIPES_METHOD_CHANNELS.addRecipe).toBe(CHANNELS.GLOBAL_ADD_RECIPE);
      expect(GLOBAL_RECIPES_METHOD_CHANNELS.updateRecipe).toBe(CHANNELS.GLOBAL_UPDATE_RECIPE);
      expect(GLOBAL_RECIPES_METHOD_CHANNELS.deleteRecipe).toBe(CHANNELS.GLOBAL_DELETE_RECIPE);
    });

    it("connectivity matches", () => {
      expect(CONNECTIVITY_METHOD_CHANNELS.getState).toBe(CHANNELS.CONNECTIVITY_GET_STATE);
    });

    it("privacy matches", () => {
      expect(PRIVACY_METHOD_CHANNELS.getSettings).toBe(CHANNELS.PRIVACY_GET_SETTINGS);
      expect(PRIVACY_METHOD_CHANNELS.setTelemetryLevel).toBe(CHANNELS.PRIVACY_SET_TELEMETRY_LEVEL);
      expect(PRIVACY_METHOD_CHANNELS.setLogRetention).toBe(CHANNELS.PRIVACY_SET_LOG_RETENTION);
      expect(PRIVACY_METHOD_CHANNELS.openDataFolder).toBe(CHANNELS.PRIVACY_OPEN_DATA_FOLDER);
      expect(PRIVACY_METHOD_CHANNELS.clearCache).toBe(CHANNELS.PRIVACY_CLEAR_CACHE);
      expect(PRIVACY_METHOD_CHANNELS.resetAllData).toBe(CHANNELS.PRIVACY_RESET_ALL_DATA);
      expect(PRIVACY_METHOD_CHANNELS.getDataFolderPath).toBe(CHANNELS.PRIVACY_GET_DATA_FOLDER_PATH);
    });

    it("onboarding matches", () => {
      expect(ONBOARDING_METHOD_CHANNELS.get).toBe(CHANNELS.ONBOARDING_GET);
      expect(ONBOARDING_METHOD_CHANNELS.setStep).toBe(CHANNELS.ONBOARDING_SET_STEP);
      expect(ONBOARDING_METHOD_CHANNELS.complete).toBe(CHANNELS.ONBOARDING_COMPLETE);
      expect(ONBOARDING_METHOD_CHANNELS.markToastSeen).toBe(CHANNELS.ONBOARDING_MARK_TOAST_SEEN);
      expect(ONBOARDING_METHOD_CHANNELS.markNewsletterSeen).toBe(
        CHANNELS.ONBOARDING_MARK_NEWSLETTER_SEEN
      );
      expect(ONBOARDING_METHOD_CHANNELS.markWaitingNudgeSeen).toBe(
        CHANNELS.ONBOARDING_MARK_WAITING_NUDGE_SEEN
      );
      expect(ONBOARDING_METHOD_CHANNELS.markAgentsSeen).toBe(CHANNELS.ONBOARDING_MARK_AGENTS_SEEN);
      expect(ONBOARDING_METHOD_CHANNELS.recordAgentFirstSeen).toBe(
        CHANNELS.ONBOARDING_RECORD_AGENT_FIRST_SEEN
      );
      expect(ONBOARDING_METHOD_CHANNELS.dismissWelcomeCard).toBe(
        CHANNELS.ONBOARDING_DISMISS_WELCOME_CARD
      );
      expect(ONBOARDING_METHOD_CHANNELS.dismissSetupBanner).toBe(
        CHANNELS.ONBOARDING_DISMISS_SETUP_BANNER
      );
      expect(ONBOARDING_METHOD_CHANNELS.getChecklist).toBe(CHANNELS.ONBOARDING_CHECKLIST_GET);
      expect(ONBOARDING_METHOD_CHANNELS.dismissChecklist).toBe(
        CHANNELS.ONBOARDING_CHECKLIST_DISMISS
      );
      expect(ONBOARDING_METHOD_CHANNELS.markChecklistItem).toBe(
        CHANNELS.ONBOARDING_CHECKLIST_MARK_ITEM
      );
      expect(ONBOARDING_METHOD_CHANNELS.markChecklistCelebrationShown).toBe(
        CHANNELS.ONBOARDING_CHECKLIST_MARK_CELEBRATION_SHOWN
      );
    });
  });

  describe("slashCommands", () => {
    it("routes list() to slash-commands:list with the payload forwarded", async () => {
      const invoke = vi.fn().mockResolvedValue([]);
      const bindings = buildSlashCommandsPreloadBindings(invoke);

      const payload = { agentId: "claude", projectPath: "/tmp/p" } as const;
      await bindings.list(payload);

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("slash-commands:list", payload);
    });
  });

  describe("globalEnv", () => {
    it("routes get() to global-env:get with no args", async () => {
      const invoke = vi.fn().mockResolvedValue({});
      const bindings = buildGlobalEnvPreloadBindings(invoke);

      await bindings.get();

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("global-env:get");
    });

    it("wraps set(variables) into the { variables } payload required by the channel", async () => {
      const invoke = vi.fn().mockResolvedValue(undefined);
      const bindings = buildGlobalEnvPreloadBindings(invoke);

      const variables = { FOO: "bar", BAZ: "qux" };
      await bindings.set(variables);

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("global-env:set", { variables });
    });
  });

  describe("help", () => {
    it("routes getFolderPath() to help:get-folder-path with no args", async () => {
      const invoke = vi.fn().mockResolvedValue("/tmp/help");
      const bindings = buildHelpPreloadBindings(invoke);

      await bindings.getFolderPath();

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("help:get-folder-path");
    });

    it("routes markTerminal() to help:mark-terminal with the terminalId forwarded", async () => {
      const invoke = vi.fn().mockResolvedValue(undefined);
      const bindings = buildHelpPreloadBindings(invoke);

      await bindings.markTerminal("term-1");

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("help:mark-terminal", "term-1");
    });

    it("routes unmarkTerminal() to help:unmark-terminal with the terminalId forwarded", async () => {
      const invoke = vi.fn().mockResolvedValue(undefined);
      const bindings = buildHelpPreloadBindings(invoke);

      await bindings.unmarkTerminal("term-1");

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("help:unmark-terminal", "term-1");
    });

    it("routes getPinnedActionContext() to help:get-pinned-action-context with the sessionId forwarded", async () => {
      const invoke = vi.fn().mockResolvedValue(null);
      const bindings = buildHelpPreloadBindings(invoke);

      await bindings.getPinnedActionContext("session-7");

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("help:get-pinned-action-context", "session-7");
    });
  });

  describe("accessibility", () => {
    it("routes getEnabled() to accessibility:get-enabled with no args", async () => {
      const invoke = vi.fn().mockResolvedValue(true);
      const bindings = buildAccessibilityPreloadBindings(invoke);

      await bindings.getEnabled();

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("accessibility:get-enabled");
    });
  });

  describe("eventInspector", () => {
    it("routes getEvents() to event-inspector:get-events with no args", async () => {
      const invoke = vi.fn().mockResolvedValue([]);
      const bindings = buildEventInspectorPreloadBindings(invoke);

      await bindings.getEvents();

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("event-inspector:get-events");
    });

    it("routes getFiltered(filters) to event-inspector:get-filtered with the filters forwarded", async () => {
      const invoke = vi.fn().mockResolvedValue([]);
      const bindings = buildEventInspectorPreloadBindings(invoke);

      const filters = { types: ["user-action"] };
      await bindings.getFiltered(filters);

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("event-inspector:get-filtered", filters);
    });

    it("routes clear() to event-inspector:clear with no args", async () => {
      const invoke = vi.fn().mockResolvedValue(undefined);
      const bindings = buildEventInspectorPreloadBindings(invoke);

      await bindings.clear();

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("event-inspector:clear");
    });
  });

  describe("commands", () => {
    it("routes list(context) to commands:list with the context forwarded", async () => {
      const invoke = vi.fn().mockResolvedValue([]);
      const bindings = buildCommandsPreloadBindings(invoke);

      const ctx = { projectId: "p1" } as const;
      await bindings.list(ctx);

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("commands:list", ctx);
    });

    it("routes execute(payload) to commands:execute with the payload forwarded", async () => {
      const invoke = vi.fn().mockResolvedValue({ success: true });
      const bindings = buildCommandsPreloadBindings(invoke);

      const payload = { commandId: "do-thing", context: {} };
      await bindings.execute(payload);

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("commands:execute", payload);
    });
  });

  describe("portal", () => {
    it("routes create(payload) to portal:create with the payload forwarded", async () => {
      const invoke = vi.fn().mockResolvedValue(undefined);
      const bindings = buildPortalPreloadBindings(invoke);

      const payload = { tabId: "t1", url: "https://example.com" };
      await bindings.create(payload);

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("portal:create", payload);
    });

    it("routes goBack(tabId) to portal:go-back with the tabId forwarded", async () => {
      const invoke = vi.fn().mockResolvedValue(true);
      const bindings = buildPortalPreloadBindings(invoke);

      await bindings.goBack("t1");

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("portal:go-back", "t1");
    });
  });

  describe("devPreview", () => {
    it("routes ensure(request) to dev-preview:ensure with the request forwarded", async () => {
      const invoke = vi.fn().mockResolvedValue({ status: "running" });
      const bindings = buildDevPreviewPreloadBindings(invoke);

      const request = {
        worktreeId: "wt1",
        projectId: "p1",
        panelId: "panel1",
        cwd: "/tmp/p",
        devCommand: "npm run dev",
      };
      await bindings.ensure(request);

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("dev-preview:ensure", request);
    });
  });

  describe("plugin", () => {
    it("routes list() to plugin:list with no args", async () => {
      const invoke = vi.fn().mockResolvedValue([]);
      const bindings = buildPluginPreloadBindings(invoke);

      await bindings.list();

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("plugin:list");
    });

    it("routes registerAction(pluginId, contribution) with both args forwarded", async () => {
      const invoke = vi.fn().mockResolvedValue(undefined);
      const bindings = buildPluginPreloadBindings(invoke);

      const contribution = {
        id: "act-1",
        title: "Do thing",
        description: "Does the thing",
        category: "general",
        kind: "command" as const,
        danger: "safe" as const,
      };
      await bindings.registerAction("plug-1", contribution);

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("plugin:actions-register", "plug-1", contribution);
    });
  });

  describe("scratch", () => {
    it("routes getAll() to scratch:get-all with no args", async () => {
      const invoke = vi.fn().mockResolvedValue([]);
      const bindings = buildScratchPreloadBindings(invoke);

      await bindings.getAll();

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("scratch:get-all");
    });

    it("routes update(scratchId, updates) with both args forwarded", async () => {
      const invoke = vi.fn().mockResolvedValue({});
      const bindings = buildScratchPreloadBindings(invoke);

      const updates = { name: "renamed" };
      await bindings.update("s1", updates);

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("scratch:update", "s1", updates);
    });
  });

  describe("sentry", () => {
    it("routes getConsentState() to sentry:get-consent-state with no args", async () => {
      const invoke = vi.fn().mockResolvedValue({ level: "off", hasSeenPrompt: false });
      const bindings = buildSentryPreloadBindings(invoke);

      await bindings.getConsentState();

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("sentry:get-consent-state");
    });
  });

  describe("milestones", () => {
    it("routes markShown(id) to milestones:mark-shown with the id forwarded", async () => {
      const invoke = vi.fn().mockResolvedValue(undefined);
      const bindings = buildMilestonesPreloadBindings(invoke);

      await bindings.markShown("foo");

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("milestones:mark-shown", "foo");
    });
  });

  describe("shortcutHints", () => {
    it("routes incrementCount(actionId) to shortcut-hints:increment-count", async () => {
      const invoke = vi.fn().mockResolvedValue(undefined);
      const bindings = buildShortcutHintsPreloadBindings(invoke);

      await bindings.incrementCount("act-1");

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("shortcut-hints:increment-count", "act-1");
    });

    it("routes getHintedHover() to shortcut-hints:get-hinted-hover with no args", async () => {
      const invoke = vi.fn().mockResolvedValue([]);
      const bindings = buildShortcutHintsPreloadBindings(invoke);

      await bindings.getHintedHover();

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("shortcut-hints:get-hinted-hover");
    });

    it("routes setHintedHover(keys) to shortcut-hints:set-hinted-hover with the keys forwarded", async () => {
      const invoke = vi.fn().mockResolvedValue(undefined);
      const bindings = buildShortcutHintsPreloadBindings(invoke);

      await bindings.setHintedHover(["act-1@1"]);

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("shortcut-hints:set-hinted-hover", ["act-1@1"]);
    });
  });

  describe("forgeRecommendation", () => {
    it("routes getDismissed() to forge-recommendation:get-dismissed with no args", async () => {
      const invoke = vi.fn().mockResolvedValue({});
      const bindings = buildForgeRecommendationPreloadBindings(invoke);

      await bindings.getDismissed();

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("forge-recommendation:get-dismissed");
    });

    it("routes markDismissed(path) to forge-recommendation:mark-dismissed with the path forwarded", async () => {
      const invoke = vi.fn().mockResolvedValue(undefined);
      const bindings = buildForgeRecommendationPreloadBindings(invoke);

      await bindings.markDismissed("/tmp/project");

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("forge-recommendation:mark-dismissed", "/tmp/project");
    });
  });

  describe("cli", () => {
    it("routes install() to cli:install with no args", async () => {
      const invoke = vi.fn().mockResolvedValue({ installed: true, version: "1.0.0" });
      const bindings = buildCliPreloadBindings(invoke);

      await bindings.install();

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("cli:install");
    });
  });

  describe("gemini", () => {
    it("routes getStatus() to gemini:get-status with no args", async () => {
      const invoke = vi.fn().mockResolvedValue({ exists: true, alternateBufferEnabled: false });
      const bindings = buildGeminiPreloadBindings(invoke);

      await bindings.getStatus();

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("gemini:get-status");
    });
  });

  describe("agentCapabilities", () => {
    it("routes getAgentMetadata(agentId) with the id forwarded", async () => {
      const invoke = vi.fn().mockResolvedValue(null);
      const bindings = buildAgentCapabilitiesPreloadBindings(invoke);

      await bindings.getAgentMetadata("claude");

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("agent-capabilities:get-agent-metadata", "claude");
    });
  });

  describe("globalRecipes", () => {
    it("wraps addRecipe(recipe) into the { recipe } payload required by the channel", async () => {
      const invoke = vi.fn().mockResolvedValue(undefined);
      const bindings = buildGlobalRecipesPreloadBindings(invoke);

      const recipe = {
        id: "r1",
        name: "test",
        terminals: [],
        createdAt: 1000,
      } as Parameters<typeof bindings.addRecipe>[0];
      await bindings.addRecipe(recipe);

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("global:add-recipe", { recipe });
    });

    it("wraps updateRecipe(recipeId, updates) into { recipeId, updates }", async () => {
      const invoke = vi.fn().mockResolvedValue(undefined);
      const bindings = buildGlobalRecipesPreloadBindings(invoke);

      const updates = { name: "renamed" };
      await bindings.updateRecipe("r1", updates);

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("global:update-recipe", {
        recipeId: "r1",
        updates,
      });
    });

    it("wraps deleteRecipe(recipeId) into { recipeId }", async () => {
      const invoke = vi.fn().mockResolvedValue(undefined);
      const bindings = buildGlobalRecipesPreloadBindings(invoke);

      await bindings.deleteRecipe("r1");

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("global:delete-recipe", { recipeId: "r1" });
    });
  });

  describe("connectivity", () => {
    it("routes getState() to connectivity:get-state with no args", async () => {
      const invoke = vi.fn().mockResolvedValue({});
      const bindings = buildConnectivityPreloadBindings(invoke);

      await bindings.getState();

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("connectivity:get-state");
    });
  });

  describe("privacy", () => {
    it("routes setTelemetryLevel(level) with the level forwarded", async () => {
      const invoke = vi.fn().mockResolvedValue(undefined);
      const bindings = buildPrivacyPreloadBindings(invoke);

      await bindings.setTelemetryLevel("errors");

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("privacy:set-telemetry-level", "errors");
    });
  });

  describe("onboarding", () => {
    it("routes markChecklistItem(item) with the item forwarded", async () => {
      const invoke = vi.fn().mockResolvedValue(undefined);
      const bindings = buildOnboardingPreloadBindings(invoke);

      await bindings.markChecklistItem("openedProject");

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("onboarding:checklist-mark-item", "openedProject");
    });
  });
});
