// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ToolbarCommandPaletteButton } from "../ToolbarCommandPaletteButton";

const dispatchMock = vi.fn();
vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (...args: unknown[]) => dispatchMock(...args),
  },
}));

const toggleButtonVisibilityMock = vi.fn();
vi.mock("@/store/toolbarPreferencesStore", () => ({
  useToolbarPreferencesStore: (
    selector: (s: { toggleButtonVisibility: typeof toggleButtonVisibilityMock }) => unknown
  ) => selector({ toggleButtonVisibility: toggleButtonVisibilityMock }),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    ...rest
  }: { children: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...rest}>{children}</button>
  ),
}));

vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="context-menu">{children}</div>
  ),
  ContextMenuItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode;
    onSelect: () => void;
  }) => (
    <button type="button" data-testid="context-menu-item" onClick={onSelect}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/ShortcutRevealChip", () => ({
  ShortcutRevealChip: () => null,
}));

vi.mock("@/lib/tooltipShortcut", () => ({
  createTooltipContent: () => null,
}));

vi.mock("@/hooks", () => ({
  useAriaKeyshortcuts: () => "Meta+Shift+P",
  useKeybindingDisplay: () => "⌘⇧P",
  useShortcutHintHover: () => ({}),
}));

describe("ToolbarCommandPaletteButton", () => {
  beforeEach(() => {
    dispatchMock.mockClear();
    toggleButtonVisibilityMock.mockClear();
  });

  it("renders with the command-palette aria-label and keyboard hint", () => {
    const { container } = render(<ToolbarCommandPaletteButton />);
    const button = container.querySelector('button[aria-label="Command palette"]');
    expect(button).not.toBeNull();
    expect(button!.getAttribute("aria-keyshortcuts")).toBe("Meta+Shift+P");
  });

  it("dispatches action.palette.open on click", () => {
    const { container } = render(<ToolbarCommandPaletteButton />);
    const button = container.querySelector(
      'button[aria-label="Command palette"]'
    ) as HTMLButtonElement;
    fireEvent.click(button);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith("action.palette.open", undefined, { source: "user" });
  });

  it("unpins via the context menu by toggling visibility for the command-palette id", () => {
    const { getByTestId } = render(<ToolbarCommandPaletteButton />);
    fireEvent.click(getByTestId("context-menu-item"));
    expect(toggleButtonVisibilityMock).toHaveBeenCalledTimes(1);
    expect(toggleButtonVisibilityMock).toHaveBeenCalledWith("command-palette", "right");
  });
});
