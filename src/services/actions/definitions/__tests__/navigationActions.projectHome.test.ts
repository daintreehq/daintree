// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const harness = vi.hoisted(() => ({
  homeSurface: null as null | { config: { id: string } },
  exitMaximize: vi.fn(),
}));

vi.mock("@/hooks/useRenderableSurfaceClaim", () => ({
  currentProjectSurface: (slot: string) => (slot === "projectHome" ? harness.homeSurface : null),
}));
vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => ({ exitMaximize: harness.exitMaximize }) },
}));

import { registerNavigationActions } from "../navigationActions";
import { selectProjectMainAreaRoute, useProjectHomeStore } from "@/store/projectHomeStore";

const callbacks: ActionCallbacks = {
  onOpenSettings: vi.fn(),
  onOpenSettingsTab: vi.fn(),
  onToggleSidebar: vi.fn(),
  onToggleFocusMode: vi.fn(),
  onFocusRegionNext: vi.fn(),
  onFocusRegionPrev: vi.fn(),
  onOpenWorktreePalette: vi.fn(),
  onOpenQuickCreatePalette: vi.fn(),
  onToggleWorktreeOverview: vi.fn(),
  onOpenWorktreeOverview: vi.fn(),
  onCloseWorktreeOverview: vi.fn(),
  onOpenPanelPalette: vi.fn(),
  onOpenResumeSessionsPalette: vi.fn(),
  onOpenProjectSwitcherPalette: vi.fn(),
  onConfirmCloseActiveProject: vi.fn(),
  onOpenActionPalette: vi.fn(),
  onOpenQuickSwitcher: vi.fn(),
  onOpenShortcuts: vi.fn(),
  onLaunchAgent: vi.fn(async () => null),
  onInject: vi.fn(),
  onAddTerminal: vi.fn(async () => {}),
  getDefaultCwd: () => "/repo",
  getActiveWorktreeId: () => undefined,
  getWorktrees: () => [],
  getFocusedId: () => null,
  getIsSettingsOpen: vi.fn(() => false),
  getGridNavigation: () => ({
    findNearest: () => null,
    findByIndex: () => null,
    findDockByIndex: () => null,
    getCurrentLocation: () => null,
  }),
};

type HomeActionId = "nav.showProjectHome" | "nav.showProjectSplit" | "nav.showGrid";

function definition(id: HomeActionId): AnyActionDefinition {
  const actions: ActionRegistry = new Map();
  registerNavigationActions(actions, callbacks);
  const factory = actions.get(id);
  if (!factory) throw new Error(`missing ${id}`);
  return factory();
}

const route = () => selectProjectMainAreaRoute(useProjectHomeStore.getState());
const ctx: ActionContext = {};

beforeAll(() => {
  Object.defineProperty(window, "__DAINTREE_INITIAL_PROJECT__", {
    configurable: true,
    writable: true,
    value: { id: "p1" },
  });
});

beforeEach(() => {
  harness.homeSurface = null;
  useProjectHomeStore.setState({ routeByProject: {} });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("project Home navigation actions", () => {
  it.each<HomeActionId>(["nav.showProjectHome", "nav.showProjectSplit", "nav.showGrid"])(
    "%s is hidden and refused in a project without a Home",
    (id) => {
      const def = definition(id);

      expect(def.isVisible?.(ctx)).toBe(false);
      expect(def.isEnabled?.(ctx)).toBe(false);
      expect(def.disabledReason?.(ctx)).toMatch(/no home/i);
    }
  );

  it.each<HomeActionId>(["nav.showProjectHome", "nav.showProjectSplit", "nav.showGrid"])(
    "%s is offered once a project plugin's Home can show",
    (id) => {
      harness.homeSurface = { config: { id: "project:p1/acme.dash/home" } };
      const def = definition(id);

      expect(def.isVisible?.(ctx)).toBe(true);
      expect(def.isEnabled?.(ctx)).toBe(true);
      expect(def.disabledReason?.(ctx)).toBeUndefined();
    }
  );

  it("goes Home, leaving a maximize that would draw over it, and back to the grid", async () => {
    harness.homeSurface = { config: { id: "project:p1/acme.dash/home" } };

    await definition("nav.showProjectHome").run(undefined, ctx);
    expect(route()).toBe("home");
    expect(harness.exitMaximize).toHaveBeenCalledTimes(1);

    await definition("nav.showGrid").run(undefined, ctx);
    expect(route()).toBe("grid");
  });

  it("puts Home beside the grid and keeps a maximize, which fills only the panels' side", async () => {
    harness.homeSurface = { config: { id: "project:p1/acme.dash/home" } };

    await definition("nav.showProjectSplit").run(undefined, ctx);
    expect(route()).toBe("split");
    expect(harness.exitMaximize).not.toHaveBeenCalled();

    await definition("nav.showGrid").run(undefined, ctx);
    expect(route()).toBe("grid");
  });
});
