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
    // Aliases retire in the next release.
    expect(actions.has("github.openIssues")).toBe(true);
    expect(actions.has("github.openPRs")).toBe(true);
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
    expect(actions.has("github.setToken")).toBe(true);
    expect(actions.has("github.listIssues")).toBe(true);
  });

  it("registers all BUILT_IN_ACTION_IDS entries", async () => {
    const actions = await createRegistry();

    const missing = (BUILT_IN_ACTION_IDS as readonly string[])
      .filter((id) => !actions.has(id as any))
      .slice()
      .sort();
    expect(missing).toEqual([]);
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
