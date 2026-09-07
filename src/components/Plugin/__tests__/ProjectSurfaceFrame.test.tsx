// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, renderHook, screen, act } from "@testing-library/react";
import {
  registerPanelKind,
  unregisterPanelKind,
  type PanelKindConfig,
} from "@shared/config/panelKindRegistry";
import { ProjectSurfaceFrame } from "../ProjectSurfaceFrame";
import { useProjectSurface } from "../ProjectSurfaceView";
import {
  _resetPluginProjectSurfacesStoreForTest,
  usePluginProjectSurfacesStore,
} from "@/store/pluginProjectSurfacesStore";

const KIND_ID = "project:p1/acme.dash/overview";
const claim = { pluginId: "project__p1__acme.dash", panelKindId: KIND_ID };

function registerSurfaceKind(overrides: Partial<PanelKindConfig> = {}) {
  registerPanelKind({
    id: KIND_ID,
    name: "Mission Control",
    iconId: "puzzle",
    color: "#ffffff",
    hasPty: false,
    canRestart: false,
    canConvert: false,
    extensionId: claim.pluginId,
    componentPath: "plugin://acme.dash/1/overview.js",
    ...overrides,
  });
}

const setClaim = () =>
  act(() => {
    usePluginProjectSurfacesStore.setState({ surfaces: { emptyCanvas: claim } });
  });

beforeEach(() => {
  _resetPluginProjectSurfacesStoreForTest();
});

afterEach(() => {
  unregisterPanelKind(KIND_ID);
  _resetPluginProjectSurfacesStoreForTest();
});

describe("ProjectSurfaceFrame", () => {
  it("adds nothing when no surface is claimed", () => {
    render(
      <ProjectSurfaceFrame>
        <div data-testid="stock" />
      </ProjectSurfaceFrame>
    );

    expect(screen.getByTestId("stock")).toBeTruthy();
    // Every project today: a passthrough, so no control and no wrapper to lay
    // the stock canvas out inside of.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("adds nothing when the claimed kind has not registered", () => {
    setClaim();

    render(
      <ProjectSurfaceFrame>
        <div data-testid="stock" />
      </ProjectSurfaceFrame>
    );

    // Offering a switch to a surface that cannot render would be a control that
    // visibly does nothing.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers the stock launcher while the surface is showing", () => {
    registerSurfaceKind();
    setClaim();

    render(
      <ProjectSurfaceFrame>
        <div data-testid="surface" />
      </ProjectSurfaceFrame>
    );

    expect(screen.getByRole("button").textContent).toBe("Launcher");
  });

  it("offers the surface back once the stock canvas is pinned", () => {
    registerSurfaceKind();
    setClaim();
    act(() => usePluginProjectSurfacesStore.getState().setStockCanvasPinned(true));

    render(
      <ProjectSurfaceFrame>
        <div data-testid="stock" />
      </ProjectSurfaceFrame>
    );

    // The control names its destination in BOTH directions — that round trip is
    // what keeps a claimed surface from ever being a dead end.
    expect(screen.getByRole("button").textContent).toBe("Mission Control");
  });

  it("switches the pin in both directions", () => {
    registerSurfaceKind();
    setClaim();

    render(
      <ProjectSurfaceFrame>
        <div data-testid="surface" />
      </ProjectSurfaceFrame>
    );

    act(() => screen.getByRole("button").click());
    expect(usePluginProjectSurfacesStore.getState().stockCanvasPinned).toBe(true);

    act(() => screen.getByRole("button").click());
    expect(usePluginProjectSurfacesStore.getState().stockCanvasPinned).toBe(false);
  });

  it("keeps rendering its children in both states", () => {
    registerSurfaceKind();
    setClaim();

    render(
      <ProjectSurfaceFrame>
        <div data-testid="content" />
      </ProjectSurfaceFrame>
    );
    expect(screen.getByTestId("content")).toBeTruthy();

    act(() => usePluginProjectSurfacesStore.getState().setStockCanvasPinned(true));
    expect(screen.getByTestId("content")).toBeTruthy();
  });
});

describe("useProjectSurface", () => {
  it("resolves a claim once its panel kind registers", () => {
    setClaim();
    const { result, rerender } = renderHook(() => useProjectSurface("emptyCanvas"));
    // The surfaces pull and the panel-kinds pull are independent round trips,
    // so the claim routinely lands first.
    expect(result.current).toBeNull();

    act(() => registerSurfaceKind());
    rerender();

    expect(result.current?.config.id).toBe(KIND_ID);
    expect(result.current?.claim).toEqual(claim);
  });

  it("stands down while the stock canvas is pinned", () => {
    registerSurfaceKind();
    setClaim();
    const { result, rerender } = renderHook(() => useProjectSurface("emptyCanvas"));
    expect(result.current).not.toBeNull();

    act(() => usePluginProjectSurfacesStore.getState().setStockCanvasPinned(true));
    rerender();

    expect(result.current).toBeNull();
  });

  it("refuses a kind with no component module", () => {
    // A PTY panel, or a view the panels loop skipped: there is nothing to mount,
    // so the slot keeps its stock content rather than rendering blank.
    registerSurfaceKind({ componentPath: undefined });
    setClaim();

    const { result } = renderHook(() => useProjectSurface("emptyCanvas"));

    expect(result.current).toBeNull();
  });

  it("resolves nothing when the surface is released", () => {
    registerSurfaceKind();
    setClaim();
    const { result, rerender } = renderHook(() => useProjectSurface("emptyCanvas"));
    expect(result.current).not.toBeNull();

    act(() => usePluginProjectSurfacesStore.setState({ surfaces: {} }));
    rerender();

    expect(result.current).toBeNull();
  });
});
