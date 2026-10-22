// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext, ActionId } from "@shared/types/actions";
import type { ActionRegistry } from "../../actionTypes";
import type { SidebarViewOption } from "@/lib/sidebarViews";

const h = vi.hoisted(() => ({ options: [] as SidebarViewOption[] }));

vi.mock("@/hooks/useSidebarViews", () => ({
  getSidebarViewOptions: () => h.options,
}));

import { registerSidebarActions } from "../sidebarActions";
import { OPEN_SIDEBAR_VIEW_SWITCHER_EVENT } from "@/lib/sidebarViews";
import { useFocusStore } from "@/store/focusStore";
import { useSidebarViewStore, WORKTREES_SIDEBAR_VIEW_ID } from "@/store/sidebarViewStore";

const BUILT_IN: SidebarViewOption = { id: WORKTREES_SIDEBAR_VIEW_ID, priority: 0, view: null };
const BOARD: SidebarViewOption = {
  id: "acme.beads.board",
  priority: 10,
  view: {
    id: "plugin-view:acme.beads/board",
    pluginId: "acme.beads",
    viewId: "board",
    location: "sidebar",
    name: "Acme Board",
    title: "Board",
    pluginName: "Acme",
    priority: 10,
    componentPath: "plugin://acme.beads/board.js",
  },
};

function setup() {
  const onToggleSidebar = vi.fn(() => {
    useFocusStore.setState({ gestureSidebarHidden: false });
  });
  const actions: ActionRegistry = new Map();
  registerSidebarActions(actions, { onToggleSidebar });
  const get = (id: ActionId) => {
    const factory = actions.get(id);
    if (!factory) throw new Error(`missing ${id}`);
    return factory();
  };
  return { get, onToggleSidebar };
}

const ctx: ActionContext = {};

const openEvents = vi.fn();

beforeEach(() => {
  h.options = [BUILT_IN, BOARD];
  useFocusStore.setState({ gestureSidebarHidden: false });
  useSidebarViewStore.setState({
    chosenSidebarView: WORKTREES_SIDEBAR_VIEW_ID,
    activeSidebarView: WORKTREES_SIDEBAR_VIEW_ID,
  });
  window.addEventListener(OPEN_SIDEBAR_VIEW_SWITCHER_EVENT, openEvents);
});

afterEach(() => {
  window.removeEventListener(OPEN_SIDEBAR_VIEW_SWITCHER_EVENT, openEvents);
  openEvents.mockReset();
  vi.useRealTimers();
});

describe("ui.sidebar.switchView", () => {
  it("chooses an offered view by id", async () => {
    const { get } = setup();
    await get("ui.sidebar.switchView").run({ viewId: BOARD.id }, ctx);
    expect(useSidebarViewStore.getState().chosenSidebarView).toBe(BOARD.id);
    expect(openEvents).not.toHaveBeenCalled();
  });

  it("refuses an id that is not on offer, leaving the choice alone", async () => {
    const { get } = setup();
    await expect(
      get("ui.sidebar.switchView").run({ viewId: "acme.gone.view" }, ctx)
    ).rejects.toThrow(/acme\.gone\.view/);
    expect(useSidebarViewStore.getState().chosenSidebarView).toBe(WORKTREES_SIDEBAR_VIEW_ID);
  });

  it("opens the switcher when given no view", async () => {
    const { get, onToggleSidebar } = setup();
    await get("ui.sidebar.switchView").run({}, ctx);
    expect(openEvents).toHaveBeenCalledTimes(1);
    expect(onToggleSidebar).not.toHaveBeenCalled();
  });

  it("reveals a hidden sidebar before opening its switcher", async () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame"] });
    useFocusStore.setState({ gestureSidebarHidden: true });
    const { get, onToggleSidebar } = setup();
    await get("ui.sidebar.switchView").run({}, ctx);
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
    expect(openEvents).not.toHaveBeenCalled();
    vi.advanceTimersToNextFrame();
    expect(openEvents).toHaveBeenCalledTimes(1);
  });

  it("is disabled, with its reason, when no plugin adds a sidebar view", () => {
    h.options = [BUILT_IN];
    const def = setup().get("ui.sidebar.switchView");
    expect(def.isEnabled?.(ctx)).toBe(false);
    expect(def.disabledReason?.(ctx)).toBe("No plugin adds a sidebar view to this project");
    h.options = [BUILT_IN, BOARD];
    expect(def.isEnabled?.(ctx)).toBe(true);
    expect(def.disabledReason?.(ctx)).toBeUndefined();
  });
});

describe("ui.sidebar.showWorktrees", () => {
  it("chooses the built-in view and reveals a hidden sidebar", async () => {
    useSidebarViewStore.setState({ chosenSidebarView: BOARD.id });
    useFocusStore.setState({ gestureSidebarHidden: true });
    const { get, onToggleSidebar } = setup();
    await get("ui.sidebar.showWorktrees").run(undefined, ctx);
    expect(useSidebarViewStore.getState().chosenSidebarView).toBe(WORKTREES_SIDEBAR_VIEW_ID);
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
  });
});
