import { beforeEach, describe, expect, it, vi } from "vitest";

function createCallbacks() {
  return {
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
  };
}

describe("createActionDefinitions bootstrap", () => {
  beforeEach(() => {
    vi.resetModules();
    Reflect.deleteProperty(globalThis, "window");
    Object.defineProperty(globalThis, "self", {
      value: globalThis,
      configurable: true,
      writable: true,
    });
  });

  it("does not emit terminal bootstrap noise in node-like suites", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { createActionDefinitions } = await import("../actionDefinitions");
    const actions = createActionDefinitions(createCallbacks());

    expect(actions.has("terminal.list")).toBe(true);
    expect(
      [...warnSpy.mock.calls, ...errorSpy.mock.calls].some((call) =>
        call.some((arg) => typeof arg === "string" && arg.includes("[TerminalOutputIngestService]"))
      )
    ).toBe(false);
  });
});
