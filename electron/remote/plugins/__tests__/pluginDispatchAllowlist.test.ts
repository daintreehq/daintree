import { describe, expect, it } from "vitest";
import { DENY_PLUGIN_DISPATCH_ACTION_IDS } from "../../../../shared/config/actionIds.js";
import { HOST_DISPATCHABLE_ACTION_IDS } from "../../client/hostDispatchableActions.js";
import {
  HOST_PLUGIN_DISPATCHABLE_ACTION_IDS,
  isHostPluginDispatchable,
} from "../pluginDispatchAllowlist.js";

describe("HOST_PLUGIN_DISPATCHABLE_ACTION_IDS", () => {
  it("is drawn from the audited host-dispatchable set, never an action closed to plugins", () => {
    expect(HOST_PLUGIN_DISPATCHABLE_ACTION_IDS.size).toBeGreaterThan(0);
    for (const id of HOST_PLUGIN_DISPATCHABLE_ACTION_IDS) {
      expect(HOST_DISPATCHABLE_ACTION_IDS.has(id)).toBe(true);
      expect((DENY_PLUGIN_DISPATCH_ACTION_IDS as readonly string[]).includes(id)).toBe(false);
    }
  });

  it("keeps clipboard, screen capture and window moves out, and denies what it has never heard of", () => {
    for (const id of [
      "browser.copyUrl",
      "browser.captureScreenshot",
      "terminal.paste",
      "host.switch",
      "project.openOnHost",
      "system.openExternal",
      "a.future.action",
    ]) {
      expect(isHostPluginDispatchable(id)).toBe(false);
    }
    expect(isHostPluginDispatchable("worktree.refresh")).toBe(true);
  });

  it("gives a plugin the project-bound actions but not the tools only an MCP session uses", () => {
    for (const id of ["terminal.moveToWorktree", "workspace.list", "slashCommands.list"]) {
      expect(isHostPluginDispatchable(id)).toBe(true);
    }
    // The registry searches would read past the filtered catalog a plugin is
    // given, and the rest are answered for an MCP session or closed to
    // plugins everywhere.
    for (const id of [
      "actions.search",
      "actions.list",
      "mcp.surface",
      "help.displayImage",
      "skills.search",
      "skills.load",
      "terminal.sendKeys",
      "agent.launchMany",
      "terminal.notifyWhenIdle",
    ]) {
      expect(HOST_DISPATCHABLE_ACTION_IDS.has(id)).toBe(true);
      expect(isHostPluginDispatchable(id)).toBe(false);
    }
  });
});
