// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react";
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

beforeEach(() => {
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      ...window.electron,
      globalEnv: { get: vi.fn().mockResolvedValue({}), set: vi.fn() },
    },
  });
  usePortalStore.setState({ isOpen: true });
  useUIStore.setState({ overlayStack: [] });
});

afterEach(() => {
  usePortalStore.setState({ isOpen: false });
});

describe("SettingsDialog and an open Portal (#15029)", () => {
  it("leaves the Portal open while Settings covers it, and after Settings closes", async () => {
    const { rerender } = render(<SettingsDialog isOpen onClose={() => {}} defaultTab="general" />);

    // Settings hides the Portal's native view by claiming the viewport, not by collapsing it.
    await waitFor(() => {
      expect(useUIStore.getState().overlayStack.length).toBeGreaterThan(0);
    });
    expect(usePortalStore.getState().isOpen).toBe(true);

    rerender(<SettingsDialog isOpen={false} onClose={() => {}} defaultTab="general" />);

    await waitFor(() => {
      expect(useUIStore.getState().overlayStack).toEqual([]);
    });
    expect(usePortalStore.getState().isOpen).toBe(true);
  });
});
