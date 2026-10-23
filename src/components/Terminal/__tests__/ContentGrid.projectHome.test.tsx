// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const harness = vi.hoisted(() => ({
  surface: null as null | { config: { id: string } },
  ctx: {
    isFleetScopeRender: false,
    maximizedId: null as string | null,
    maximizeTarget: null as null | { type: "panel" | "group"; id: string },
    maximizedGroup: null,
    maximizedGroupPanels: [] as unknown[],
    gridTerminals: [] as { id: string }[],
  },
}));

vi.mock("../useContentGridContext", () => ({
  useContentGridContext: () => ({
    ctx: harness.ctx,
    bindCombinedGrid: () => {},
    bindGridRegion: () => {},
  }),
}));
vi.mock("@/components/Plugin/ProjectSurfaceView", () => ({
  useProjectSurface: (slot: string) => (slot === "projectHome" ? harness.surface : null),
}));
let mounts = 0;
function MountToken({ testId, extra }: { testId: string; extra?: Record<string, string> }) {
  // Counts mounts, so a test can tell a kept element from a remounted one.
  const [token] = useState(() => String(++mounts));
  return <div data-testid={testId} data-mount={token} {...extra} />;
}

vi.mock("../ContentGridDefault", () => ({
  ContentGridDefault: () => <MountToken testId="grid-default" />,
}));
vi.mock("../ContentGridFleetScope", () => ({
  ContentGridFleetScope: () => <div data-testid="grid-fleet" />,
}));
vi.mock("../ContentGridMaximizedSingle", () => ({
  ContentGridMaximizedSingle: () => <div data-testid="grid-maximized" />,
}));
vi.mock("../ContentGridMaximizedGroup", () => ({
  ContentGridMaximizedGroup: () => <div data-testid="grid-maximized-group" />,
}));
vi.mock("../ContentGridProjectHome", () => ({
  ContentGridProjectHome: ({ config, beside }: { config: { id: string }; beside?: boolean }) => (
    <MountToken
      testId="grid-home"
      extra={{ "data-kind": config.id, "data-beside": beside ? "true" : "false" }}
    />
  ),
}));

import { useState } from "react";
import type { ProjectApplicationState } from "@shared/types/plugin";
import { ContentGrid } from "../ContentGrid";
import { usePanelStore } from "@/store/panelStore";
import { useProjectHomeStore } from "@/store/projectHomeStore";
import { useProjectPluginStore } from "@/store/projectPluginStore";

const HOME_SURFACE = { config: { id: "project:p1/acme.dash/home" } };

const radio = (name: string) => screen.getByRole("radio", { name });
const checked = (name: string) => radio(name).getAttribute("aria-checked");

beforeAll(() => {
  Object.defineProperty(window, "__DAINTREE_INITIAL_PROJECT__", {
    configurable: true,
    writable: true,
    value: { id: "p1" },
  });
});

beforeEach(() => {
  harness.surface = null;
  harness.ctx.isFleetScopeRender = false;
  harness.ctx.maximizedId = null;
  harness.ctx.maximizeTarget = null;
  harness.ctx.gridTerminals = [];
  act(() => {
    useProjectHomeStore.setState({ routeByProject: {}, presented: false });
    useProjectPluginStore.setState({ application: null });
  });
});

afterEach(() => {
  act(() => {
    useProjectHomeStore.setState({ routeByProject: {}, presented: false });
    useProjectPluginStore.setState({ application: null });
  });
});

const mountOf = (testId: string) => screen.getByTestId(testId).getAttribute("data-mount");

function activeApplication(
  patch: Partial<ProjectApplicationState["application"]>
): ProjectApplicationState {
  return {
    status: "active",
    ownerId: "acme.dash",
    instanceId: "project:p1/acme.dash",
    application: { name: "Dash", destination: "home", ...patch },
    fallback: null,
  };
}

describe("ContentGrid with a project Home", () => {
  it("draws the grid and no switch in a project without a Home", () => {
    act(() => useProjectHomeStore.getState().showHome());
    render(<ContentGrid />);

    expect(screen.getByTestId("grid-default")).not.toBeNull();
    expect(screen.queryByTestId("grid-home")).toBeNull();
    expect(screen.queryByTestId("project-home-nav")).toBeNull();
  });

  it("offers Home beside the grid and lands on the grid by default", () => {
    harness.surface = HOME_SURFACE;
    render(<ContentGrid />);

    expect(screen.getByTestId("grid-default")).not.toBeNull();
    expect(checked("Grid")).toBe("true");
    expect(checked("Home")).toBe("false");
  });

  it("switches between Home and the grid from the host switch, which stays put", () => {
    harness.surface = HOME_SURFACE;
    render(<ContentGrid />);
    const nav = screen.getByTestId("project-home-nav");

    act(() => {
      fireEvent.click(radio("Home"));
    });

    expect(screen.getByTestId("grid-home").getAttribute("data-kind")).toBe(HOME_SURFACE.config.id);
    expect(screen.queryByTestId("grid-default")).toBeNull();
    expect(checked("Home")).toBe("true");
    // The same element, so focus on it survives the switch.
    expect(screen.getByTestId("project-home-nav")).toBe(nav);

    act(() => {
      fireEvent.click(radio("Grid"));
    });

    expect(screen.getByTestId("grid-default")).not.toBeNull();
    expect(screen.queryByTestId("grid-home")).toBeNull();
    expect(screen.getByTestId("project-home-nav")).toBe(nav);
  });

  it("lets fleet scope draw over Home, and Home return after it", () => {
    harness.surface = HOME_SURFACE;
    act(() => useProjectHomeStore.getState().showHome());
    harness.ctx.isFleetScopeRender = true;
    const { rerender } = render(<ContentGrid />);

    expect(screen.getByTestId("grid-fleet")).not.toBeNull();
    expect(screen.queryByTestId("grid-home")).toBeNull();
    expect(screen.queryByTestId("project-home-nav")).toBeNull();

    harness.ctx.isFleetScopeRender = false;
    rerender(<ContentGrid />);
    expect(screen.getByTestId("grid-home")).not.toBeNull();
  });

  it("lets a maximized panel draw over Home", () => {
    harness.surface = HOME_SURFACE;
    act(() => useProjectHomeStore.getState().showHome());
    harness.ctx.maximizedId = "t1";
    harness.ctx.maximizeTarget = { type: "panel", id: "t1" };
    harness.ctx.gridTerminals = [{ id: "t1" }];
    render(<ContentGrid />);

    expect(screen.getByTestId("grid-maximized")).not.toBeNull();
    expect(screen.queryByTestId("grid-home")).toBeNull();
  });

  it("draws the grid, and drops the switch, once Home can no longer show", () => {
    harness.surface = HOME_SURFACE;
    act(() => useProjectHomeStore.getState().showHome());
    const { rerender } = render(<ContentGrid />);
    expect(screen.getByTestId("grid-home")).not.toBeNull();

    // The user chose "No home", or the plugin went away.
    harness.surface = null;
    rerender(<ContentGrid />);

    expect(screen.getByTestId("grid-default")).not.toBeNull();
    expect(screen.queryByTestId("project-home-nav")).toBeNull();
  });
});

