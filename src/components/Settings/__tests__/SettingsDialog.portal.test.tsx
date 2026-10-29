// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePortalStore } from "@/store";
import { useUIStore } from "@/store/uiStore";

vi.mock("@/hooks/useProjectSettingsForm", () => ({
  useProjectSettingsForm: () => ({
    currentProject: null,
    projectIsLoading: false,
    flush: async () => {},
    saveNow: async () => {},
  }),
}));
vi.mock("@/components/Hosts/hostList", () => ({ useHostList: () => ({ hosts: [] }) }));
vi.mock("../pluginSettingsSearch", () => ({ usePluginSettingsSearchIndex: () => [] }));
vi.mock("../GeneralTab", () => ({ GeneralTab: () => <p>General page</p> }));
vi.mock("@/clients", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/clients")>()),
  appClient: { getVersionInfo: () => Promise.resolve({ appVersion: "0.0.0", arch: "arm64" }) },
}));

import { SettingsDialog } from "../SettingsDialog";
import { PortalVisibilityController } from "@/components/Portal/PortalVisibilityController";

vi.stubGlobal("requestIdleCallback", () => 0);
vi.stubGlobal("cancelIdleCallback", () => {});
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

const portal = {
  create: vi.fn().mockResolvedValue(undefined),
  show: vi.fn().mockResolvedValue(undefined),
  hide: vi.fn().mockResolvedValue(undefined),
  onTabEvicted: vi.fn(() => () => {}),
  onTabsEvicted: vi.fn(() => () => {}),
  onNavEvent: vi.fn(() => () => {}),
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      ...window.electron,
      globalEnv: { get: vi.fn().mockResolvedValue({}), set: vi.fn() },
      portal,
      app: { ...window.electron?.app, isViewCached: () => false },
      window: { ...window.electron?.window, getZoomFactor: () => 1 },
    },
  });

  const placeholder = document.createElement("div");
  placeholder.id = "portal-placeholder";
  placeholder.getBoundingClientRect = () => ({ x: 900, y: 48, width: 400, height: 600 }) as DOMRect;
  document.body.appendChild(placeholder);

  usePortalStore.setState({
    isOpen: true,
    activeTabId: "tab-1",
    tabs: [{ id: "tab-1", title: "Docs", url: "https://example.com/docs" }],
    createdTabs: new Set(["tab-1"]),
  });
  useUIStore.setState({ overlayStack: [] });
});

afterEach(() => {
  cleanup();
  document.getElementById("portal-placeholder")?.remove();
  usePortalStore.getState().reset();
});

function renderWithPortal(isOpen: boolean) {
  return (
    <>
      <PortalVisibilityController />
      <SettingsDialog isOpen={isOpen} onClose={() => {}} defaultTab="general" />
    </>
  );
}

describe("SettingsDialog and the Portal (#15029)", () => {
  it("hides the Portal while Settings is open and shows the same tab again once it closes", async () => {
    const { rerender } = render(renderWithPortal(true));

    // Settings hides the native view by claiming the viewport, not by collapsing the Portal.
    await waitFor(() => expect(portal.hide).toHaveBeenCalled());
    expect(usePortalStore.getState().isOpen).toBe(true);
    expect(portal.show).not.toHaveBeenCalled();

    rerender(renderWithPortal(false));

    await waitFor(() =>
      expect(portal.show).toHaveBeenCalledWith({
        tabId: "tab-1",
        bounds: { x: 900, y: 48, width: 400, height: 600 },
      })
    );
    expect(useUIStore.getState().overlayStack).toEqual([]);
    expect(usePortalStore.getState().isOpen).toBe(true);
    expect(portal.create).not.toHaveBeenCalled();
  });

  it("leaves a collapsed Portal collapsed through Settings opening and closing", async () => {
    usePortalStore.setState({ isOpen: false });
    const { rerender } = render(renderWithPortal(true));

    await waitFor(() => expect(useUIStore.getState().overlayStack.length).toBeGreaterThan(0));
    expect(usePortalStore.getState().isOpen).toBe(false);

    rerender(renderWithPortal(false));

    await waitFor(() => expect(useUIStore.getState().overlayStack).toEqual([]));
    expect(usePortalStore.getState().isOpen).toBe(false);
    expect(portal.show).not.toHaveBeenCalled();
    expect(portal.create).not.toHaveBeenCalled();
  });
});
