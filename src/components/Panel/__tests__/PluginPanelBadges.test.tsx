// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { LoadedPluginInfo } from "@shared/types/plugin";
import { PluginPanelBadges } from "../PluginPanelBadges";
import { usePluginPanelBadgeStore } from "@/store/pluginPanelBadgeStore";
import { _resetPluginRuntimeStoreForTest, usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { TooltipProvider } from "@/components/ui/tooltip";

const PANEL_ID = "panel-1";
const INSTANCE_ID = "project__b6700c7a__gregpriday.video-manager";

function meta(displayName: string) {
  return new Map([[INSTANCE_ID, { devMode: false, displayName }]]);
}

/** A project-owned entry as `plugin.list()` returns it. */
function listedProjectPlugin(): LoadedPluginInfo {
  return {
    instanceId: INSTANCE_ID,
    origin: "project",
    projectId: "b6700c7a",
    manifest: {
      name: "gregpriday.video-manager",
      version: "1.0.0",
      displayName: "Video Manager",
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
    dir: "/projects/demo/.daintree/plugins/video-manager",
    loadedAt: 1,
    isBuiltin: false,
    source: "sideload",
    installedAt: 1,
    archiveHash: null,
    originalUrl: null,
    loadError: null,
    disabled: false,
    updateAvailable: null,
    devMode: false,
    pendingRestart: false,
    pluginDanger: "safe",
    blocklisted: false,
  };
}

beforeEach(() => {
  _resetPluginRuntimeStoreForTest();
  usePluginPanelBadgeStore.setState({
    badgesByPanelId: { [PANEL_ID]: { [INSTANCE_ID]: { kind: "dot", color: "warning" } } },
    init: () => {},
  });
  usePluginRuntimeStore.setState({
    pluginMetaById: new Map(),
    disabledPluginIds: new Set<string>(),
  });
});

afterEach(() => {
  _resetPluginRuntimeStoreForTest();
  Reflect.deleteProperty(window, "electron");
});

describe("PluginPanelBadges", () => {
  it("labels a badge with the plugin's display name, not its raw instance key", () => {
    // #12211: the aria-label interpolated the id straight in, so a project
    // plugin's badge announced `project__b67…  status`.
    usePluginRuntimeStore.setState({ pluginMetaById: meta("Video Manager") });

    render(<PluginPanelBadges panelId={PANEL_ID} />);

    expect(screen.getByRole("status").getAttribute("aria-label")).toBe("Video Manager status");
  });

  it("labels a label-kind badge with the display name too", () => {
    usePluginPanelBadgeStore.setState({
      badgesByPanelId: {
        [PANEL_ID]: { [INSTANCE_ID]: { kind: "label", text: "12", color: "default" } },
      },
    });
    usePluginRuntimeStore.setState({ pluginMetaById: meta("Video Manager") });

    render(<PluginPanelBadges panelId={PANEL_ID} />);

    expect(screen.getByRole("status").getAttribute("aria-label")).toBe("Video Manager: 12");
  });

  it("falls back to the manifest id before any snapshot lands, staying fail-open", () => {
    render(<PluginPanelBadges panelId={PANEL_ID} />);

    // Fail-open, but never the raw instance key — the fallback drops the
    // machine-local project id rather than showing it to the user.
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe(
      "gregpriday.video-manager status"
    );
  });

  it("pulls a snapshot when a badge names a plugin it has no metadata for", async () => {
    // The store is initialised long before a panel renders, so `init()` would
    // no-op and a plugin that never broadcast provenance would keep its raw id.
    const list = vi.fn(() => Promise.resolve([listedProjectPlugin()]));
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { plugin: { list, onProvenanceChanged: vi.fn(() => () => {}) } },
    });

    render(<PluginPanelBadges panelId={PANEL_ID} />);

    // Renders fail-open first, then upgrades in place once the pull lands.
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe(
      "gregpriday.video-manager status"
    );
    await vi.waitFor(() =>
      expect(screen.getByRole("status").getAttribute("aria-label")).toBe("Video Manager status")
    );
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("does not pull when every badge owner is already known", () => {
    const list = vi.fn(() => Promise.resolve([]));
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { plugin: { list, onProvenanceChanged: vi.fn(() => () => {}) } },
    });
    usePluginRuntimeStore.setState({ pluginMetaById: meta("Video Manager") });

    render(<PluginPanelBadges panelId={PANEL_ID} />);

    expect(list).not.toHaveBeenCalled();
  });

  it("prefers an explicit badge tooltip over any resolved name", () => {
    usePluginPanelBadgeStore.setState({
      badgesByPanelId: {
        [PANEL_ID]: { [INSTANCE_ID]: { kind: "dot", tooltip: "Syncing", color: "default" } },
      },
    });
    usePluginRuntimeStore.setState({ pluginMetaById: meta("Video Manager") });

    render(
      <TooltipProvider>
        <PluginPanelBadges panelId={PANEL_ID} />
      </TooltipProvider>
    );

    expect(screen.getByRole("status").getAttribute("aria-label")).toBe("Syncing");
  });

  it("renders nothing when the panel carries no badges", () => {
    usePluginPanelBadgeStore.setState({ badgesByPanelId: {} });

    const { container } = render(<PluginPanelBadges panelId={PANEL_ID} />);

    expect(container.textContent).toBe("");
    expect(screen.queryByRole("status")).toBeNull();
  });
});
