// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ToolbarCommandPaletteButton } from "../ToolbarCommandPaletteButton";

const dispatchMock = vi.fn<(...args: unknown[]) => Promise<{ ok: true; result: undefined }>>(() =>
  Promise.resolve({ ok: true, result: undefined })
);
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
  ContextMenuActionItem: ({
    actionId,
    args,
    children,
    onSelect,
  }: {
    actionId: string;
    args?: unknown;
    children: React.ReactNode;
    onSelect?: (e: { defaultPrevented: boolean; preventDefault: () => void }) => void;
  }) => (
    <button
      type="button"
      data-testid="context-menu-action-item"
      data-action-id={actionId}
      data-args={JSON.stringify(args)}
      onClick={() => {
        const fakeEvent = {
          defaultPrevented: false,
          preventDefault: () => {
            (fakeEvent as { defaultPrevented: boolean }).defaultPrevented = true;
          },
        };
        onSelect?.(fakeEvent);
      }}
    >
      {children}
    </button>
  ),
  ContextMenuSeparator: () => <hr />,
  ContextMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuSub: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuSubContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuSubTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuRadioGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuRadioItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuCheckboxItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuShortcut: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  ContextMenuPortal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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
    hoverFocusSpy.mockClear();
    hoverPointerEnterSpy.mockClear();
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

  // Tooltip and shortcut-hint teardown around the palette's open/close is
  // now global (AppPaletteDialog overlay clearing + the shared focus-open
  // suppression window, issue #11030) — covered by dialogOverlayClearing
  // and Tooltip tests, so this component only forwards the hint handlers.
  it("forwards focus and pointer-enter to the shortcut-hint hook", () => {
    const { container } = render(<ToolbarCommandPaletteButton />);
    const button = container.querySelector(
      'button[aria-label="Command palette"]'
    ) as HTMLButtonElement;

    fireEvent.pointerEnter(button);
    expect(hoverPointerEnterSpy).toHaveBeenCalledTimes(1);

    fireEvent.focus(button);
    expect(hoverFocusSpy).toHaveBeenCalledTimes(1);
  });
});
