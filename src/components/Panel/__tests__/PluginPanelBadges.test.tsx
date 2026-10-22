// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { LoadedPluginInfo } from "@shared/types/plugin";
import { PluginPanelBadges } from "../PluginPanelBadges";
import { usePluginPanelBadgeStore } from "@/store/pluginPanelBadgeStore";
import { _resetPluginRuntimeStoreForTest, usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePanelStore } from "@/store/panelStore";
import { registerPanelKind, unregisterPanelKind } from "@shared/config/panelKindRegistry";

const PANEL_ID = "panel-1";
const INSTANCE_ID = "project__b6700c7a__gregpriday.video-manager";
const OWN_KIND = "gregpriday.video-manager.board";
const OTHER_KIND = "acme.other.board";

function registerKind(id: string, extensionId: string, hasPty = false): void {
  registerPanelKind({
    id,
    name: "Board",
    iconId: "puzzle",
    color: "#abcdef",
    hasPty,
    canRestart: false,
    canConvert: false,
    extensionId,
  });
}

function seedPanel(panel: { kind: string; pluginPanelKindId?: string }): void {
  usePanelStore.setState({
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    panelsById: { [PANEL_ID]: { id: PANEL_ID, title: "Panel", ...panel } as never },
  });
}

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
        fileEditors: [],
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
  // The plugin's own panel by default: the foreign-panel cases set their own.
  registerKind(OWN_KIND, INSTANCE_ID);
  seedPanel({ kind: OWN_KIND });
});

afterEach(() => {
  _resetPluginRuntimeStoreForTest();
  Reflect.deleteProperty(window, "electron");
  unregisterPanelKind(OWN_KIND);
  unregisterPanelKind(OTHER_KIND);
  usePanelStore.setState({ panelsById: {} });
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

  it("tells a warning dot from an error dot by shape, not only by hue", () => {
    // Forced colours paint both in one ink, so the outline is all that is left.
    const shapeOf = (color: "warning" | "error") => {
      usePluginPanelBadgeStore.setState({
        badgesByPanelId: { [PANEL_ID]: { [INSTANCE_ID]: { kind: "dot", color } } },
      });
      const { container, unmount } = render(<PluginPanelBadges panelId={PANEL_ID} />);
      const svg = container.querySelector("svg");
      const shape = svg?.innerHTML ?? "";
      unmount();
      return shape;
    };
    const warning = shapeOf("warning");
    const error = shapeOf("error");
    expect(warning).not.toBe("");
    expect(error).not.toBe("");
    expect(warning).not.toBe(error);
  });
});

describe("PluginPanelBadges on a panel the plugin does not own (#13766)", () => {
  function renderBadge(badge: Parameters<typeof setBadge>[0]) {
    setBadge(badge);
    usePluginRuntimeStore.setState({ pluginMetaById: meta("Video Manager") });
    return render(<PluginPanelBadges panelId={PANEL_ID} />);
  }

  function setBadge(badge: {
    kind: "dot" | "label";
    text?: string;
    color?: "default" | "success" | "warning" | "error";
    tooltip?: string;
  }) {
    usePluginPanelBadgeStore.setState({
      badgesByPanelId: {
        [PANEL_ID]: {
          [INSTANCE_ID]:
            badge.kind === "label"
              ? {
                  kind: "label",
                  text: badge.text ?? "3",
                  color: badge.color,
                  tooltip: badge.tooltip,
                }
              : { kind: "dot", color: badge.color, tooltip: badge.tooltip },
        },
      },
    });
  }

  /** The dot or pill as drawn, with what the same badge looks like at `default`. */
  function paintOf(badge: Parameters<typeof setBadge>[0]) {
    const { container, unmount } = renderBadge(badge);
    const drawn = {
      glyph: container.querySelector("svg") !== null,
      className: screen.getByRole("status").className,
    };
    unmount();
    const { unmount: unmountNeutral } = renderBadge({ ...badge, color: "default" });
    const neutral = screen.getByRole("status").className;
    unmountNeutral();
    return { ...drawn, neutral };
  }

  it("draws an error dot on an agent terminal as a neutral dot, without the severity glyph", () => {
    seedPanel({ kind: "terminal" });

    const paint = paintOf({ kind: "dot", color: "error" });

    expect(paint.glyph).toBe(false);
    expect(paint.className).toBe(paint.neutral);
  });

  it("draws warning, error and success labels on a foreign panel exactly as a default one", () => {
    seedPanel({ kind: "terminal" });

    for (const color of ["warning", "error", "success"] as const) {
      const paint = paintOf({ kind: "label", text: "3", color });
      expect(paint.className).toBe(paint.neutral);
    }
  });

  it("names the plugin in the label of a badge on a foreign panel", () => {
    seedPanel({ kind: "terminal" });

    renderBadge({ kind: "dot", color: "warning", tooltip: "2 checks failing" });

    expect(screen.getByRole("status").getAttribute("aria-label")).toBe(
      "Video Manager: 2 checks failing"
    );
  });

  it("treats a panel of another plugin's kind as foreign", () => {
    registerKind(OTHER_KIND, "acme.other");
    seedPanel({ kind: OTHER_KIND });

    const paint = paintOf({ kind: "dot", color: "error" });

    expect(paint.glyph).toBe(false);
    expect(paint.className).toBe(paint.neutral);
  });

  it("treats a panel it cannot find as foreign", () => {
    usePanelStore.setState({ panelsById: {} });

    const paint = paintOf({ kind: "dot", color: "error" });

    expect(paint.glyph).toBe(false);
  });

  it("keeps full colour on the plugin's own panel", () => {
    const { container } = renderBadge({ kind: "dot", color: "error", tooltip: "Sync failed" });

    expect(container.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe("Sync failed");
  });

  it("counts a PTY-backed panel opened as the plugin's kind as its own", () => {
    registerKind(OWN_KIND, INSTANCE_ID, true);
    seedPanel({ kind: "terminal", pluginPanelKindId: OWN_KIND });

    const { container } = renderBadge({ kind: "dot", color: "error" });

    expect(container.querySelector("svg")).not.toBeNull();
  });
});
