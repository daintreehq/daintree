// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";

const { dispatchMock, viewCache } = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  viewCache: { cached: false },
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));
vi.mock("@/lib/viewCacheState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/viewCacheState")>()),
  isProjectViewCached: () => viewCache.cached,
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
import { ToolbarPortalButton } from "@/components/Layout/ToolbarPortalButton";
import { usePortalStore } from "@/store";
import { useUIStore } from "@/store/uiStore";
import { usePanelStore } from "@/store/panelStore";
import { registerPanelFocusHandler } from "@/components/Panel/panelFocusRegistry";
import {
  _resetTooltipFocusSuppressionForTests,
  isTooltipSuppressedForElement,
} from "@/lib/tooltipFocusSuppression";

const originalElectron = Object.getOwnPropertyDescriptor(window, "electron");
let pageFocus: (() => void) | null = null;
let pageBlur: (() => void) | null = null;

beforeEach(() => {
  pageFocus = null;
  pageBlur = null;
  viewCache.cached = false;
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
        onBlur: vi.fn((cb: () => void) => {
          pageBlur = cb;
          return vi.fn();
        }),
        resize: vi.fn(),
        hide: vi.fn(async () => {}),
      },
    },
  });
  usePortalStore.getState().reset();
  useUIStore.setState({ overlayStack: [] });
  usePanelStore.setState({ focusedId: null });
});

afterEach(() => {
  cleanup();
  _resetTooltipFocusSuppressionForTests();
  useUIStore.setState({ overlayStack: [] });
  usePanelStore.setState({ focusedId: null });
  if (originalElectron) Object.defineProperty(window, "electron", originalElectron);
  else delete (window as { electron?: unknown }).electron;
});

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

function focus(el: HTMLElement) {
  act(() => el.focus());
}

