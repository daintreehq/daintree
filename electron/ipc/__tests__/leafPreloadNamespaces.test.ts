import { describe, expect, it, vi } from "vitest";

import { buildSlashCommandsPreloadBindings } from "../handlers/slashCommands.preload.js";
import { buildGlobalEnvPreloadBindings } from "../handlers/globalEnv.preload.js";
import { buildHelpPreloadBindings } from "../handlers/help.preload.js";
import { buildAccessibilityPreloadBindings } from "../handlers/accessibility.preload.js";
import { buildEventInspectorPreloadBindings } from "../handlers/eventInspector.preload.js";
import { buildPortalPreloadBindings } from "../handlers/portal.preload.js";
import { buildDevPreviewPreloadBindings } from "../handlers/devPreview.preload.js";
import { buildPluginPreloadBindings } from "../handlers/plugin.preload.js";
import { buildScratchPreloadBindings } from "../handlers/scratch/preload.js";
import { buildDemoPreloadBindings } from "../handlers/demo.preload.js";
import { buildSentryPreloadBindings } from "../handlers/sentry.preload.js";
import { buildShortcutHintsPreloadBindings } from "../handlers/shortcutHints.preload.js";
import { buildForgeRecommendationPreloadBindings } from "../handlers/forgeRecommendation.preload.js";
import { buildForgeCredentialImportPreloadBindings } from "../handlers/forgeCredentialImport.preload.js";
import { buildCliPreloadBindings } from "../handlers/cli.preload.js";
import { buildGeminiPreloadBindings } from "../handlers/gemini.preload.js";
import { buildAgentCapabilitiesPreloadBindings } from "../handlers/agentCapabilities.preload.js";
import { buildGlobalRecipesPreloadBindings } from "../handlers/globalRecipes.preload.js";
import { buildConnectivityPreloadBindings } from "../handlers/connectivity.preload.js";
import { buildProjectPresencePreloadBindings } from "../handlers/projectPresence.preload.js";
import { buildProjectPresentationPreloadBindings } from "../handlers/projectPresentation.preload.js";
import { buildPrivacyPreloadBindings } from "../handlers/privacy.preload.js";
import { buildOnboardingPreloadBindings } from "../handlers/onboarding.preload.js";
import { buildSchedulesPreloadBindings } from "../handlers/schedules.preload.js";

describe("leaf preload namespace bindings", () => {
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
    it("routes markTerminal() to help:mark-terminal with the terminalId forwarded", async () => {
      const invoke = vi.fn().mockResolvedValue(undefined);
      const bindings = buildHelpPreloadBindings(invoke);

      await bindings.markTerminal("term-1");

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("help:mark-terminal", "term-1");
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
    it("routes getFiltered(filters) to event-inspector:get-filtered with the filters forwarded", async () => {
      const invoke = vi.fn().mockResolvedValue([]);
      const bindings = buildEventInspectorPreloadBindings(invoke);

      const filters = { types: ["user-action"] };
      await bindings.getFiltered(filters);

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("event-inspector:get-filtered", filters);
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

  describe("schedules", () => {
    it("routes each op to its channel with every arg forwarded", async () => {
      const invoke = vi.fn().mockResolvedValue({});
      const bindings = buildSchedulesPreloadBindings(invoke);
      const input = { name: "Nightly", launch: { agentId: "claude", prompt: "Go." } };
      const patch = { name: "Renamed" };

      await bindings.list();
      await bindings.create(input);
      await bindings.update("s1", 42, patch);
      await bindings.setEnabled("s1", false);
      await bindings.remove("s1");
      await bindings.runNow("s1");

      expect(invoke.mock.calls).toEqual([
        ["schedules:list"],
        ["schedules:create", input],
        ["schedules:update", "s1", 42, patch],
        ["schedules:set-enabled", "s1", false],
        ["schedules:remove", "s1"],
        ["schedules:run-now", "s1"],
      ]);
    });
  });

  describe("scratch", () => {
    it("routes update(scratchId, updates) with both args forwarded", async () => {
      const invoke = vi.fn().mockResolvedValue({});
      const bindings = buildScratchPreloadBindings(invoke);

      const updates = { name: "renamed" };
      await bindings.update("s1", updates);

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("scratch:update", "s1", updates);
    });
  });

  describe("demo", () => {
    it("routes moveTo(payload) to demo:move-to with the payload forwarded", async () => {
      const invoke = vi.fn().mockResolvedValue(undefined);
      const bindings = buildDemoPreloadBindings(invoke);

      const payload = { x: 10, y: 20, durationMs: 100 };
      await bindings.moveTo(payload);

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("demo:move-to", payload);
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

  describe("shortcutHints", () => {
    it("routes incrementCount(actionId) to shortcut-hints:increment-count", async () => {
      const invoke = vi.fn().mockResolvedValue(undefined);
      const bindings = buildShortcutHintsPreloadBindings(invoke);

      await bindings.incrementCount("act-1");

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("shortcut-hints:increment-count", "act-1");
    });
  });

  describe("forgeRecommendation", () => {
    it("routes markDismissed(path) to forge-recommendation:mark-dismissed with the path forwarded", async () => {
      const invoke = vi.fn().mockResolvedValue(undefined);
      const bindings = buildForgeRecommendationPreloadBindings(invoke);

      await bindings.markDismissed("/tmp/project");

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("forge-recommendation:mark-dismissed", "/tmp/project");
    });
  });

  describe("forgeCredentialImport", () => {
    it("routes commitCredentialImport(providerId, expected) to forge:commit-credential-import", async () => {
      const invoke = vi
        .fn()
        .mockResolvedValue({ unavailable: false, account: "octocat", scopes: [] });
      const bindings = buildForgeCredentialImportPreloadBindings(invoke);

      await bindings.commitCredentialImport("daintree.github.github", { account: "octocat" });

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith(
        "forge:commit-credential-import",
        "daintree.github.github",
        { account: "octocat" }
      );
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

  describe("projectPresence", () => {
    it("routes getSnapshot() to project-presence:get-snapshot with no args", async () => {
      const invoke = vi.fn().mockResolvedValue({ thisWindow: [], otherWindows: [] });
      const bindings = buildProjectPresencePreloadBindings(invoke);

      await bindings.getSnapshot();

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("project-presence:get-snapshot");
    });
  });

  describe("projectPresentation", () => {
    it("routes each op to its channel with no project id, forwarding only the op's own args", async () => {
      const invoke = vi.fn().mockResolvedValue(null);
      const bindings = buildProjectPresentationPreloadBindings(invoke);

      await bindings.get();
      await bindings.setLevel("forgeStats", "demoted");
      await bindings.answerSuggestion("abc", "declined");
      await bindings.setToolbarEnabled(false);
      await bindings.setPluginButtonPromoted("p.run", true);
      await bindings.resetToolbar();
      await bindings.setLauncherGroupOrder(["recipes"]);
      await bindings.setFeaturedLaunchEntry("acme.records.new");

      expect(invoke.mock.calls).toEqual([
        ["project-presentation:get"],
        ["project-presentation:set-level", "forgeStats", "demoted"],
        ["project-presentation:answer-suggestion", "abc", "declined"],
        ["project-presentation:set-toolbar-enabled", false],
        ["project-presentation:set-plugin-button-promoted", "p.run", true],
        ["project-presentation:reset-toolbar"],
        ["project-presentation:set-launcher-group-order", ["recipes"]],
        ["project-presentation:set-featured-launch-entry", "acme.records.new"],
      ]);
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
