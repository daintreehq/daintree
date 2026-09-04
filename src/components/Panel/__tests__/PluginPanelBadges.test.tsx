// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { PluginPanelBadges } from "../PluginPanelBadges";
import { usePluginPanelBadgeStore } from "@/store/pluginPanelBadgeStore";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { TooltipProvider } from "@/components/ui/tooltip";

const PANEL_ID = "panel-1";
const INSTANCE_ID = "project__b6700c7a__gregpriday.video-manager";

beforeEach(() => {
  usePluginPanelBadgeStore.setState({
    badgesByPanelId: { [PANEL_ID]: { [INSTANCE_ID]: { kind: "dot", color: "warning" } } },
    init: () => {},
  });
  usePluginRuntimeStore.setState({
    pluginMetaById: new Map(),
    disabledPluginIds: new Set<string>(),
    init: () => {},
  });
});

describe("PluginPanelBadges", () => {
  it("labels a badge with the plugin's display name, not its raw instance key", () => {
    // #12211: the aria-label interpolated the id straight in, so a project
    // plugin's badge announced `project__b67…  status`.
    usePluginRuntimeStore.setState({
      pluginMetaById: new Map([[INSTANCE_ID, { devMode: false, displayName: "Video Manager" }]]),
    });

    render(<PluginPanelBadges panelId={PANEL_ID} />);

    expect(screen.getByRole("status").getAttribute("aria-label")).toBe("Video Manager status");
  });

  it("labels a label-kind badge with the display name too", () => {
    usePluginPanelBadgeStore.setState({
      badgesByPanelId: {
        [PANEL_ID]: { [INSTANCE_ID]: { kind: "label", text: "12", color: "default" } },
      },
    });
    usePluginRuntimeStore.setState({
      pluginMetaById: new Map([[INSTANCE_ID, { devMode: false, displayName: "Video Manager" }]]),
    });

    render(<PluginPanelBadges panelId={PANEL_ID} />);

    expect(screen.getByRole("status").getAttribute("aria-label")).toBe("Video Manager: 12");
  });

  it("falls back to the id before the first snapshot lands, staying fail-open", () => {
    render(<PluginPanelBadges panelId={PANEL_ID} />);

    expect(screen.getByRole("status").getAttribute("aria-label")).toBe(`${INSTANCE_ID} status`);
  });

  it("prefers an explicit badge tooltip over any resolved name", () => {
    usePluginPanelBadgeStore.setState({
      badgesByPanelId: {
        [PANEL_ID]: { [INSTANCE_ID]: { kind: "dot", tooltip: "Syncing", color: "default" } },
      },
    });
    usePluginRuntimeStore.setState({
      pluginMetaById: new Map([[INSTANCE_ID, { devMode: false, displayName: "Video Manager" }]]),
    });

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
