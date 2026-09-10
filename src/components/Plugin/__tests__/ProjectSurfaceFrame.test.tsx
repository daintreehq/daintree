// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen, within } from "@testing-library/react";
import {
  registerPanelKind,
  unregisterPanelKind,
  type PanelKindConfig,
} from "@shared/config/panelKindRegistry";
import type { ProjectSurfaceChoiceRecord, ProjectSurfaceChoices } from "@shared/types/plugin";

const h = vi.hoisted(() => ({ dispatch: vi.fn() }));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => h.dispatch(...args) },
}));

import { ProjectSurfaceFrame } from "../ProjectSurfaceFrame";
import { useProjectSurface } from "../ProjectSurfaceView";
import {
  _resetPluginProjectSurfacesStoreForTest,
  selectSurfaceChoice,
  usePluginProjectSurfacesStore,
} from "@/store/pluginProjectSurfacesStore";
import {
  __resetProjectPluginStoreForTesting,
  useProjectPluginStore,
} from "@/store/projectPluginStore";

const KIND_ID = "project:p1/acme.dash/overview";
const claim = { pluginId: "project__p1__acme.dash", panelKindId: KIND_ID };
const PALETTE_ENTRY = "Search agents & panels…";

const answer = (
  choice: ProjectSurfaceChoiceRecord["choice"],
  pluginId = "acme.dash"
): ProjectSurfaceChoices => ({ emptyCanvas: { pluginId, choice, decidedAt: 1 } });

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

/** Seed the store the way the surfaces and answers pulls would. */
const setClaim = (choices: ProjectSurfaceChoices = {}, choicesLoaded = true) =>
  act(() => {
    usePluginProjectSurfacesStore.setState({
      surfaces: { emptyCanvas: claim },
      choices,
      choicesLoaded,
    });
  });

const canvasChoice = () =>
  selectSurfaceChoice(usePluginProjectSurfacesStore.getState(), "emptyCanvas");

const press = async (element: HTMLElement) => {
  await act(async () => {
    element.click();
  });
};

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

beforeEach(() => {
  h.dispatch.mockReset();
  _resetPluginProjectSurfacesStoreForTest();
});

afterEach(() => {
  unregisterPanelKind(KIND_ID);
  _resetPluginProjectSurfacesStoreForTest();
  __resetProjectPluginStoreForTesting();
  Reflect.deleteProperty(window, "electron");
});

