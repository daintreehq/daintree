// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";

const { dispatchMock } = vi.hoisted(() => ({ dispatchMock: vi.fn() }));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));
vi.mock("@/store/allDevSessionsStore", () => ({
  useAllDevSessions: () => ({ sessions: [], hydrated: true, fetchError: false }),
}));
vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (s: unknown) => unknown) => selector({ worktrees: new Map() }),
}));
vi.mock("../PortalLaunchpad", () => ({
  PortalLaunchpad: () => null,
}));
vi.mock("../PortalTabSkeleton", () => ({
  PortalTabSkeleton: () => null,
}));

import { PortalDock } from "../PortalDock";
import { PORTAL_TOGGLE_ID } from "../portalTabIds";
import { usePortalStore } from "@/store";
import { useUIStore } from "@/store/uiStore";
import { usePanelStore } from "@/store/panelStore";
import { registerPanelFocusHandler } from "@/components/Panel/panelFocusRegistry";

function renderDock() {
  return render(
    <TooltipProvider>
      <PortalDock />
    </TooltipProvider>
  );
}

function dock() {
  return screen.getByRole("region", { name: "Portal" });
}

describe("PortalDock — context menu over the native page view", () => {
  beforeEach(() => {
    dispatchMock.mockReset();
    dispatchMock.mockResolvedValue({ ok: true });
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: {
        portal: {
          onNavEvent: vi.fn(() => vi.fn()),
          onFocus: vi.fn(() => vi.fn()),
          onBlur: vi.fn(() => vi.fn()),
          resize: vi.fn(),
          hide: vi.fn(async () => {}),
        },
      },
    });
    usePortalStore.getState().reset();
    usePortalStore.setState({
      isOpen: true,
      tabs: [{ id: "tab-1", title: "A", url: "https://example.com/a" }],
      activeTabId: "tab-1",
      createdTabs: new Set<string>(["tab-1"]),
    });
    useUIStore.setState({ overlayStack: [] });
  });

  afterEach(() => {
    cleanup();
    useUIStore.setState({ overlayStack: [] });
  });

  it("claims an overlay while open so the page view hides instead of covering it", async () => {
    renderDock();
    expect(useUIStore.getState().overlayStack).toEqual([]);

    fireEvent.contextMenu(dock());
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(useUIStore.getState().overlayStack.length).toBe(1);

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(useUIStore.getState().overlayStack).toEqual([]);
  });

  it("runs a chosen command only after the menu has released its claim", async () => {
    const claimsAtDispatch: number[] = [];
    dispatchMock.mockImplementation(() => {
      claimsAtDispatch.push(useUIStore.getState().overlayStack.length);
      return Promise.resolve({ ok: true });
    });
    renderDock();

    fireEvent.contextMenu(dock());
    fireEvent.click(screen.getByRole("menuitem", { name: /Close tab/ }));

    await waitFor(() =>
      expect(dispatchMock).toHaveBeenCalledWith(
        "portal.closeTab",
        undefined,
        expect.objectContaining({ source: "context-menu" })
      )
    );
    expect(claimsAtDispatch).toEqual([0]);
  });

  it("points the resize handle at the dock it resizes", () => {
    renderDock();
    const handle = screen.getByRole("separator", { name: /^Resize portal panel/ });
    const controls = handle.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    expect(document.getElementById(controls!)).toBe(dock());
  });
});

describe("PortalDock — focus after hiding the dev servers dashboard", () => {
  beforeEach(() => {
    dispatchMock.mockReset();
    dispatchMock.mockResolvedValue({ ok: true });
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: {
        portal: {
          onNavEvent: vi.fn(() => vi.fn()),
          onFocus: vi.fn(() => vi.fn()),
          onBlur: vi.fn(() => vi.fn()),
          resize: vi.fn(),
          hide: vi.fn(async () => {}),
        },
      },
    });
    usePortalStore.getState().reset();
    usePortalStore.setState({ isOpen: true, showDevDashboard: true });
  });

  afterEach(() => cleanup());

  it("hands focus to the toolbar's dev servers toggle instead of dropping it", () => {
    renderDock();
    const hide = screen.getByRole("button", { name: "Hide dev servers" });
    hide.focus();
    expect(document.activeElement).toBe(hide);

    act(() => fireEvent.click(hide));

    expect(screen.queryByRole("button", { name: "Hide dev servers" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Dev servers" }));
  });
});

describe("PortalDock — focus after the dock closes", () => {
  let pageFocus: (() => void) | null;
  let unregisterPane: (() => void) | null;

  function Workspace() {
    const isOpen = usePortalStore((s) => s.isOpen);
    return (
      <TooltipProvider>
        <div data-testid="pane" tabIndex={-1} />
        <button type="button" id={PORTAL_TOGGLE_ID}>
          Web chat
        </button>
        <input aria-label="Elsewhere" />
        {isOpen && <PortalDock />}
      </TooltipProvider>
    );
  }

  function registerPane(accepts = true) {
    usePanelStore.setState({ focusedId: "pane-1" });
    unregisterPane = registerPanelFocusHandler("pane-1", () => {
      if (!accepts) return false;
      const pane = screen.getByTestId("pane");
      pane.focus();
      return document.activeElement === pane;
    });
  }

  beforeEach(() => {
    pageFocus = null;
    unregisterPane = null;
    dispatchMock.mockReset();
    dispatchMock.mockResolvedValue({ ok: true });
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: {
        portal: {
          onNavEvent: vi.fn(() => vi.fn()),
          onFocus: vi.fn((cb: () => void) => {
            pageFocus = cb;
            return vi.fn();
          }),
          onBlur: vi.fn(() => vi.fn()),
          resize: vi.fn(),
          hide: vi.fn(async () => {}),
        },
      },
    });
    usePortalStore.getState().reset();
    usePortalStore.setState({ isOpen: true });
    usePanelStore.setState({ focusedId: null });
  });

  afterEach(() => {
    unregisterPane?.();
    cleanup();
    usePanelStore.setState({ focusedId: null });
  });

  it("returns focus from the Close button to the selected pane", () => {
    registerPane();
    render(<Workspace />);
    const close = screen.getByRole("button", { name: "Close portal" });
    close.focus();

    act(() => fireEvent.click(close));

    expect(screen.queryByRole("region", { name: "Portal" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("pane"));
  });

  it("falls back to the portal toggle when no pane takes focus", () => {
    registerPane(false);
    render(<Workspace />);
    const close = screen.getByRole("button", { name: "Close portal" });
    close.focus();

    act(() => fireEvent.click(close));

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Web chat" }));
  });

  it("covers a close from outside the Close button, such as the toggle shortcut", () => {
    registerPane();
    render(<Workspace />);
    screen.getByRole("button", { name: "Dev servers" }).focus();

    act(() => usePortalStore.getState().toggle());

    expect(document.activeElement).toBe(screen.getByTestId("pane"));
  });

  it("returns focus when the page in the native view held it", () => {
    registerPane();
    render(<Workspace />);
    act(() => pageFocus!());
    expect(document.activeElement).toBe(document.body);

    act(() => usePortalStore.getState().setOpen(false));

    expect(document.activeElement).toBe(screen.getByTestId("pane"));
  });

  it("leaves focus alone when the dock did not hold it", () => {
    registerPane();
    render(<Workspace />);
    const elsewhere = screen.getByRole("textbox", { name: "Elsewhere" });
    elsewhere.focus();

    act(() => usePortalStore.getState().setOpen(false));

    expect(document.activeElement).toBe(elsewhere);
  });
});
