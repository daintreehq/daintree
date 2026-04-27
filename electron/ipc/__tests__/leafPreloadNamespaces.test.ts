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
    });

    it("accessibility matches", () => {
      expect(ACCESSIBILITY_METHOD_CHANNELS.getEnabled).toBe(CHANNELS.ACCESSIBILITY_GET_ENABLED);
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
});