describe("ProjectSurfaceFrame", () => {
  /** What main has on disk, written by the fake `setProjectSurfaceChoice`. */
  let disk: ProjectSurfaceChoices;
  const setProjectSurfaceChoice = vi.fn();

  beforeEach(() => {
    disk = {};
    // Main records exactly what the store sent, so echo the store's own
    // optimistic answer back as the persisted set.
    setProjectSurfaceChoice.mockReset().mockImplementation(() => {
      disk = usePluginProjectSurfacesStore.getState().choices;
      return Promise.resolve(disk);
    });
    // `defineProperty` rather than an assignment + cast: a partial stub of the
    // full `ElectronAPI` would otherwise need a type assertion.
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: {
        plugin: {
          getProjectSurfaces: vi.fn(() => Promise.resolve({ emptyCanvas: claim })),
          onPanelKindsChanged: vi.fn(() => () => {}),
          getProjectSurfaceChoices: vi.fn(() => Promise.resolve(disk)),
          setProjectSurfaceChoice,
        },
      },
    });
  });

  const renderFrame = (children: React.ReactNode = <div data-testid="surface" />) =>
    render(<ProjectSurfaceFrame>{children}</ProjectSurfaceFrame>);

  const strip = () => screen.getByRole("group", { name: "Empty canvas" });
  const stripButton = (name: string) => within(strip()).getByRole("button", { name });

  it("adds nothing when no surface is claimed", () => {
    renderFrame(<div data-testid="stock" />);

    expect(screen.getByTestId("stock")).toBeTruthy();
    // Most projects: a passthrough, so no strip and no wrapper to lay the stock
    // canvas out inside of.
    expect(screen.queryByRole("group", { name: "Empty canvas" })).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("adds nothing when the claimed kind has not registered", () => {
    setClaim();

    renderFrame(<div data-testid="stock" />);

    // Offering a switch to a surface that cannot render would be a control that
    // visibly does nothing.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("names the plugin's panel and marks the region as the empty canvas", () => {
    registerSurfaceKind();
    setClaim(answer("surface"));

    renderFrame();

    expect(strip().textContent).toContain("No panels open");
    expect(stripButton("Mission Control").getAttribute("aria-pressed")).toBe("true");
    expect(stripButton("Launcher").getAttribute("aria-pressed")).toBe("false");
  });

  it("lays the strip out above a surface that fills its region, never over it", async () => {
    registerSurfaceKind();
    setClaim(answer("surface"));
    const pluginToolbar = vi.fn();

    // The #12349 shape: a surface that fills its box and draws its own toolbar
    // in the top-right corner, including a button with the same label.
    renderFrame(
      <div data-testid="surface" className="absolute inset-0">
        <div className="absolute right-2 top-2 flex">
          <button onClick={pluginToolbar}>Launcher</button>
          <button onClick={pluginToolbar}>Pin active</button>
        </div>
      </div>
    );

    const region = screen.getByTestId("project-surface-region");
    const surface = screen.getByTestId("surface");
    expect(region.contains(surface)).toBe(true);
    expect(region.contains(strip())).toBe(false);
    expect(strip().contains(surface)).toBe(false);
    expect(strip().compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // In flow all the way up: nothing positions the strip into the surface's
    // corner, which is where the old overlay collided with plugin toolbars.
    for (let el: HTMLElement | null = strip(); el && el !== document.body; el = el.parentElement) {
      expect(el.className).not.toMatch(/\b(absolute|fixed)\b/);
    }

    await press(stripButton("Launcher"));

    expect(canvasChoice()).toBe("stock");
    expect(pluginToolbar).not.toHaveBeenCalled();
  });

  it("switches between the surface and the launcher in both directions, remembering each", async () => {
    registerSurfaceKind();
    setClaim(answer("surface"));
    renderFrame();

    await press(stripButton("Launcher"));
    expect(canvasChoice()).toBe("stock");
    expect(setProjectSurfaceChoice).toHaveBeenLastCalledWith("emptyCanvas", "stock");
    expect(stripButton("Launcher").getAttribute("aria-pressed")).toBe("true");

    await press(stripButton("Mission Control"));
    expect(canvasChoice()).toBe("surface");
    expect(setProjectSurfaceChoice).toHaveBeenLastCalledWith("emptyCanvas", "surface");
  });

  it("keeps the launcher's palette entry while the surface stands in for it", async () => {
    registerSurfaceKind();
    setClaim(answer("surface"));
    renderFrame();

    await press(stripButton(PALETTE_ENTRY));
    expect(h.dispatch).toHaveBeenCalledWith("panel.palette", undefined, { source: "user" });

    // The stock launcher carries the same entry as its own anchor.
    await press(stripButton("Launcher"));
    expect(within(strip()).queryByRole("button", { name: PALETTE_ENTRY })).toBeNull();
  });

  it("asks once, naming the plugin, the first time the surface would show", async () => {
    registerSurfaceKind();
    act(() => {
      useProjectPluginStore.setState({
        plugins: [
          {
            projectId: "p1",
            id: "acme.dash",
            instanceId: claim.pluginId,
            displayName: "Acme Dashboard",
            version: "1.0.0",
            capabilities: [],
            dirName: "dash",
            state: "active",
            muted: false,
            collidesWithGlobal: false,
          },
        ],
      });
    });
    setClaim();
    renderFrame();

    const notice = screen.getByRole("status");
    expect(notice.textContent).toContain("Acme Dashboard replaced the launcher");
    // Unanswered is the manifest's own intent: the surface is already showing.
    expect(stripButton("Mission Control").getAttribute("aria-pressed")).toBe("true");

    await press(within(notice).getByRole("button", { name: "Keep it" }));

    expect(setProjectSurfaceChoice).toHaveBeenCalledWith("emptyCanvas", "surface");
    expect(screen.queryByRole("status")).toBeNull();
    expect(stripButton("Mission Control").getAttribute("aria-pressed")).toBe("true");
  });

  it("remembers using the launcher across a reload", async () => {
    registerSurfaceKind();
    setClaim();
    const first = renderFrame();

    await press(within(screen.getByRole("status")).getByRole("button", { name: "Use the launcher" }));
    expect(canvasChoice()).toBe("stock");
    first.unmount();

    // A fresh view: nothing in memory, and the claim and the answer both come
    // back from main.
    _resetPluginProjectSurfacesStoreForTest();
    const surface = renderHook(() => useProjectSurface("emptyCanvas"));
    await flush();
    renderFrame();

    expect(surface.result.current).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(stripButton("Launcher").getAttribute("aria-pressed")).toBe("true");
  });

  it("does not ask before the answers have loaded", () => {
    registerSurfaceKind();
    setClaim({}, false);

    renderFrame();

    // A project that answered long ago must not flash the question while the
    // read is in flight.
    expect(screen.queryByRole("status")).toBeNull();
    expect(strip()).toBeTruthy();
  });

  it("asks again when the slot has passed to a different plugin", () => {
    registerSurfaceKind();
    setClaim(answer("stock", "acme.other"));

    renderFrame();

    expect(screen.getByRole("status")).toBeTruthy();
    expect(stripButton("Mission Control").getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps rendering its children in both states", async () => {
    registerSurfaceKind();
    setClaim(answer("surface"));

    renderFrame(<div data-testid="content" />);
    expect(screen.getByTestId("content")).toBeTruthy();

    await press(stripButton("Launcher"));
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

  it("stands down while the launcher is chosen", () => {
    registerSurfaceKind();
    setClaim();
    const { result, rerender } = renderHook(() => useProjectSurface("emptyCanvas"));
    expect(result.current).not.toBeNull();

    act(() => usePluginProjectSurfacesStore.setState({ choices: answer("stock") }));
    rerender();

    expect(result.current).toBeNull();
  });

  it("ignores a launcher answer that was about a different plugin", () => {
    registerSurfaceKind();
    setClaim(answer("stock", "acme.other"));

    const { result } = renderHook(() => useProjectSurface("emptyCanvas"));

    expect(result.current).not.toBeNull();
  });

  it("refuses a kind with no component module", () => {
    // A PTY panel, or a view the panels loop skipped: there is nothing to mount,
    // so the slot keeps its stock content rather than rendering blank.
    registerSurfaceKind({ componentPath: undefined });
    setClaim();

    const { result } = renderHook(() => useProjectSurface("emptyCanvas"));

    expect(result.current).toBeNull();
  });

  it("releases the slot on unload whatever answer is on record", () => {
    registerSurfaceKind();
    setClaim(answer("surface"));
    const { result, rerender } = renderHook(() => useProjectSurface("emptyCanvas"));
    expect(result.current).not.toBeNull();

    // The plugin unloaded: main dropped the claim. A remembered "keep it" must
    // not hold the slot for a plugin that is gone.
    act(() => usePluginProjectSurfacesStore.setState({ surfaces: {} }));
    rerender();

    expect(result.current).toBeNull();
    render(
      <ProjectSurfaceFrame>
        <div data-testid="stock" />
      </ProjectSurfaceFrame>
    );
    expect(screen.queryByRole("group", { name: "Empty canvas" })).toBeNull();
  });
});
