import { describe, it, expect } from "vitest";

async function createRegistry() {
  (globalThis as any).self = globalThis;
  const { createActionDefinitions } = await import("../actionDefinitions");
  return createActionDefinitions({
    onOpenSettings: () => {},
    onOpenSettingsTab: () => {},
    onToggleSidebar: () => {},
    onToggleFocusMode: () => {},
    onOpenAgentPalette: () => {},
    onOpenActionPalette: () => {},
    onOpenQuickSwitcher: () => {},
    onOpenWorktreePalette: () => {},
    onToggleWorktreeOverview: () => {},
    onOpenWorktreeOverview: () => {},
    onCloseWorktreeOverview: () => {},
    onOpenNewTerminalPalette: () => {},
    onOpenPanelPalette: () => {},
    onOpenProjectSwitcherPalette: () => {},
    onOpenShortcuts: () => {},
    onLaunchAgent: async () => null,
    onInject: () => {},
    getDefaultCwd: () => "/",
    getActiveWorktreeId: () => undefined,
    getWorktrees: () => [],
    getFocusedId: () => null,
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

    expect(actions.has("github.openIssues")).toBe(true);
    expect(actions.has("github.openPRs")).toBe(true);
    expect(actions.has("app.developerMode.set")).toBe(true);
    expect(actions.has("sidecar.openLaunchpad")).toBe(true);
    expect(actions.has("browser.navigate")).toBe(true);
    expect(actions.has("browser.back")).toBe(true);
    expect(actions.has("browser.forward")).toBe(true);
    expect(actions.has("app.quit")).toBe(true);
    expect(actions.has("app.forceQuit")).toBe(true);
    expect(actions.has("project.add")).toBe(true);
    expect(actions.has("project.openDialog")).toBe(true);
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

  it("registers all ActionId string literals", async () => {
    const actions = await createRegistry();
    const fs = await import("node:fs/promises");

    const actionsFileUrl = new URL("../../../../shared/types/actions.ts", import.meta.url);
    const contents = await fs.readFile(actionsFileUrl, "utf8");

    const start = contents.indexOf("export type ActionId");
    expect(start).toBeGreaterThan(-1);
    const end = contents.indexOf("export interface ActionContext", start);
    expect(end).toBeGreaterThan(start);
    const section = contents.slice(start, end);

    const ids = new Set<string>();
    const regex = /\|\s*"([^"]+)"/g;
    for (const match of section.matchAll(regex)) {
      ids.add(match[1]);
    }

    const missing = Array.from(ids)
      .filter((id) => !actions.has(id as any))
      .sort();
    expect(missing).toEqual([]);
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
