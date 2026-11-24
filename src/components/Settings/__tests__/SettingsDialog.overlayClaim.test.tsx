// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      app: { ...window.electron?.app, isViewCached: () => false },
      window: { ...window.electron?.window, getZoomFactor: () => 1 },
    },
  });
  useUIStore.setState({ overlayStack: [] });
});

afterEach(() => {
  cleanup();
});

describe("SettingsDialog overlay claim (#15029)", () => {
  // Native views (dev previews, plugin panel capture) read the overlay stack,
  // so Settings must hold a claim exactly while it is on screen.
  it("claims the viewport while open and releases it once it has closed", async () => {
    const { rerender } = render(
      <SettingsDialog isOpen={true} onClose={() => {}} defaultTab="general" />
    );

    await waitFor(() => expect(useUIStore.getState().overlayStack.length).toBeGreaterThan(0));

    rerender(<SettingsDialog isOpen={false} onClose={() => {}} defaultTab="general" />);
    // Still painted while it fades out, so still covering what it covered.
    expect(useUIStore.getState().overlayStack.length).toBeGreaterThan(0);

    await waitFor(() => expect(useUIStore.getState().overlayStack).toEqual([]));
  });
});
