// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { ToolbarButtonConfig } from "@shared/config/toolbarButtonRegistry";
import type { PluginToolbarButtonId, ToolbarButtonPriority } from "@shared/types/toolbar";
import type { PluginPanelBadge } from "@shared/types/plugin";

const dispatchMock = vi.fn();
const setPluginButtonPromotedMock = vi.fn();
const refreshRuntimeMock = vi.fn();

let mockPinnedButtons: Record<string, boolean> = {};
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
      onClick={() => onSelect?.(new Event("select"))}
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

const { PluginTrayButton, PluginToolbarButton, PluginOverflowItem } =
  await import("../PluginTrayButton");
const { usePluginToolbarBadgeStore, _resetPluginToolbarBadgeStoreForTest } =
  await import("@/store/pluginToolbarBadgeStore");
const { act } = await import("@testing-library/react");

function config(local: string, pluginId = "acme.beads"): ToolbarButtonConfig {
  return {
    id: `${pluginId}.${local}` as PluginToolbarButtonId,
    label: local === "needs" ? "Needs you" : local,
    iconId: "sparkles",
    actionId: `${pluginId}.open`,
    priority: 3 as ToolbarButtonPriority,
    pluginId,
  };
}

function setBadges(badges: Record<string, Record<string, PluginPanelBadge>>) {
  act(() => {
    usePluginToolbarBadgeStore.setState({ badgesByPlugin: badges });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPinnedButtons = {};
  mockPluginMetaById = new Map();
  _resetPluginToolbarBadgeStoreForTest();
});

describe("PluginToolbarButton badge (promoted)", () => {
  const needs = config("needs");

  function mark(container: HTMLElement) {
    return container.querySelector(`[data-testid="plugin-toolbar-badge-${needs.id}"]`)!;
  }

  it("draws a whole-number label as a capped count and keeps the full text in its name", () => {
    setBadges({ "acme.beads": { needs: { kind: "label", text: "12", tooltip: "12 runs" } } });
    const { container, getByRole } = render(
      <PluginToolbarButton pluginId={needs.id} config={needs} />
    );

    expect(mark(container).getAttribute("data-visible")).toBe("true");
    expect(mark(container).className).toContain("toolbar-count");
    expect(mark(container).textContent).toBe("9+");
    expect(getByRole("button", { name: /^Needs you/ }).getAttribute("aria-label")).toBe(
      "Needs you, 12 — 12 runs"
    );
  });

  it("draws a dot or a non-numeric label as a pip with no text", () => {
    setBadges({ "acme.beads": { needs: { kind: "label", text: "CI" } } });
    const { container, getByRole } = render(
      <PluginToolbarButton pluginId={needs.id} config={needs} />
    );

    expect(mark(container).className).toContain("toolbar-pip");
    expect(mark(container).textContent).toBe("");
    expect(getByRole("button", { name: /^Needs you/ }).getAttribute("aria-label")).toBe(
      "Needs you, CI"
    );
  });

  it("hides the mark and names the button plainly once the badge clears", () => {
    setBadges({ "acme.beads": { needs: { kind: "dot" } } });
    const { container, getByRole } = render(
      <PluginToolbarButton pluginId={needs.id} config={needs} />
    );
    expect(mark(container).getAttribute("data-visible")).toBe("true");

    setBadges({});
    expect(mark(container).getAttribute("data-visible")).toBe("false");
    expect(getByRole("button", { name: /^Needs you/ }).getAttribute("aria-label")).toBe(
      "Needs you"
    );
  });
});

describe("PluginTrayButton badges", () => {
  const needs = config("needs");
  const queue = config("queue");

  function trayDot(container: HTMLElement) {
    return container.querySelector('[data-testid="plugin-tray-badge"]')!;
  }

  it("shows a row's badge in full", () => {
    setBadges({ "acme.beads": { queue: { kind: "label", text: "Review" } } });
    const { getByTestId } = render(<PluginTrayButton configs={new Map([[queue.id, queue]])} />);
    expect(getByTestId(`plugin-tray-row-${queue.id}`).textContent).toContain("Review");
  });

  it("lights its own dot for an un-promoted badged row", () => {
    setBadges({ "acme.beads": { queue: { kind: "dot", color: "warning" } } });
    const { container, getByLabelText } = render(
      <PluginTrayButton configs={new Map([[queue.id, queue]])} />
    );
    expect(trayDot(container).getAttribute("data-visible")).toBe("true");
    expect(getByLabelText("Plugin tray, 1 badge")).toBeTruthy();
  });

  it("leaves its dot dark when the only badged row is promoted, so one badge lights one button", () => {
    mockPinnedButtons = { [needs.id]: true };
    setBadges({ "acme.beads": { needs: { kind: "label", text: "3" } } });
    const { container, getByLabelText, getByTestId } = render(
      <PluginTrayButton
        configs={
          new Map([
            [needs.id, needs],
            [queue.id, queue],
          ])
        }
      />
    );
    expect(trayDot(container).getAttribute("data-visible")).toBe("false");
    expect(getByLabelText("Plugin tray")).toBeTruthy();
    // The promoted row keeps its full badge in the tray all the same.
    expect(getByTestId(`plugin-tray-row-${needs.id}`).textContent).toContain("3");
  });
});

describe("PluginOverflowItem", () => {
  it("carries the badge in full and dispatches through its handler", () => {
    const needs = config("needs");
    const onSelect = vi.fn();
    setBadges({ "acme.beads": { needs: { kind: "label", text: "42" } } });
    const { getByRole } = render(<PluginOverflowItem config={needs} onSelect={onSelect} />);
    const row = getByRole("menuitem");
    expect(row.textContent).toContain("Needs you");
    expect(row.textContent).toContain("42");
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
