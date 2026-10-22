// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { ToolbarButtonConfig } from "@shared/config/toolbarButtonRegistry";
import type { PluginToolbarButtonId, ToolbarButtonPriority } from "@shared/types/toolbar";
import type { PluginToolbarButtonRuntimeState } from "@shared/types/plugin";

const dispatchMock = vi.fn();
const setPluginButtonPromotedMock = vi.fn();
const refreshRuntimeMock = vi.fn();

let mockPinnedButtons: Record<string, boolean> = {};
// Whether the last row selection was cancelled, which keeps a real Radix menu open.
let lastSelectPrevented = false;
let mockPluginMetaById = new Map<string, { devMode: boolean; displayName: string }>();

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatchMock(...args) },
}));

type MockToolbarStoreState = {
  layout: { pinnedButtons: Record<string, boolean> };
  setPluginButtonPromoted: typeof setPluginButtonPromotedMock;
  toggleButtonVisibility: () => void;
};

vi.mock("@/store/toolbarPreferencesStore", () => ({
  useToolbarPreferencesStore: (selector: (s: MockToolbarStoreState) => unknown) =>
    selector({
      layout: { pinnedButtons: mockPinnedButtons },
      setPluginButtonPromoted: setPluginButtonPromotedMock,
      toggleButtonVisibility: () => {},
    }),
}));

type MockRuntimeStoreState = {
  pluginMetaById: Map<string, { devMode: boolean; displayName: string }>;
};

vi.mock("@/store/pluginRuntimeStore", () => ({
  usePluginRuntimeStore: Object.assign(
    (selector: (s: MockRuntimeStoreState) => unknown) =>
      selector({ pluginMetaById: mockPluginMetaById }),
    { getState: () => ({ refresh: refreshRuntimeMock }) }
  ),
}));

vi.mock("@/hooks", () => ({
  useAriaKeyshortcuts: () => undefined,
  useShortcutHintHover: () => ({}),
}));

vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="context-menu-content">{children}</div>
  ),
}));

vi.mock("../ToolbarContextMenuItems", () => ({
  ToolbarContextMenuItems: ({ buttonId, onUnpin }: { buttonId: string; onUnpin?: () => void }) => (
    <button data-testid="toolbar-context-items" data-button-id={buttonId} onClick={onUnpin}>
      unpin
    </button>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropdown-content">{children}</div>
  ),
  DropdownMenuGroup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="menu-group">{children}</div>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="menu-label">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    onKeyDown,
    keybinding,
    ...props
  }: {
    children: React.ReactNode;
    onSelect?: (e: Event) => void;
    onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
    keybinding?: string;
  } & React.HTMLAttributes<HTMLDivElement>) => (
    <div
      role="menuitem"
      tabIndex={0}
      data-keybinding={keybinding}
      onClick={() => {
        const event = new Event("select", { cancelable: true });
        onSelect?.(event);
        lastSelectPrevented = event.defaultPrevented;
      }}
      onKeyDown={onKeyDown}
      {...props}
    >
      {children}
    </div>
  ),
  DropdownMenuActionItem: ({
    actionId,
    args,
    children,
  }: {
    actionId: string;
    args?: unknown;
    children: React.ReactNode;
  }) => (
    <div role="menuitem" data-action-id={actionId} data-args={JSON.stringify(args)}>
      {children}
    </div>
  ),
  DropdownMenuSeparator: () => <hr data-testid="menu-separator" />,
  DropdownMenuSub: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="menu-sub">{children}</div>
  ),
  DropdownMenuSubTrigger: ({
    children,
    ...props
  }: { children: React.ReactNode } & React.HTMLAttributes<HTMLDivElement>) => (
    <div role="menuitem" aria-haspopup="menu" {...props}>
      {children}
    </div>
  ),
  DropdownMenuSubContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="menu-sub-content">{children}</div>
  ),
}));
const { PluginToolbarButton, PluginTrayButton, PluginOverflowItem } =
  await import("../PluginTrayButton");
const { usePluginToolbarStateStore, _resetPluginToolbarStateStoreForTest } =
  await import("@/store/pluginToolbarStateStore");
const { act } = await import("@testing-library/react");
const { publishRegisteredPluginActions } =
  await import("@/services/plugin/registeredPluginActions");

function config(
  local: string,
  extra: Partial<ToolbarButtonConfig> = {},
  pluginId = "acme.beads"
): ToolbarButtonConfig {
  return {
    id: `${pluginId}.${local}` as PluginToolbarButtonId,
    label: "Sync",
    iconId: "sparkles",
    priority: 3 as ToolbarButtonPriority,
    pluginId,
    menu: [{ actionId: "acme.beads.pull" }, { actionId: "acme.beads.push", label: "Push now" }],
    ...extra,
  };
}

