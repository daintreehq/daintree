// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const dispatchMock = vi.fn().mockResolvedValue({ ok: true });

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (...args: unknown[]) => dispatchMock(...args),
  },
}));

vi.mock("../PortalToolbar", () => ({
  PortalToolbar: () => null,
}));
vi.mock("../PortalLaunchpad", () => ({
  PortalLaunchpad: () => null,
}));
vi.mock("../PortalTabSkeleton", () => ({
  PortalTabSkeleton: () => <div data-testid="portal-tab-skeleton" />,
}));

import { PortalDock } from "../PortalDock";
import { usePortalStore } from "@/store";

const URL_A = "https://example.com/chat/a";

const skeleton = () => document.querySelector('[data-testid="portal-tab-skeleton"]');
const failure = () => document.querySelector('[role="alert"]');

function selectUncreatedTab(activeTabId = "tab-1") {
  act(() => {
    usePortalStore.setState({
      isOpen: true,
      tabs: [
        { id: "tab-1", title: "A", url: URL_A },
        { id: "tab-2", title: "B", url: "https://example.com/b" },
      ],
      activeTabId,
      createdTabs: new Set<string>(),
    });
  });
}

describe("PortalDock — a tab whose restore gives up (#15043)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
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
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("swaps a showing skeleton for the failure at once, naming the page", () => {
    selectUncreatedTab();
    render(<PortalDock />);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(skeleton()).not.toBeNull();

    act(() => usePortalStore.getState().markTabRestoreFailed("tab-1"));

    expect(skeleton()).toBeNull();
    expect(failure()?.textContent).toContain("Couldn't restore this page");
    expect(failure()?.textContent).toContain(URL_A);
    expect(usePortalStore.getState().tabs[0]!.url).toBe(URL_A);
  });

  it("goes back to loading on Retry", () => {
    selectUncreatedTab();
    act(() => usePortalStore.getState().markTabRestoreFailed("tab-1"));
    render(<PortalDock />);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(usePortalStore.getState().restoreFailedTabs.size).toBe(0);
    expect(failure()).toBeNull();
    expect(skeleton()).not.toBeNull();
  });

  it("keeps focus in the dock when Retry takes itself away", () => {
    selectUncreatedTab();
    act(() => usePortalStore.getState().markTabRestoreFailed("tab-1"));
    render(<PortalDock />);
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();

    fireEvent.click(retry);

    expect(retry.isConnected).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Portal" }));
  });

  it("opens the failed tab's page in the system browser", () => {
    selectUncreatedTab("tab-2");
    act(() => usePortalStore.getState().markTabRestoreFailed("tab-2"));
    render(<PortalDock />);

    fireEvent.click(screen.getByRole("button", { name: "Open in external browser" }));

    expect(dispatchMock).toHaveBeenCalledWith(
      "portal.openTabExternal",
      { tabId: "tab-2" },
      { source: "user" }
    );
  });

  it("shows another tab's failure only while that tab is selected", () => {
    selectUncreatedTab();
    act(() => usePortalStore.getState().markTabRestoreFailed("tab-1"));
    render(<PortalDock />);
    expect(failure()).not.toBeNull();

    act(() => usePortalStore.setState({ activeTabId: "tab-2" }));

    expect(failure()).toBeNull();
  });
});
