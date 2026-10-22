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
}));
const { PluginToolbarButton, PluginTrayButton, PluginOverflowItem } =
  await import("../PluginTrayButton");
const { usePluginToolbarStateStore, _resetPluginToolbarStateStoreForTest } =
  await import("@/store/pluginToolbarStateStore");
const { act } = await import("@testing-library/react");

function config(local: string, pluginId = "acme.beads"): ToolbarButtonConfig {
  return {
    id: `${pluginId}.${local}` as PluginToolbarButtonId,
    label: "Sync",
    iconId: "sparkles",
    actionId: `${pluginId}.sync`,
    priority: 3 as ToolbarButtonPriority,
    pluginId,
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
});

describe("PluginToolbarButton runtime state (#13785)", () => {
  const sync = config("sync");

  it("is a plain button with no state, and announces pressed only once the plugin sets it", () => {
    const { getByRole } = render(<PluginToolbarButton pluginId={sync.id} config={sync} />);
    const button = getByRole("button", { name: "Sync" });
    expect(button.hasAttribute("aria-pressed")).toBe(false);

    setStates({ "acme.beads": { sync: { pressed: false } } });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    setStates({ "acme.beads": { sync: { pressed: true } } });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    // The name never changes with the toggle.
    expect(button.getAttribute("aria-label")).toBe("Sync");
  });

  it("stays focusable when disabled, says why, and ignores clicks", () => {
    setStates({
      "acme.beads": { sync: { disabled: true, disabledReason: "Sign in to sync" } },
    });
    const { getByRole, getAllByText } = render(
      <PluginToolbarButton pluginId={sync.id} config={sync} />
    );
    const button = getByRole("button", { name: "Sync" });

    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    const describedBy = button.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe("Sign in to sync");
    expect(getAllByText("Sign in to sync").length).toBeGreaterThan(0);

    fireEvent.click(button);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("shows a busy spinner and ignores clicks until busy clears", () => {
    setStates({ "acme.beads": { sync: { busy: true } } });
    const { getByRole } = render(<PluginToolbarButton pluginId={sync.id} config={sync} />);
    const button = getByRole("button", { name: "Sync" });

    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.querySelector('[data-slot="button-spinner"]')).not.toBeNull();
    fireEvent.click(button);
    expect(dispatchMock).not.toHaveBeenCalled();

    setStates({});
    expect(button.hasAttribute("aria-busy")).toBe(false);
    fireEvent.click(button);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("replaces only the tooltip text, never the accessible name", () => {
    setStates({ "acme.beads": { sync: { tooltip: "Synced 2 min ago" } } });
    const { getByRole, getByText } = render(
      <PluginToolbarButton pluginId={sync.id} config={sync} />
    );
    expect(getByRole("button", { name: "Sync" }).getAttribute("aria-label")).toBe("Sync");
    expect(getByText("Synced 2 min ago")).not.toBeNull();
  });
});

describe("PluginTrayButton rows under runtime state (#13785)", () => {
  const sync = config("sync");
  const configs = new Map([[sync.id, sync]]);

  function row(container: HTMLElement) {
    return container.querySelector(`[data-testid="plugin-tray-row-${sync.id}"]`)!;
  }

  it("dispatches and closes on selecting a row with no state", () => {
    const { container } = render(<PluginTrayButton configs={configs} />);
    fireEvent.click(row(container));
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(lastSelectPrevented).toBe(false);
  });

  it("makes a toggle row a checked menu item and leaves a plain row alone", () => {
    const { container } = render(<PluginTrayButton configs={configs} />);
    expect(row(container).getAttribute("role")).toBe("menuitem");

    setStates({ "acme.beads": { sync: { pressed: true } } });
    expect(row(container).getAttribute("role")).toBe("menuitemcheckbox");
    expect(row(container).getAttribute("aria-checked")).toBe("true");
  });

  it("vetoes selecting a disabled row but keeps its pin control working", () => {
    setStates({
      "acme.beads": { sync: { disabled: true, disabledReason: "Sign in to sync" } },
    });
    const { container } = render(<PluginTrayButton configs={configs} />);

    expect(row(container).getAttribute("aria-disabled")).toBe("true");
    expect(row(container).textContent).toContain("Sign in to sync");
    fireEvent.click(row(container));
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(lastSelectPrevented).toBe(true);

    fireEvent.click(container.querySelector(`[data-testid="plugin-tray-pin-${sync.id}"]`)!);
    expect(setPluginButtonPromotedMock).toHaveBeenCalledWith(sync.id, true);
  });
});

describe("PluginOverflowItem under runtime state (#13785)", () => {
  const sync = config("sync");

  it("ignores selection while busy and runs once it clears", () => {
    const onSelect = vi.fn();
    setStates({ "acme.beads": { sync: { busy: true } } });
    const { getByRole } = render(<PluginOverflowItem config={sync} onSelect={onSelect} />);
    const item = getByRole("menuitem");

    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.textContent).toContain("busy");
    fireEvent.click(item);
    expect(onSelect).not.toHaveBeenCalled();

    setStates({});
    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