describe("ContentGrid with Home beside the grid (#14107)", () => {
  it("draws the application and the panels together", () => {
    harness.surface = HOME_SURFACE;
    act(() => useProjectHomeStore.getState().showSplit());
    render(<ContentGrid />);

    expect(screen.getByTestId("grid-home").getAttribute("data-beside")).toBe("true");
    expect(screen.getByTestId("grid-default")).not.toBeNull();
    expect(checked("Split")).toBe("true");
  });

  it("keeps the application mounted from Home to the split, and the panels from the grid", () => {
    harness.surface = HOME_SURFACE;
    render(<ContentGrid />);
    const gridMount = mountOf("grid-default");

    act(() => {
      fireEvent.click(radio("Split"));
    });
    expect(mountOf("grid-default")).toBe(gridMount);
    const homeMount = mountOf("grid-home");

    act(() => {
      fireEvent.click(radio("Home"));
    });
    expect(screen.queryByTestId("grid-default")).toBeNull();
    expect(mountOf("grid-home")).toBe(homeMount);
    expect(screen.getByTestId("grid-home").getAttribute("data-beside")).toBe("false");

    act(() => {
      fireEvent.click(radio("Split"));
    });
    expect(mountOf("grid-home")).toBe(homeMount);
  });

  it("confines a maximize to the panels' side, with the application still in view", () => {
    harness.surface = HOME_SURFACE;
    act(() => useProjectHomeStore.getState().showSplit());
    const { rerender } = render(<ContentGrid />);
    const homeMount = mountOf("grid-home");

    harness.ctx.maximizedId = "t1";
    harness.ctx.maximizeTarget = { type: "panel", id: "t1" };
    harness.ctx.gridTerminals = [{ id: "t1" }];
    rerender(<ContentGrid />);

    expect(screen.getByTestId("grid-maximized")).not.toBeNull();
    expect(screen.queryByTestId("grid-default")).toBeNull();
    expect(mountOf("grid-home")).toBe(homeMount);
    expect(screen.getByTestId("project-home-nav")).not.toBeNull();
  });

  it("leaves a maximize when the user picks Home alone", () => {
    harness.surface = HOME_SURFACE;
    const exitMaximize = vi.fn();
    const original = usePanelStore.getState().exitMaximize;
    usePanelStore.setState({ exitMaximize });
    try {
      act(() => useProjectHomeStore.getState().showSplit());
      render(<ContentGrid />);

      act(() => {
        fireEvent.click(radio("Home"));
      });
      expect(exitMaximize).toHaveBeenCalledTimes(1);

      act(() => {
        fireEvent.click(radio("Grid"));
      });
      expect(exitMaximize).toHaveBeenCalledTimes(1);
    } finally {
      usePanelStore.setState({ exitMaximize: original });
    }
  });

  it("opens where an active application asks when the user has chosen nothing", () => {
    harness.surface = HOME_SURFACE;
    act(() => {
      useProjectPluginStore.setState({
        application: activeApplication({ arrangement: "beside-grid" }),
      });
    });
    render(<ContentGrid />);

    expect(checked("Split")).toBe("true");
    expect(screen.getByTestId("grid-home")).not.toBeNull();
    expect(screen.getByTestId("grid-default")).not.toBeNull();
  });

  it("keeps the user's own choice over the application's default", () => {
    harness.surface = HOME_SURFACE;
    act(() => {
      useProjectPluginStore.setState({
        application: activeApplication({ arrangement: "beside-grid" }),
      });
      useProjectHomeStore.getState().showGrid();
    });
    render(<ContentGrid />);

    expect(checked("Grid")).toBe("true");
    expect(screen.queryByTestId("grid-home")).toBeNull();
  });

  it("ignores the default of an application that is not in force", () => {
    harness.surface = HOME_SURFACE;
    act(() => {
      useProjectPluginStore.setState({
        application: {
          ...activeApplication({ arrangement: "beside-grid" }),
          status: "disabled",
          reason: "muted",
          fallback: "standard-workspace",
        },
      });
    });
    render(<ContentGrid />);

    expect(checked("Grid")).toBe("true");
  });
});
