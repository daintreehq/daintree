// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

const toolbarProps = vi.hoisted(() => ({
  latest: null as { canGoBack?: boolean; canGoForward?: boolean } | null,
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn().mockResolvedValue({ ok: true }) },
}));

vi.mock("../PortalToolbar", () => ({
  PortalToolbar: (props: { canGoBack?: boolean; canGoForward?: boolean }) => {
    toolbarProps.latest = props;
    return null;
  },
}));
vi.mock("../PortalLaunchpad", () => ({
  PortalLaunchpad: () => null,
}));
vi.mock("../PortalTabSkeleton", () => ({
  PortalTabSkeleton: () => null,
}));

import { PortalDock } from "../PortalDock";
import { usePortalStore } from "@/store";

const history = () => ({
  canGoBack: toolbarProps.latest?.canGoBack,
  canGoForward: toolbarProps.latest?.canGoForward,
});

describe("PortalDock — Back and Forward follow the active tab's history (#15040)", () => {
  beforeEach(() => {
    toolbarProps.latest = null;
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
      tabs: [
        { id: "tab-1", title: "A", url: "https://example.com/a" },
        { id: "tab-2", title: "B", url: "https://example.com/b" },
      ],
      activeTabId: "tab-1",
      createdTabs: new Set<string>(["tab-1", "tab-2"]),
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("offers neither direction before main reports the tab's history", () => {
    render(<PortalDock />);

    expect(history()).toEqual({ canGoBack: false, canGoForward: false });
  });

  it("follows the history main reports for the selected tab, and only that tab", () => {
    render(<PortalDock />);

    act(() => {
      usePortalStore.getState().updateTabHistory("tab-1", { canGoBack: true, canGoForward: false });
      usePortalStore.getState().updateTabHistory("tab-2", { canGoBack: false, canGoForward: true });
    });
    expect(history()).toEqual({ canGoBack: true, canGoForward: false });

    act(() => usePortalStore.setState({ activeTabId: "tab-2" }));
    expect(history()).toEqual({ canGoBack: false, canGoForward: true });
  });

  it("offers nothing while the selected tab is still being restored", () => {
    usePortalStore.setState({ createdTabs: new Set<string>(["tab-2"]) });
    usePortalStore.getState().updateTabHistory("tab-1", { canGoBack: true, canGoForward: true });
    render(<PortalDock />);

    expect(history()).toEqual({ canGoBack: false, canGoForward: false });

    act(() => usePortalStore.getState().markTabCreated("tab-1"));
    expect(history()).toEqual({ canGoBack: true, canGoForward: true });
  });
});