describe("PortalDock — context menu over the native page view", () => {
  beforeEach(() => {
    usePortalStore.setState({
      isOpen: true,
      tabs: [{ id: "tab-1", title: "A", url: "https://example.com/a" }],
      activeTabId: "tab-1",
      createdTabs: new Set<string>(["tab-1"]),
    });
  });

  it("claims an overlay while open so the page view hides instead of covering it", async () => {
    renderDock();
    expect(useUIStore.getState().overlayStack).toEqual([]);

    fireEvent.contextMenu(dock());
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(useUIStore.getState().overlayStack).toEqual(["portal-dock-menu"]);

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(useUIStore.getState().overlayStack).toEqual([]);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["New tab", "portal.newTab", undefined],
    ["Close tab", "portal.closeTab", undefined],
    ["Close all tabs", "portal.closeAllTabs", undefined],
    ["Reset width", "portal.resetWidth", undefined],
    ["Portal settings…", "app.settings.openTab", { tab: "portal" }],
  ])("runs %s only after the menu has released its claim", async (label, actionId, args) => {
    const claimsAtDispatch: string[][] = [];
    dispatchMock.mockImplementation(() => {
      claimsAtDispatch.push([...useUIStore.getState().overlayStack]);
      return Promise.resolve({ ok: true });
    });
    renderDock();

    fireEvent.contextMenu(dock());
    fireEvent.click(screen.getByRole("menuitem", { name: label }));

    await waitFor(() => expect(dispatchMock).toHaveBeenCalledOnce());
    expect(dispatchMock).toHaveBeenCalledWith(
      actionId,
      args,
      expect.objectContaining({ source: "context-menu" })
    );
    expect(claimsAtDispatch).toEqual([[]]);
  });

  it("releases only its own claim when the dock unmounts with the menu open", () => {
    useUIStore.setState({ overlayStack: ["unrelated"] });
    const { unmount } = renderDock();

    fireEvent.contextMenu(dock());
    expect(useUIStore.getState().overlayStack).toEqual(["unrelated", "portal-dock-menu"]);

    unmount();
    expect(useUIStore.getState().overlayStack).toEqual(["unrelated"]);
    expect(dispatchMock).not.toHaveBeenCalled();
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
    usePortalStore.setState({ isOpen: true, showDevDashboard: true });
  });

  it.each([
    ["a click", 1, { preventScroll: true, focusVisible: false }],
    ["the keyboard", 0, { preventScroll: true }],
  ])("hands focus to the toolbar's dev servers toggle after %s", (_, detail, options) => {
    renderDock();
    const toggle = screen.getByRole("button", { name: "Dev servers" });
    const focusSpy = vi.spyOn(toggle, "focus");
    const hide = screen.getByRole("button", { name: "Hide dev servers" });
    focus(hide);

    act(() => fireEvent.click(hide, { detail }));

    expect(screen.queryByRole("button", { name: "Hide dev servers" })).toBeNull();
    expect(document.activeElement).toBe(toggle);
    expect(focusSpy).toHaveBeenCalledWith(options);
    expect(isTooltipSuppressedForElement(toggle)).toBe(true);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("PortalDock — focus after the dock closes", () => {
  let paneAccepts: boolean;
  const paneHandler = vi.fn(() => {
    if (!paneAccepts) return false;
    const pane = screen.getByTestId("pane");
    pane.focus();
    return document.activeElement === pane;
  });
  let unregisterPane: (() => void) | null = null;

  function Workspace() {
    const isOpen = usePortalStore((s) => s.isOpen);
    return (
      <TooltipProvider>
        {/* Ahead of the toggle, so a generic first-tabbable fallback lands
            here rather than where the dock means to send focus. */}
        <button type="button">Before</button>
        <ToolbarPortalButton />
        <div data-testid="pane" tabIndex={-1} />
        <input aria-label="Elsewhere" />
        {isOpen && <PortalDock />}
      </TooltipProvider>
    );
  }

  function pane() {
    return screen.getByTestId("pane");
  }

  function webChat() {
    return screen.getByRole("button", { name: "Web chat" });
  }

  beforeEach(() => {
    paneAccepts = true;
    paneHandler.mockClear();
    usePanelStore.setState({ focusedId: "pane-1" });
    unregisterPane = registerPanelFocusHandler("pane-1", paneHandler);
    usePortalStore.setState({ isOpen: true });
  });

  afterEach(() => {
    unregisterPane?.();
    unregisterPane = null;
  });

  it("returns focus from the Close button to the selected pane", () => {
    render(<Workspace />);
    const close = screen.getByRole("button", { name: "Close portal" });
    focus(close);

    act(() => fireEvent.click(close));

    expect(screen.queryByRole("region", { name: "Portal" })).toBeNull();
    expect(document.activeElement).toBe(pane());
  });

  it("falls back to the toolbar's portal toggle when no pane takes focus", () => {
    paneAccepts = false;
    render(<Workspace />);
    expect(document.getElementById(PORTAL_TOGGLE_ID)).toBe(webChat());
    focus(screen.getByRole("button", { name: "Close portal" }));

    act(() => fireEvent.click(screen.getByRole("button", { name: "Close portal" })));

    expect(paneHandler).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(webChat());
    expect(isTooltipSuppressedForElement(webChat())).toBe(true);
  });

  it("restores focus on a store-driven close while the dock's chrome holds it", () => {
    render(<Workspace />);
    focus(screen.getByRole("button", { name: "Dev servers" }));

    act(() => usePortalStore.getState().toggle());

    expect(document.activeElement).toBe(pane());
  });

  it("restores focus when a row of the dock's own menu, outside the aside, holds it", () => {
    render(<Workspace />);
    const aside = dock();
    fireEvent.contextMenu(aside);
    const row = screen.getByRole("menuitem", { name: "New tab" });
    focus(row);
    expect(document.activeElement).toBe(row);
    expect(aside.contains(row)).toBe(false);

    act(() => usePortalStore.getState().setOpen(false));

    expect(document.activeElement).toBe(pane());
  });

  it("returns focus when the page in the native view held it", () => {
    render(<Workspace />);
    act(() => pageFocus!());
    expect(document.activeElement).toBe(document.body);

    act(() => usePortalStore.getState().setOpen(false));

    expect(document.activeElement).toBe(pane());
  });

  it("leaves focus alone once the native page has given it up", () => {
    render(<Workspace />);
    act(() => pageFocus!());
    act(() => pageBlur!());

    act(() => usePortalStore.getState().setOpen(false));

    expect(paneHandler).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });

  it("leaves focus alone when nothing in the dock or its page held it", () => {
    render(<Workspace />);
    expect(document.activeElement).toBe(document.body);

    act(() => usePortalStore.getState().setOpen(false));

    expect(paneHandler).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });

  it.each([
    ["the native page also had focus", true],
    ["only the workspace had focus", false],
  ])("leaves focus where the user put it outside the dock when %s", (_, pageHadFocus) => {
    render(<Workspace />);
    if (pageHadFocus) act(() => pageFocus!());
    const elsewhere = screen.getByRole("textbox", { name: "Elsewhere" });
    focus(elsewhere);

    act(() => usePortalStore.getState().setOpen(false));

    expect(paneHandler).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(elsewhere);
  });

  it("moves nothing while its project view is cached off screen", () => {
    viewCache.cached = true;
    render(<Workspace />);
    const close = screen.getByRole("button", { name: "Close portal" });
    focus(close);

    act(() => fireEvent.click(close));

    expect(paneHandler).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(webChat());
  });
});
