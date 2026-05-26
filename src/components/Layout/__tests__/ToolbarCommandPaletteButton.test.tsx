// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, fireEvent } from "@testing-library/react";
import { ToolbarCommandPaletteButton } from "../ToolbarCommandPaletteButton";

const dispatchMock = vi.fn<(...args: unknown[]) => Promise<{ ok: true; result: undefined }>>(() =>
  Promise.resolve({ ok: true, result: undefined })
);
vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (...args: unknown[]) => dispatchMock(...args),
  },
}));

const hideMock = vi.fn();
vi.mock("@/store/shortcutHintStore", () => ({
  shortcutHintStore: {
    getState: () => ({ hide: hideMock }),
  },
}));

const toggleButtonVisibilityMock = vi.fn();
vi.mock("@/store/toolbarPreferencesStore", () => ({
  useToolbarPreferencesStore: (
    selector: (s: { toggleButtonVisibility: typeof toggleButtonVisibilityMock }) => unknown
  ) => selector({ toggleButtonVisibility: toggleButtonVisibilityMock }),
}));

const tooltipOpenChangeSpy = vi.fn<(open: boolean) => void>();
let lastTooltipOpen: boolean | undefined;
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => {
    lastTooltipOpen = open;
    if (onOpenChange) tooltipOpenChangeSpy.mockImplementation(onOpenChange);
    return <>{children}</>;
  },
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

const hoverFocusSpy = vi.fn();
const hoverPointerEnterSpy = vi.fn();
vi.mock("@/hooks", () => ({
  useAriaKeyshortcuts: () => "Meta+Shift+P",
  useKeybindingDisplay: () => "⌘⇧P",
  useShortcutHintHover: () => ({
    onPointerEnter: hoverPointerEnterSpy,
    onPointerLeave: vi.fn(),
    onPointerDown: vi.fn(),
    onFocus: hoverFocusSpy,
    onBlur: vi.fn(),
  }),
}));

describe("ToolbarCommandPaletteButton", () => {
  beforeEach(() => {
    dispatchMock.mockClear();
    dispatchMock.mockImplementation(() => Promise.resolve({ ok: true, result: undefined }));
    toggleButtonVisibilityMock.mockClear();
    hideMock.mockClear();
    hoverFocusSpy.mockClear();
    hoverPointerEnterSpy.mockClear();
    tooltipOpenChangeSpy.mockClear();
    lastTooltipOpen = undefined;
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

  it("tears down any active shortcut hint on click so the open palette doesn't sit beneath it", async () => {
    const { container } = render(<ToolbarCommandPaletteButton />);
    const button = container.querySelector(
      'button[aria-label="Command palette"]'
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(button);
    });
    // Hide is called twice: once eagerly to clear any hover-dwell hint, and
    // once after dispatch to clear the educational hint emitted by
    // ActionService.emitShortcutHint (which would otherwise sit above the
    // just-opened palette on z-toast).
    expect(hideMock).toHaveBeenCalledTimes(2);
  });

  it("closes an already-open tooltip on click before opening the palette", () => {
    const { container } = render(<ToolbarCommandPaletteButton />);
    const button = container.querySelector(
      'button[aria-label="Command palette"]'
    ) as HTMLButtonElement;

    // Pointer-hover opens the tooltip via Radix's onOpenChange path.
    fireEvent.pointerEnter(button);
    act(() => {
      tooltipOpenChangeSpy(true);
    });
    expect(lastTooltipOpen).toBe(true);

    // Click should close the tooltip and dispatch the action — without this
    // the tooltip lingers on top of the opening palette.
    fireEvent.click(button);
    expect(lastTooltipOpen).toBe(false);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses tooltip reopen during the AppPaletteDialog focus restore that follows a click", () => {
    const { container } = render(<ToolbarCommandPaletteButton />);
    const button = container.querySelector(
      'button[aria-label="Command palette"]'
    ) as HTMLButtonElement;

    // Simulate the click that opens the palette. AppPaletteDialog will later
    // restore focus to this button, which triggers Radix's open path.
    fireEvent.click(button);
    expect(lastTooltipOpen).toBe(false);

    // The restored focus event hits the button before Radix reaches into
    // onOpenChange. The shortcut hint's onFocus must be gated.
    fireEvent.focus(button);
    expect(hoverFocusSpy).not.toHaveBeenCalled();

    // Radix attempts to open the tooltip when focus lands back on the button.
    act(() => {
      tooltipOpenChangeSpy(true);
    });
    // Suppression is engaged — Radix's open request is rejected.
    expect(lastTooltipOpen).toBe(false);

    // A genuine pointer enter clears suppression and lets the next open
    // request through.
    fireEvent.pointerEnter(button);
    expect(hoverPointerEnterSpy).toHaveBeenCalledTimes(1);
    act(() => {
      tooltipOpenChangeSpy(true);
    });
    expect(lastTooltipOpen).toBe(true);
  });

  it("forwards focus and pointer-enter to the shortcut-hint hook in the normal (un-suppressed) path", () => {
    const { container } = render(<ToolbarCommandPaletteButton />);
    const button = container.querySelector(
      'button[aria-label="Command palette"]'
    ) as HTMLButtonElement;

    fireEvent.pointerEnter(button);
    expect(hoverPointerEnterSpy).toHaveBeenCalledTimes(1);

    fireEvent.focus(button);
    expect(hoverFocusSpy).toHaveBeenCalledTimes(1);

    // No dispatch occurred, so the store's hide() must not be called by
    // hover alone — the hint store stays untouched.
    expect(hideMock).not.toHaveBeenCalled();
  });
});