function setStates(states: Record<string, Record<string, PluginToolbarButtonRuntimeState>>) {
  act(() => {
    usePluginToolbarStateStore.setState({ statesByPlugin: states });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPinnedButtons = {};
  lastSelectPrevented = false;
  mockPluginMetaById = new Map();
  _resetPluginToolbarStateStoreForTest();
  act(() => {
    publishRegisteredPluginActions([
      ["acme.beads.pull", "Pull"],
      ["acme.beads.push", "Push"],
    ]);
  });
});

describe("plugin toolbar button menu (#13786)", () => {
  it("draws a chevron beside an action button and dispatches only the chosen item's action", () => {
    const sync = config("sync", { actionId: "acme.beads.sync" });
    const { getByTestId, getAllByRole } = render(
      <PluginToolbarButton pluginId={sync.id} config={sync} />
    );
    expect(getByTestId(`plugin-toolbar-menu-chevron-${sync.id}`)).toBeTruthy();

    const labels = getAllByRole("menuitem").map((el) => el.textContent);
    expect(labels).toEqual(["Pull", "Push now"]);

    fireEvent.click(getByTestId("plugin-toolbar-menu-item-acme.beads.push"));
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith("acme.beads.push", undefined, { source: "user" });
  });

  it("keeps the primary click on the action, not the menu", () => {
    const sync = config("sync", { actionId: "acme.beads.sync" });
    const { getByRole } = render(<PluginToolbarButton pluginId={sync.id} config={sync} />);
    fireEvent.click(getByRole("button", { name: "Sync" }));
    expect(dispatchMock).toHaveBeenCalledWith("acme.beads.sync", undefined, { source: "user" });
  });

  it("makes an action-less button a menu button without a chevron", () => {
    const sync = config("sync");
    const { queryByTestId, getAllByRole } = render(
      <PluginToolbarButton pluginId={sync.id} config={sync} />
    );
    expect(queryByTestId(`plugin-toolbar-menu-chevron-${sync.id}`)).toBeNull();
    expect(getAllByRole("menuitem")).toHaveLength(2);
  });

  it("shows an item only while its action is registered", () => {
    const sync = config("sync", { actionId: "acme.beads.sync" });
    const { queryByTestId } = render(<PluginToolbarButton pluginId={sync.id} config={sync} />);
    act(() => publishRegisteredPluginActions([["acme.beads.pull", "Pull"]]));
    expect(queryByTestId("plugin-toolbar-menu-item-acme.beads.pull")).toBeTruthy();
    expect(queryByTestId("plugin-toolbar-menu-item-acme.beads.push")).toBeNull();
  });

  it("follows the plugin's live menu over the manifest's", () => {
    const sync = config("sync", { actionId: "acme.beads.sync" });
    const { queryByTestId } = render(<PluginToolbarButton pluginId={sync.id} config={sync} />);
    setStates({ "acme.beads": { sync: { menu: [] } } });
    expect(queryByTestId(`plugin-toolbar-menu-chevron-${sync.id}`)).toBeNull();
  });

  it("blocks the chevron while the button is busy", () => {
    const sync = config("sync", { actionId: "acme.beads.sync" });
    setStates({ "acme.beads": { sync: { busy: true } } });
    const { getByTestId } = render(<PluginToolbarButton pluginId={sync.id} config={sync} />);
    expect(
      getByTestId(`plugin-toolbar-menu-chevron-${sync.id}`).getAttribute("aria-disabled")
    ).toBe("true");
  });

  it("renders a tray row as a submenu that lists the row's own action first", () => {
    const sync = config("sync", { actionId: "acme.beads.sync" });
    const configs = new Map([[sync.id, sync]]);
    const { getByTestId } = render(<PluginTrayButton configs={configs} />);
    const row = getByTestId(`plugin-tray-row-${sync.id}`);
    expect(row.getAttribute("aria-haspopup")).toBe("menu");

    fireEvent.click(getByTestId(`plugin-tray-primary-${sync.id}`));
    expect(dispatchMock).toHaveBeenLastCalledWith("acme.beads.sync", undefined, {
      source: "user",
    });
    fireEvent.click(getByTestId("plugin-toolbar-menu-item-acme.beads.pull"));
    expect(dispatchMock).toHaveBeenLastCalledWith("acme.beads.pull", undefined, {
      source: "user",
    });
  });

  it("leaves a button without a menu as a plain tray row", () => {
    const plain = config("plain", { actionId: "acme.beads.sync", menu: undefined });
    const { getByTestId } = render(<PluginTrayButton configs={new Map([[plain.id, plain]])} />);
    expect(getByTestId(`plugin-tray-row-${plain.id}`).getAttribute("aria-haspopup")).toBeNull();
  });
  it("ignores a menu item chosen after the button went busy", () => {
    const sync = config("sync", { actionId: "acme.beads.sync" });
    const { getByTestId } = render(<PluginToolbarButton pluginId={sync.id} config={sync} />);
    setStates({ "acme.beads": { sync: { busy: true } } });
    fireEvent.click(getByTestId("plugin-toolbar-menu-item-acme.beads.pull"));
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("dispatches nothing from a menu button whose items are all gone", () => {
    const sync = config("sync");
    const { getByTestId } = render(<PluginTrayButton configs={new Map([[sync.id, sync]])} />);
    act(() => publishRegisteredPluginActions([]));
    fireEvent.click(getByTestId(`plugin-tray-row-${sync.id}`));
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});
