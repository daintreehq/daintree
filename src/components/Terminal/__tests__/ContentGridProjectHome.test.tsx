// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("@/components/Plugin/ProjectSurfaceFrame", () => ({
  ProjectSurfaceFrame: ({ slot, children }: { slot: string; children: ReactNode }) => (
    <div data-testid="frame" data-slot={slot}>
      {children}
    </div>
  ),
}));
vi.mock("@/components/Plugin/ProjectSurfaceView", () => ({
  ProjectSurfaceView: ({ config }: { config: { id: string } }) => (
    <div data-testid="home-view" data-kind={config.id} />
  ),
}));
vi.mock("@/components/Plugin/SurfacePaletteAction", () => ({ SurfacePaletteAction: () => null }));
vi.mock("@/components/Plugin/ProjectPluginTrustBanner", () => ({
  ProjectPluginTrustBanner: () => <div data-testid="trust-banner" />,
}));
vi.mock("@/components/Plugin/ProjectLayoutSeedNotice", () => ({
  ProjectLayoutSeedNotice: () => null,
}));
vi.mock("@/components/Project/ProjectPresentationNotice", () => ({
  ProjectPresentationNotice: () => <div data-testid="presentation-notice" />,
}));
vi.mock("../GridNotificationBar", () => ({
  GridNotificationBar: () => <div data-testid="grid-notification-bar" />,
}));
vi.mock("../TerminalCountWarning", () => ({
  TerminalCountWarning: () => <div data-testid="terminal-count-warning" />,
}));
vi.mock("../BatchScrollbackRestoreBar", () => ({
  BatchScrollbackRestoreBar: () => <div data-testid="batch-restore-bar" />,
}));

import type { PanelKindConfig } from "@shared/config/panelKindRegistry";
import { ContentGridProjectHome } from "../ContentGridProjectHome";
import { useProjectHomeStore } from "@/store/projectHomeStore";

const config: PanelKindConfig = {
  id: "project:p1/acme.dash/home",
  name: "Home",
  iconId: "puzzle",
  color: "#ffffff",
  hasPty: false,
  canRestart: false,
  canConvert: false,
};

afterEach(() => {
  act(() => {
    useProjectHomeStore.setState({ presented: false });
  });
});

describe("ContentGridProjectHome", () => {
  it("keeps the grid's banner stack above the plugin's view, framed as the Home slot", () => {
    render(
      <ContentGridProjectHome config={config} isMacroFocused={false} bindGridRegion={() => {}} />
    );

    const region = screen.getByRole("region", { name: "Project home" });
    const order = Array.from(region.querySelectorAll("[data-testid]")).map((node) =>
      node.getAttribute("data-testid")
    );
    expect(order).toEqual([
      "grid-notification-bar",
      "trust-banner",
      "presentation-notice",
      "terminal-count-warning",
      "batch-restore-bar",
      "frame",
      "home-view",
    ]);
    expect(screen.getByTestId("frame").getAttribute("data-slot")).toBe("projectHome");
    expect(screen.getByTestId("home-view").getAttribute("data-kind")).toBe(config.id);
  });

  it("says Home is on screen only while it is mounted", () => {
    const { unmount } = render(
      <ContentGridProjectHome config={config} isMacroFocused={false} bindGridRegion={() => {}} />
    );
    expect(useProjectHomeStore.getState().presented).toBe(true);

    unmount();
    expect(useProjectHomeStore.getState().presented).toBe(false);
  });

  it("registers itself as the main area's focus region", () => {
    const bindGridRegion = vi.fn();
    render(
      <ContentGridProjectHome
        config={config}
        isMacroFocused={false}
        bindGridRegion={bindGridRegion}
      />
    );

    expect(bindGridRegion).toHaveBeenCalledWith(
      screen.getByRole("region", { name: "Project home" })
    );
  });

  describe("beside the grid (#14107)", () => {
    it("leaves the banners, the focus region and the focused panel to the grid", () => {
      const bindGridRegion = vi.fn();
      render(
        <ContentGridProjectHome
          config={config}
          beside
          isMacroFocused
          bindGridRegion={bindGridRegion}
        />
      );

      const region = screen.getByRole("region", { name: "Project home" });
      const order = Array.from(region.querySelectorAll("[data-testid]")).map((node) =>
        node.getAttribute("data-testid")
      );
      expect(order).toEqual(["frame", "home-view"]);
      expect(bindGridRegion).not.toHaveBeenCalledWith(region);
      expect(region.getAttribute("data-macro-focus")).toBeNull();
      expect(useProjectHomeStore.getState().presented).toBe(false);
    });

    it("keeps the plugin's view mounted, and stops covering the grid, when Home moves beside it", () => {
      const { rerender } = render(
        <ContentGridProjectHome config={config} isMacroFocused={false} bindGridRegion={() => {}} />
      );
      const view = screen.getByTestId("home-view");
      expect(useProjectHomeStore.getState().presented).toBe(true);

      rerender(
        <ContentGridProjectHome
          config={config}
          beside
          isMacroFocused={false}
          bindGridRegion={() => {}}
        />
      );

      expect(screen.getByTestId("home-view")).toBe(view);
      expect(useProjectHomeStore.getState().presented).toBe(false);
    });
  });
});
