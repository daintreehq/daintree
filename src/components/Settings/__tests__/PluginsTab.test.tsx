// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PluginsTab } from "../PluginsTab";
import { SettingsValidationProvider } from "../SettingsValidationRegistry";
import type { LoadedPluginInfo } from "@shared/types/plugin";

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

function makePlugin(overrides: Partial<LoadedPluginInfo> = {}): LoadedPluginInfo {
  return {
    manifest: {
      name: "acme.demo",
      version: "1.0.0",
      displayName: "Acme Demo",
      description: "A demo plugin",
      contributes: {
        panels: [],
        toolbarButtons: [],
        menuItems: [],
        commands: [],
        experimental_views: [],
        experimental_mcpServers: [],
        keybindings: [],
        contextMenus: [],
        forgeProviders: [],
        fileDecorationProviders: [],
      },
    },
    dir: "/plugins/acme.demo",
    loadedAt: 123,
    isBuiltin: false,
    disabled: false,
    pendingRestart: false,
    source: "sideload",
    installedAt: 123,
    archiveHash: null,
    originalUrl: null,
    loadError: null,
    updateAvailable: null,
    devMode: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.electron = {
    plugin: {
      list: vi.fn().mockResolvedValue([]),
      setEnabled: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as typeof window.electron;
});

function renderTab() {
  return render(
    <SettingsValidationProvider>
      <PluginsTab />
    </SettingsValidationProvider>
  );
}

describe("PluginsTab", () => {
  it("renders the section header immediately", async () => {
    renderTab();
    expect(screen.getByText("Installed plugins")).toBeTruthy();
  });

  it("shows an empty state when no plugins are installed", async () => {
    renderTab();
    await waitFor(() => {
      expect(screen.getByText("No plugins installed")).toBeTruthy();
    });
  });

  it("lists installed plugins with a toggle", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([makePlugin()]);
    renderTab();
    await waitFor(() => {
      expect(screen.getByText("Acme Demo")).toBeTruthy();
    });
    const toggle = screen.getByRole("switch", { name: "Enable Acme Demo" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("renders a disabled plugin with the switch off", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePlugin({ disabled: true }),
    ]);
    renderTab();
    await waitFor(() => {
      expect(screen.getByText("Acme Demo")).toBeTruthy();
    });
    const toggle = screen.getByRole("switch", { name: "Enable Acme Demo" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("calls setEnabled(false) and shows a restart badge when disabling", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([makePlugin()]);
    renderTab();
    await waitFor(() => {
      expect(screen.getByText("Acme Demo")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("switch", { name: "Enable Acme Demo" }));

    await waitFor(() => {
      expect(window.electron.plugin.setEnabled).toHaveBeenCalledWith("acme.demo", false);
    });
    await waitFor(() => {
      expect(screen.getByText("Restart required")).toBeTruthy();
    });
  });

  it("keeps the restart badge after a remount (pendingRestart comes from listPlugins)", async () => {
    // After a toggle the main process persists the change and reports it back
    // as disabled+pendingRestart; a tab remount must not lose the cue.
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePlugin({ disabled: true, pendingRestart: true }),
    ]);
    renderTab();
    await waitFor(() => {
      expect(screen.getByText("Restart required")).toBeTruthy();
    });
    const toggle = screen.getByRole("switch", { name: "Enable Acme Demo" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("reverts the switch and shows an error when setEnabled rejects", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([makePlugin()]);
    (window.electron.plugin.setEnabled as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("disk full")
    );
    renderTab();
    await waitFor(() => {
      expect(screen.getByText("Acme Demo")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("switch", { name: "Enable Acme Demo" }));

    await waitFor(() => {
      expect(screen.getByText(/disk full/i)).toBeTruthy();
    });
    const toggle = screen.getByRole("switch", { name: "Enable Acme Demo" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText("Restart required")).toBeNull();
  });

  it("clears the restart badge when toggled back to the startup state", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([makePlugin()]);
    renderTab();
    await waitFor(() => {
      expect(screen.getByText("Acme Demo")).toBeTruthy();
    });
    const toggle = () => screen.getByRole("switch", { name: "Enable Acme Demo" });

    fireEvent.click(toggle());
    await waitFor(() => expect(screen.getByText("Restart required")).toBeTruthy());

    fireEvent.click(toggle());
    await waitFor(() => expect(screen.queryByText("Restart required")).toBeNull());
    expect(window.electron.plugin.setEnabled).toHaveBeenLastCalledWith("acme.demo", true);
  });
});
