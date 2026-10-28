// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import {
  registerPanelKind,
  unregisterPanelKind,
  getPanelKindIds,
  getPanelKindConfig,
  type PanelKindConfig,
} from "@shared/config/panelKindRegistry";
import type { PluginLaunchEntryConfig } from "@shared/types/plugin";

const h = vi.hoisted(() => ({
  activate: vi.fn(),
  hide: vi.fn(),
}));

vi.mock("@/registry", () => ({
  getSpawnablePanelKinds: (): PanelKindConfig[] =>
    getPanelKindIds()
      .map((id) => getPanelKindConfig(id))
      .filter((c): c is PanelKindConfig => c !== undefined && c.showInPalette !== false),
  subscribeToPanelKindDefinitions: () => () => {},
  getPanelKindDefinitionsSnapshot: () => 0,
}));
vi.mock("@/store/panelStore", () => ({ usePanelStore: { getState: () => ({}) } }));
vi.mock("@/store/recipeStore", () => ({ useRecipeStore: { getState: () => ({}) } }));
vi.mock("@/store/actionMruStore", () => ({
  useActionMruStore: { getState: () => ({ recordActionMru: vi.fn() }) },
}));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));
vi.mock("@/utils/logger", () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }));
vi.mock("@/hooks/useChromeWhenContext", () => ({ useChromeWhenContext: () => ({}) }));
vi.mock("@/components/PanelPalette/PanelKindIcon", () => ({
  PanelKindIcon: () => <span data-testid="icon" />,
}));
vi.mock("@/components/Layout/dockLaunchItems", async (importActual) => ({
  ...(await importActual<typeof import("@/components/Layout/dockLaunchItems")>()),
  activateDockLaunchItem: h.activate,
  hidePluginGroup: h.hide,
}));

import { PluginLaunchBand } from "../PluginLaunchBand";
import {
  resetPluginLaunchEntriesStoreForTests,
  usePluginLaunchEntriesStore,
} from "@/store/pluginLaunchEntriesStore";

const KIND = "acme.records.records";

function entry(id: string, over: Partial<PluginLaunchEntryConfig> = {}): PluginLaunchEntryConfig {
  return {
    id: `acme.records.${id}`,
    pluginId: "acme.records",
    pluginName: "Records",
    label: id,
    iconId: "plus",
    priority: 3,
    showInEmptyState: true,
    target: { type: "panel", panelKindId: KIND },
    ...over,
  };
}

function seed(
  entries: PluginLaunchEntryConfig[],
  state: { hiddenPluginIds?: string[]; hiddenLoaded?: boolean } = {}
) {
  act(() => {
    usePluginLaunchEntriesStore.setState({
      entries,
      hiddenPluginIds: state.hiddenPluginIds ?? [],
      hiddenLoaded: state.hiddenLoaded ?? true,
    });
  });
}

function renderBand(cwd: string | undefined) {
  return render(<PluginLaunchBand activeWorktreeId="wt-1" cwd={cwd} />);
}

beforeEach(() => {
  resetPluginLaunchEntriesStoreForTests();
  h.activate.mockReset();
  h.hide.mockReset();
  Object.defineProperty(window, "electron", { configurable: true, writable: true, value: {} });
  registerPanelKind({
    id: KIND,
    name: "Records",
    iconId: "package",
    color: "#fff",
    hasPty: false,
    canRestart: false,
    canConvert: false,
    extensionId: "acme.records",
  });
});

afterEach(() => {
  cleanup();
  unregisterPanelKind(KIND);
  Reflect.deleteProperty(window, "electron");
});

describe("PluginLaunchBand", () => {
  it("draws nothing without an opted-in entry", () => {
    seed([entry("plain", { showInEmptyState: undefined })]);
    const { container } = renderBand("/repo");
    expect(container.firstChild).toBeNull();
  });

  it("holds back until the hidden groups have loaded", () => {
    seed([entry("new")], { hiddenLoaded: false });
    const { container } = renderBand("/repo");
    expect(container.firstChild).toBeNull();
  });

  it("lists an opted-in entry under 'From <plugin>'", () => {
    seed([entry("new"), entry("plain", { showInEmptyState: undefined })]);
    renderBand("/repo");
    expect(screen.getByText("From Records")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^new, Records/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^plain/ })).toBeNull();
  });

  it("leaves out a plugin the project hides", () => {
    seed([entry("new")], { hiddenPluginIds: ["acme.records"] });
    const { container } = renderBand("/repo");
    expect(container.firstChild).toBeNull();
  });

  it("activates a tile as a user action in the grid context", () => {
    seed([entry("new")]);
    renderBand("/repo");
    fireEvent.click(screen.getByRole("button", { name: /^new, Records/ }));
    expect(h.activate).toHaveBeenCalledTimes(1);
    const [item, ctx] = h.activate.mock.calls[0]!;
    expect(item.entryId).toBe("acme.records.new");
    expect(ctx).toMatchObject({ cwd: "/repo", activeWorktreeId: "wt-1", source: "user" });
  });

  it("does not activate without somewhere to launch into", () => {
    seed([entry("new")]);
    renderBand(undefined);
    fireEvent.click(screen.getByRole("button", { name: /^new, Records/ }));
    expect(h.activate).not.toHaveBeenCalled();
  });

  it("shows an unavailable entry's reason and refuses it", () => {
    seed([entry("chat", { target: { type: "agent", agentId: "ghost", prompt: "hi" } })]);
    renderBand("/repo");
    const tile = screen.getByRole("button", { name: /Agent not available/ });
    fireEvent.click(tile);
    expect(h.activate).not.toHaveBeenCalled();
  });

  it("hides the plugin from the band's own button", () => {
    seed([entry("new")]);
    renderBand("/repo");
    fireEvent.click(screen.getByRole("button", { name: "Hide Records in this project" }));
    expect(h.hide).toHaveBeenCalledWith(expect.objectContaining({ pluginId: "acme.records" }));
  });

  it("moves between tiles with the arrow keys, one tab stop for the lot", () => {
    seed([entry("a", { priority: 1 }), entry("b", { priority: 2 })]);
    renderBand("/repo");
    const [a, b] = [/^a, /, /^b, /].map((name) => screen.getByRole("button", { name }));
    expect(a!.tabIndex).toBe(0);
    expect(b!.tabIndex).toBe(-1);
    fireEvent.keyDown(a!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(b);
    expect(b!.tabIndex).toBe(0);
  });
});
