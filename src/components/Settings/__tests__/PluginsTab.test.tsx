// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PluginsTab } from "../PluginsTab";
import type { LoadedPluginInfo } from "@shared/types/plugin";

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

const dispatch = vi.fn();
vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (...args: unknown[]) => dispatch(...args),
  },
}));

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

function makePlugin(name: string): LoadedPluginInfo {
  return {
    manifest: {
      name,
      version: "1.0.0",
      displayName: name,
      contributes: {
        panels: [],
        toolbarButtons: [],
        menuItems: [],
        commands: [],
        views: [],
        mcpServers: [],
        skills: [],
        keybindings: [],
        contextMenus: [],
        forgeProviders: [],
        fileDecorationProviders: [],
        agents: [],
        processTools: [],
        recipes: [],
      },
    },
    dir: `/plugins/${name}`,
    loadedAt: 1,
    isBuiltin: false,
    disabled: false,
    pendingRestart: false,
    source: "sideload",
    installedAt: 1,
    archiveHash: null,
    originalUrl: null,
    loadError: null,
    updateAvailable: null,
    devMode: false,
    pluginDanger: "safe",
    blocklisted: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.electron = {
    plugin: {
      list: vi.fn().mockResolvedValue([]),
      onProvenanceChanged: vi.fn().mockReturnValue(() => {}),
      getBackgroundUpdateCheckSettings: vi.fn().mockResolvedValue({ enabled: false }),
      setBackgroundUpdateCheckSettings: vi.fn().mockResolvedValue({ enabled: true }),
    },
  } as unknown as typeof window.electron;
});

describe("PluginsTab (settings entry point)", () => {
  it("renders the tab chrome immediately", () => {
    render(<PluginsTab />);
    expect(screen.getByText("Plugin manager")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open plugin manager" })).toBeTruthy();
  });

  it("shows the installed plugin count once the list resolves", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePlugin("a.one"),
      makePlugin("b.two"),
    ]);
    render(<PluginsTab />);
    await waitFor(() => expect(screen.getByText("2 plugins installed.")).toBeTruthy());
  });

  it("singularizes the count for a single plugin", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePlugin("a.one"),
    ]);
    render(<PluginsTab />);
    await waitFor(() => expect(screen.getByText("1 plugin installed.")).toBeTruthy());
  });

  it("shows an empty summary when no plugins are installed", async () => {
    render(<PluginsTab />);
    await waitFor(() => expect(screen.getByText("No plugins installed yet.")).toBeTruthy());
  });

  it("dispatches app.pluginManager when the CTA is clicked", async () => {
    render(<PluginsTab />);
    fireEvent.click(screen.getByRole("button", { name: "Open plugin manager" }));
    expect(dispatch).toHaveBeenCalledWith("app.pluginManager", undefined, { source: "user" });
  });

  it("re-pulls the count when a provenance-changed event fires", async () => {
    let fireProvenance: (() => void) | undefined;
    (window.electron.plugin.onProvenanceChanged as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: () => void) => {
        fireProvenance = cb;
        return () => {};
      }
    );
    const listMock = window.electron.plugin.list as ReturnType<typeof vi.fn>;
    listMock.mockResolvedValue([]);
    render(<PluginsTab />);
    await waitFor(() => expect(screen.getByText("No plugins installed yet.")).toBeTruthy());
    expect(listMock).toHaveBeenCalledTimes(1);

    fireProvenance?.();
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });

  it("loads the background update check toggle as off by default", async () => {
    render(<PluginsTab />);
    const toggle = await screen.findByRole("switch", {
      name: "Background plugin update checks",
    });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
  });

  it("optimistically enables background checks and persists via IPC", async () => {
    render(<PluginsTab />);
    const toggle = await screen.findByRole("switch", {
      name: "Background plugin update checks",
    });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(window.electron.plugin.setBackgroundUpdateCheckSettings).toHaveBeenCalledWith(true)
    );
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  });

  it("reverts the toggle when the save fails", async () => {
    (
      window.electron.plugin.setBackgroundUpdateCheckSettings as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("boom"));
    render(<PluginsTab />);
    const toggle = await screen.findByRole("switch", {
      name: "Background plugin update checks",
    });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(window.electron.plugin.setBackgroundUpdateCheckSettings).toHaveBeenCalledWith(true)
    );
    // Optimistic flip, then revert on the rejected save.
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
  });
});
