// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";

const dispatchMock = vi.fn();
const setPanelButtonOnToolbarMock = vi.fn();

let mockPinnedButtons: Record<string, boolean> = {};
let mockLeftButtons: string[] = [];
let mockRightButtons: string[] = [];

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatchMock(...args) },
}));

type MockToolbarStoreState = {
  layout: {
    pinnedButtons: Record<string, boolean>;
    leftButtons: string[];
    rightButtons: string[];
  };
  setPanelButtonOnToolbar: typeof setPanelButtonOnToolbarMock;
  toggleButtonVisibility: () => void;
};

vi.mock("@/store/toolbarPreferencesStore", () => ({
  useToolbarPreferencesStore: (selector: (s: MockToolbarStoreState) => unknown) =>
    selector({
      layout: {
        pinnedButtons: mockPinnedButtons,
        leftButtons: mockLeftButtons,
        rightButtons: mockRightButtons,
      },
      setPanelButtonOnToolbar: setPanelButtonOnToolbarMock,
      toggleButtonVisibility: () => {},
    }),
}));

let mockKeybindingDisplay: Record<string, string | null> = {};

vi.mock("@/hooks", () => ({
  useKeybindingDisplay: (actionId: string) => mockKeybindingDisplay[actionId] ?? null,
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
  ToolbarContextMenuItems: ({ buttonId }: { buttonId: string }) => (
    <button data-testid="toolbar-context-items" data-button-id={buttonId}>
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
  DropdownMenuItem: ({
    children,
    onSelect,
    onKeyDown,
    ...props
  }: {
    children: React.ReactNode;
    onSelect?: (e: Event) => void;
    onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  } & React.HTMLAttributes<HTMLDivElement>) => (
    <div
      role="menuitem"
      tabIndex={0}
      onClick={(e) => onSelect?.(e as unknown as Event)}
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
  DropdownMenuShortcut: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="menu-shortcut">{children}</span>
  ),
}));

const { PanelTrayButton, PANEL_TRAY_ITEMS, isPanelButtonOnToolbar } =
  await import("../PanelTrayButton");

function renderTray(
  overrides: {
    hasWorkspace?: boolean;
    hasProject?: boolean;
    onOpenFileBrowser?: () => void;
  } = {}
) {
  const onOpenFileBrowser = overrides.onOpenFileBrowser ?? vi.fn();
  const utils = render(
    <PanelTrayButton
      hasWorkspace={overrides.hasWorkspace ?? true}
      hasProject={overrides.hasProject ?? true}
      onOpenFileBrowser={onOpenFileBrowser}
    />
  );
  return { ...utils, onOpenFileBrowser };
}

beforeEach(() => {
  dispatchMock.mockClear();
  setPanelButtonOnToolbarMock.mockClear();
  mockPinnedButtons = {};
  mockLeftButtons = ["terminal", "file-browser", "panel-tray"];
  mockRightButtons = ["settings"];
  mockKeybindingDisplay = {};
});

describe("PanelTrayButton (#11667)", () => {
  it("lists every non-agent panel button, promoted ones included", () => {
    // The plugin tray's rule: promotion adds an access point, it never moves the
    // button out of the tray. `file-browser` has its own slot and still appears.
    const { getByTestId } = renderTray();
    for (const item of PANEL_TRAY_ITEMS) {
      expect(getByTestId(`panel-tray-row-${item.id}`)).toBeTruthy();
    }
    expect(PANEL_TRAY_ITEMS.map((i) => i.id)).toEqual(["file-browser", "browser", "dev-server"]);
  });

  it("routes the file browser through the toolbar's own handler, not a bare dispatch", () => {
    // That handler surfaces a retry toast when the action refuses; dispatching
    // directly here would make the tray fail silently where the button doesn't.
    const { getByTestId, onOpenFileBrowser } = renderTray();
    fireEvent.click(getByTestId("panel-tray-row-file-browser"));
    expect(onOpenFileBrowser).toHaveBeenCalledTimes(1);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("dispatches the panel actions for the other rows", () => {
    const { getByTestId } = renderTray();

    fireEvent.click(getByTestId("panel-tray-row-browser"));
    expect(dispatchMock).toHaveBeenCalledWith("agent.browser", undefined, { source: "user" });

    fireEvent.click(getByTestId("panel-tray-row-dev-server"));
    expect(dispatchMock).toHaveBeenCalledWith("devServer.start", undefined, { source: "user" });
  });

  it("does not open a row whose precondition is missing", () => {
    const { getByTestId, onOpenFileBrowser } = renderTray({
      hasWorkspace: false,
      hasProject: false,
    });

    fireEvent.click(getByTestId("panel-tray-row-file-browser"));
    fireEvent.click(getByTestId("panel-tray-row-dev-server"));

    expect(onOpenFileBrowser).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(getByTestId("panel-tray-row-dev-server").getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps a disabled row focusable so its pin stays reachable", () => {
    // `aria-disabled` rather than `disabled`: Radix skips a disabled item in
    // arrow-key and type-ahead navigation, which would strand the pin control on
    // a row the user may well want to promote before opening a project.
    const { getByTestId } = renderTray({ hasProject: false });
    const row = getByTestId("panel-tray-row-dev-server");
    expect(row.getAttribute("disabled")).toBeNull();
    expect(row.getAttribute("tabindex")).toBe("0");
  });

  it("promotes an unpositioned button when its pin is clicked", () => {
    mockLeftButtons = ["terminal", "file-browser", "panel-tray"];
    const { getByTestId } = renderTray();

    expect(getByTestId("panel-tray-pin-browser").getAttribute("data-pinned")).toBe("false");
    fireEvent.click(getByTestId("panel-tray-pin-browser"));

    expect(setPanelButtonOnToolbarMock).toHaveBeenCalledWith("browser", true);
  });

  it("demotes a positioned button when its pin is clicked", () => {
    mockLeftButtons = ["terminal", "browser", "file-browser", "panel-tray"];
    const { getByTestId } = renderTray();

    expect(getByTestId("panel-tray-pin-browser").getAttribute("data-pinned")).toBe("true");
    fireEvent.click(getByTestId("panel-tray-pin-browser"));

    expect(setPanelButtonOnToolbarMock).toHaveBeenCalledWith("browser", false);
  });

  it("toggles the pin from the P key without activating the row", () => {
    const { getByTestId, onOpenFileBrowser } = renderTray();
    fireEvent.keyDown(getByTestId("panel-tray-row-file-browser"), { key: "P" });

    expect(setPanelButtonOnToolbarMock).toHaveBeenCalledWith("file-browser", false);
    expect(onOpenFileBrowser).not.toHaveBeenCalled();
  });

  it("does not activate the row when the pin itself is clicked", () => {
    const { getByTestId, onOpenFileBrowser } = renderTray();
    fireEvent.click(getByTestId("panel-tray-pin-file-browser"));

    expect(setPanelButtonOnToolbarMock).toHaveBeenCalledTimes(1);
    expect(onOpenFileBrowser).not.toHaveBeenCalled();
  });

  it("offers the palette and the toolbar settings tab as footer routes", () => {
    // The tray carries the buttons it can pin; `review`, `file` and `diff` have
    // no toolbar id to pin, so the palette is their route rather than a row here.
    const { container } = renderTray();
    const actionIds = Array.from(container.querySelectorAll("[data-action-id]")).map((el) =>
      el.getAttribute("data-action-id")
    );
    expect(actionIds).toContain("panel.palette");
    expect(actionIds).toContain("app.settings.openTab");
  });

  it("targets panel-tray from its own context menu", () => {
    const { getByTestId } = renderTray();
    expect(getByTestId("toolbar-context-items").getAttribute("data-button-id")).toBe("panel-tray");
  });

  it("shows each row's keybinding hint", () => {
    mockKeybindingDisplay = { "devServer.start": "⌘⌥D" };
    const { getByTestId } = renderTray();
    expect(getByTestId("panel-tray-row-dev-server").textContent).toContain("⌘⌥D");
  });
});

describe("isPanelButtonOnToolbar", () => {
  it("requires a position as well as an unhidden pin", () => {
    // Two factors since v13: `browser` has no default position, so an absent pin
    // entry alone does not put it on the toolbar.
    expect(isPanelButtonOnToolbar("browser", {}, ["terminal"], ["settings"])).toBe(false);
    expect(isPanelButtonOnToolbar("browser", {}, ["terminal", "browser"], ["settings"])).toBe(true);
  });

  it("reads an explicit hide as off the toolbar even when positioned", () => {
    expect(isPanelButtonOnToolbar("browser", { browser: false }, ["terminal", "browser"], [])).toBe(
      false
    );
  });

  it("counts a position on either side", () => {
    expect(isPanelButtonOnToolbar("dev-server", {}, [], ["dev-server"])).toBe(true);
  });
});
