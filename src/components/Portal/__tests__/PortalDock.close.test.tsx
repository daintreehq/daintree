// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

const dispatchMock = vi.fn().mockResolvedValue({ ok: true });

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (...args: unknown[]) => dispatchMock(...args),
  },
}));

const toolbarProps: { onClose: (() => void) | null } = { onClose: null };

vi.mock("../PortalToolbar", () => ({
  PortalToolbar: (props: { onClose: () => void }) => {
    toolbarProps.onClose = props.onClose;
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

function seedTabs(count: number) {
  const tabs = Array.from({ length: count }, (_, i) => ({
    id: `tab-${i}`,
    url: `https://example.com/${i}`,
    title: `Tab ${i}`,
  }));
  // The store gets its own copies so an in-place mutation can't change the
  // expected value along with the actual one, and the last tab is active so a
  // reset to the first tab shows up.
  act(() => {
    usePortalStore.setState({
      isOpen: true,
      tabs: tabs.map((tab) => ({ ...tab })),
      activeTabId: tabs[tabs.length - 1]!.id,
    });
  });
  return tabs;
}

describe("PortalDock — close button", () => {
  beforeEach(() => {
    dispatchMock.mockReset();
    dispatchMock.mockResolvedValue({ ok: true });
    toolbarProps.onClose = null;

    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: {
        portal: {
          onNavEvent: vi.fn(() => vi.fn()),
          onFocus: vi.fn(() => vi.fn()),
          onBlur: vi.fn(() => vi.fn()),
          resize: vi.fn(),
        },
      },
    });

    usePortalStore.getState().reset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it.each([1, 2, 3, 5])("hides the portal and keeps all %i tabs", (count) => {
    const tabs = seedTabs(count);
    render(<PortalDock />);

    act(() => {
      toolbarProps.onClose!();
    });

    const state = usePortalStore.getState();
    expect(state.isOpen).toBe(false);
    expect(state.tabs).toEqual(tabs);
    expect(state.activeTabId).toBe(tabs[tabs.length - 1]!.id);
  });

  it("does not dispatch portal.closeAllTabs", () => {
    seedTabs(2);
    render(<PortalDock />);

    act(() => {
      toolbarProps.onClose!();
    });

    const dispatched = dispatchMock.mock.calls.map((call) => call[0]);
    expect(dispatched).not.toContain("portal.closeAllTabs");
  });
});
