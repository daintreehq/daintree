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
vi.mock("../ContentGridDefault", () => ({
  ContentGridDefault: () => <div data-testid="grid-default" />,
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
  ContentGridProjectHome: ({ config }: { config: { id: string } }) => (
    <div data-testid="grid-home" data-kind={config.id} />
  ),
}));

import { ContentGrid } from "../ContentGrid";
import { useProjectHomeStore } from "@/store/projectHomeStore";

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
    useProjectHomeStore.setState({ homeByProject: {}, presented: false });
  });
});

afterEach(() => {
  act(() => {
    useProjectHomeStore.setState({ homeByProject: {}, presented: false });
  });
});

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
