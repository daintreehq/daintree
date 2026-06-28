import { describe, it, expect } from "vitest";
import { BUILT_IN_ACTION_IDS } from "@shared/config/actionIds";

async function createRegistry() {
  (globalThis as any).self = globalThis;
  const { createActionDefinitions } = await import("../actionDefinitions");
  return createActionDefinitions({
    onOpenSettings: () => {},
    onOpenSettingsTab: () => {},
    onToggleSidebar: () => {},
    onToggleFocusMode: () => {},
    onFocusRegionNext: () => {},
    onFocusRegionPrev: () => {},
    onOpenActionPalette: () => {},
    onOpenQuickSwitcher: () => {},
    onOpenWorktreePalette: () => {},
    onOpenQuickCreatePalette: () => {},
    onToggleWorktreeOverview: () => {},
    onOpenWorktreeOverview: () => {},
    onCloseWorktreeOverview: () => {},
    onOpenPanelPalette: () => {},
    onOpenProjectSwitcherPalette: () => {},
    onConfirmCloseActiveProject: () => {},
    onOpenShortcuts: () => {},
    onLaunchAgent: async () => null,
    onInject: () => {},
    onAddTerminal: async () => {},
    getDefaultCwd: () => "/",
    getActiveWorktreeId: () => undefined,
    getWorktrees: () => [],
    getFocusedId: () => null,
    getIsSettingsOpen: () => false,
    getGridNavigation: () => ({
      findNearest: () => null,
      findByIndex: () => null,
      findDockByIndex: () => null,
      getCurrentLocation: () => null,
    }),
  });
}

describe("createActionDefinitions", () => {
  it("registers core app actions", async () => {
    const actions = await createRegistry();

    expect(actions.has("forge.openIssues")).toBe(true);
    expect(actions.has("forge.openPRs")).toBe(true);
    expect(actions.has("forge.openCommits")).toBe(true);
    expect(actions.has("forge.openIssue")).toBe(true);
    expect(actions.has("forge.assignIssue")).toBe(true);
    expect(actions.has("forge.validateToken")).toBe(true);
    expect(actions.has("app.developerMode.set")).toBe(true);
    expect(actions.has("portal.openLaunchpad")).toBe(true);
    expect(actions.has("browser.navigate")).toBe(true);
    expect(actions.has("browser.back")).toBe(true);
    expect(actions.has("browser.forward")).toBe(true);
    expect(actions.has("app.quit")).toBe(true);
    expect(actions.has("app.forceQuit")).toBe(true);
    expect(actions.has("project.add")).toBe(true);
    expect(actions.has("project.openDialog")).toBe(true);
    expect(actions.has("project.muteNotifications")).toBe(true);
    expect(actions.has("errors.clearAll")).toBe(true);
    expect(actions.has("eventInspector.clear")).toBe(true);
    expect(actions.has("ui.refresh")).toBe(true);
    expect(actions.has("terminal.info.get")).toBe(true);
    expect(actions.has("logs.getAll")).toBe(true);
    expect(actions.has("logs.getSources")).toBe(true);
    expect(actions.has("errors.openLogs")).toBe(true);
    expect(actions.has("eventInspector.getEvents")).toBe(true);
    expect(actions.has("eventInspector.subscribe")).toBe(true);
    expect(actions.has("forge.openPR")).toBe(true);
    expect(actions.has("forge.listIssues")).toBe(true);
  });

  it("registers a launch action for launchable agents but not assistant-only agents (#10634)", async () => {
    const actions = await createRegistry();

    // Launchable built-in agents get a direct-launch action...
    expect(actions.has("agent.claude" as any)).toBe(true);
    // ...but the assistant-only daintree-assistant is never launchable, so no
    // action is registered (keeps it out of the action palette and MCP manifest).
    expect(actions.has("agent.daintree-assistant" as any)).toBe(false);
  });

  it("registers all BUILT_IN_ACTION_IDS entries", async () => {
    const actions = await createRegistry();

    const missing = (BUILT_IN_ACTION_IDS as readonly string[])
      .filter((id) => !actions.has(id as any))
      .slice()
      .sort();
    expect(missing).toEqual([]);
  });

  it("does not register removed github.* action ids", async () => {
    const actions = await createRegistry();

    // The first batch forwarded to forge.* for one release before removal; the
    // second batch was the GitHub-specific host action surface retired by the
    // forge-neutral migration. Guards against accidental re-registration
    // (which the round-trip test above, driven by BUILT_IN_ACTION_IDS, would
    // not catch on its own).
    const removedIds = [
      "github.openIssues",
      "github.openPRs",
      "github.openCommits",
      "github.openIssue",
      "github.assignIssue",
      "github.validateToken",
      "github.openPR",
      "github.getRepoStats",
      "github.listIssues",
      "github.listPullRequests",
      "github.getIssueByNumber",
      "github.checkCli",
      "github.getConfig",
      "github.setToken",
      "github.clearToken",
    ];
    const stillRegistered = removedIds.filter((id) => actions.has(id as any));
    expect(stillRegistered).toEqual([]);
  });

  it("registers action.repeatLast with nonRepeatable set", async () => {
    const actions = await createRegistry();

    expect(actions.has("action.repeatLast")).toBe(true);
    const factory = actions.get("action.repeatLast");
    expect(factory).toBeDefined();
    const def = factory!();
    expect(def.nonRepeatable).toBe(true);
    expect(def.danger).toBe("safe");
  });

  it("covers all configured keybindings", async () => {
    const actions = await createRegistry();
    const { keybindingService } = await import("../../KeybindingService");
    const bindings = keybindingService.getAllBindings();

    const missing = bindings
      .map((b) => b.actionId)
      .filter((id) => !actions.has(id as any))
      .sort();

    expect(missing).toEqual([]);
  });
});
