// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import {
  registerPanelKind,
  unregisterPanelKind,
  type PanelKindConfig,
} from "@shared/config/panelKindRegistry";
import type {
  ProjectSurfaceChoice,
  ProjectSurfaceChoices,
  ProjectSurfaceSnapshot,
} from "@shared/types/plugin";

const h = vi.hoisted(() => ({ dispatch: vi.fn() }));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => h.dispatch(...args) },
}));

vi.mock("@/components/Plugin/PluginViewContent", () => ({
  // The real loader imports a `plugin://` module over IPC. What matters here is
  // a view that fills its box and pins a toolbar into the top-right corner —
  // the shape that used to paint over the old overlay.
  makePluginViewContent: () => () => (
    <div data-testid="plugin-view" className="absolute inset-0">
      <div className="fixed right-0 top-0 flex">
        <button type="button">Launcher</button>
        <button type="button">Pin active</button>
      </div>
    </div>
  ),
}));

import { ProjectSurfaceFrame } from "../ProjectSurfaceFrame";
import {
  ProjectSurfaceView,
  _resetProjectSurfaceRuntimesForTest,
  useProjectSurface,
} from "../ProjectSurfaceView";
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
const SAVE_FAILED = "Couldn't save the canvas choice";

const answer = (choice: ProjectSurfaceChoice, pluginId = "acme.dash"): ProjectSurfaceChoices => ({
  emptyCanvas: { pluginId, choice, decidedAt: 1 },
});

function surfaceKind(overrides: Partial<PanelKindConfig> = {}): PanelKindConfig {
  return {
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
  };
}

const registerSurfaceKind = (overrides: Partial<PanelKindConfig> = {}) =>
  registerPanelKind(surfaceKind(overrides));

/** Seed the store the way the combined claims-and-answers pull would. */
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const flush = () =>
  act(async () => {
    await settle();
  });

const press = async (element: HTMLElement) => {
  await act(async () => {
    element.click();
    await settle();
  });
};

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
  _resetProjectSurfaceRuntimesForTest();
  __resetProjectPluginStoreForTesting();
  Reflect.deleteProperty(window, "electron");
});

describe("ProjectSurfaceFrame", () => {
  /** What main holds: the claim it would report and the answers on disk. */
  let surfacesOnMain: ProjectSurfaceSnapshot;
  let disk: ProjectSurfaceChoices;
  let failNextSave: boolean;
  const kindsListeners: Array<() => void> = [];

  const setProjectSurfaceChoice = vi.fn((_slot: string, choice: ProjectSurfaceChoice | null) => {
    if (failNextSave) {
      failNextSave = false;
      return Promise.reject(new Error("ENOSPC"));
    }
    // Main records the answer against the slot's owner, from its own registry.
    disk = choice === null ? {} : answer(choice);
    return Promise.resolve({ projectId: "p1", choices: disk });
  });

  beforeEach(() => {
    surfacesOnMain = { emptyCanvas: claim };
    disk = {};
    failNextSave = false;
    kindsListeners.length = 0;
    setProjectSurfaceChoice.mockClear();
    // `defineProperty` rather than an assignment + cast: a partial stub of the
    // full `ElectronAPI` would otherwise need a type assertion.
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: {
        plugin: {
          getProjectSurfaces: () => Promise.resolve(surfacesOnMain),
          onPanelKindsChanged: (cb: () => void) => {
            kindsListeners.push(cb);
            return () => {};
          },
          getProjectSurfaceChoices: () => Promise.resolve({ projectId: "p1", choices: disk }),
          setProjectSurfaceChoice,
        },
      },
    });
  });

  const renderFrame = (children: React.ReactNode = <div data-testid="surface" />) =>
    render(<ProjectSurfaceFrame>{children}</ProjectSurfaceFrame>);

  const strip = () => screen.getByRole("group", { name: "Empty canvas" });
  const stripButton = (name: string) => within(strip()).getByRole("button", { name });
  const notice = () => screen.getByRole("status");

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

  it("adds nothing until the claim's answer is known", () => {
    registerSurfaceKind();
    setClaim({}, false);

    renderFrame(<div data-testid="stock" />);

    // The canvas stays stock until then, so a strip would show the surface
    // pressed over the launcher — and a project that answered long ago must not
    // flash the question while the read is in flight.
    expect(screen.getByTestId("stock")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Empty canvas" })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("names the plugin's panel and marks the region as the empty canvas", () => {
    registerSurfaceKind();
    setClaim(answer("surface"));

    renderFrame();

    expect(strip().textContent).toContain("No panels open");
    expect(stripButton("Mission Control").getAttribute("aria-pressed")).toBe("true");
    expect(stripButton("Launcher").getAttribute("aria-pressed")).toBe("false");
  });

  it("lays the strip out above the plugin's contained box, never over it", async () => {
    registerSurfaceKind();
    setClaim(answer("surface"));

    renderFrame(<ProjectSurfaceView config={surfaceKind()} />);

    const frame = screen.getByTestId("project-surface-frame");
    const region = screen.getByTestId("project-surface-region");
    const view = screen.getByTestId("plugin-view");

    // The strip and the region are siblings, strip first: the host's controls
    // are laid out before the plugin's box rather than floated into it, which
    // is where the old overlay met plugin toolbars.
    expect(strip().parentElement).toBe(frame);
    expect(region.parentElement).toBe(frame);
    expect(strip().compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (let el: HTMLElement | null = strip(); el && el !== document.body; el = el.parentElement) {
      expect(el.className).not.toMatch(/\b(absolute|fixed)\b/);
    }
    // Everything the plugin draws — its own "Launcher" button included — lives
    // in the region and nowhere in the strip.
    expect(region.contains(view)).toBe(true);
    expect(strip().contains(view)).toBe(false);

    // Two buttons read "Launcher" on screen; the strip's is the host's.
    await press(stripButton("Launcher"));
    expect(canvasChoice()).toBe("stock");
  });

  it("switches between the surface and the launcher in both directions, remembering each", async () => {
    registerSurfaceKind();
    setClaim(answer("surface"));
    renderFrame();

    await press(stripButton("Launcher"));
    expect(setProjectSurfaceChoice).toHaveBeenLastCalledWith("emptyCanvas", "stock");
    expect(disk).toEqual(answer("stock"));
    expect(stripButton("Launcher").getAttribute("aria-pressed")).toBe("true");

    await press(stripButton("Mission Control"));
    expect(setProjectSurfaceChoice).toHaveBeenLastCalledWith("emptyCanvas", "surface");
    expect(disk).toEqual(answer("surface"));
  });

  it("answers nothing when the segment already showing is pressed", async () => {
    registerSurfaceKind();
    setClaim();
    renderFrame();

    // Unanswered, the surface segment is already pressed: pressing it must not
    // quietly answer the question the notice is asking.
    await press(stripButton("Mission Control"));

    expect(setProjectSurfaceChoice).not.toHaveBeenCalled();
    expect(notice()).toBeTruthy();
  });

  it("keeps the palette entry and the empty-canvas label only while the surface stands in", async () => {
    registerSurfaceKind();
    setClaim(answer("surface"));
    renderFrame();

    await press(stripButton(PALETTE_ENTRY));
    expect(h.dispatch).toHaveBeenCalledWith("panel.palette", undefined, { source: "user" });

    // The stock launcher is its own empty state, anchor included.
    await press(stripButton("Launcher"));
    expect(within(strip()).queryByRole("button", { name: PALETTE_ENTRY })).toBeNull();
    expect(strip().textContent).not.toContain("No panels open");
  });

  it("caps a long panel name so the way back stays in reach", () => {
    const longName = "Video manager for the whole production pipeline";
    registerSurfaceKind({ name: longName });
    setClaim(answer("surface"));

    renderFrame();

    const [panelSegment] = within(strip()).getAllByRole("button");
    const shown = panelSegment?.textContent ?? "";
    expect(shown.length).toBeLessThan(longName.length);
    expect(longName.startsWith(shown.slice(0, -1))).toBe(true);
    // The full name stays the accessible one.
    expect(panelSegment?.getAttribute("aria-label")).toBe(longName);
    expect(stripButton("Launcher")).toBeTruthy();
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

    expect(notice().textContent).toContain("Acme Dashboard replaced the launcher");
    // Unanswered is the manifest's own intent: the surface is already showing.
    expect(stripButton("Mission Control").getAttribute("aria-pressed")).toBe("true");

    await press(within(notice()).getByRole("button", { name: "Keep it" }));

    expect(setProjectSurfaceChoice).toHaveBeenCalledWith("emptyCanvas", "surface");
    expect(screen.queryByRole("status")).toBeNull();
    expect(stripButton("Mission Control").getAttribute("aria-pressed")).toBe("true");
  });

  it("puts focus in the strip after the notice is answered from the keyboard", async () => {
    registerSurfaceKind();
    setClaim();
    renderFrame();

    const useLauncher = within(notice()).getByRole("button", { name: "Use the launcher" });
    useLauncher.focus();
    await act(async () => {
      // Keyboard activation arrives as a click with no detail.
      fireEvent.click(useLauncher, { detail: 0 });
      await settle();
    });

    expect(screen.queryByRole("status")).toBeNull();
    expect(document.activeElement).toBe(stripButton("Launcher"));
  });

  it("remembers using the launcher across a reload", async () => {
    registerSurfaceKind();
    setClaim();
    const first = renderFrame();

    await press(within(notice()).getByRole("button", { name: "Use the launcher" }));
    expect(setProjectSurfaceChoice).toHaveBeenLastCalledWith("emptyCanvas", "stock");
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

  it("still releases the slot when the plugin unloads after a reload", async () => {
    registerSurfaceKind();
    disk = answer("surface");
    const surface = renderHook(() => useProjectSurface("emptyCanvas"));
    await flush();
    renderFrame(<div data-testid="content" />);
    expect(surface.result.current).not.toBeNull();
    expect(strip()).toBeTruthy();

    // The plugin unloads: main drops the claim and says so with the panel-kinds
    // broadcast. A remembered "keep it" must not hold the slot for it.
    surfacesOnMain = {};
    await act(async () => {
      for (const listener of kindsListeners) listener();
      await settle();
    });

    expect(surface.result.current).toBeNull();
    expect(screen.queryByRole("group", { name: "Empty canvas" })).toBeNull();
    expect(screen.getByTestId("content")).toBeTruthy();
  });

  it("reports a failed save with a retry in place of the question", async () => {
    registerSurfaceKind();
    setClaim();
    renderFrame();

    failNextSave = true;
    await press(stripButton("Launcher"));

    expect(screen.getByText(SAVE_FAILED)).toBeTruthy();
    expect(screen.queryByText(/replaced the launcher/)).toBeNull();
    // Nothing was recorded, so nothing changed.
    expect(canvasChoice()).toBeNull();
    expect(stripButton("Mission Control").getAttribute("aria-pressed")).toBe("true");

    await press(screen.getByRole("button", { name: "Retry" }));

    expect(canvasChoice()).toBe("stock");
    expect(screen.queryByText(SAVE_FAILED)).toBeNull();
  });

  it("asks the new owner instead of offering a retry once the slot changes hands", async () => {
    registerSurfaceKind();
    setClaim();
    renderFrame();

    failNextSave = true;
    await press(stripButton("Launcher"));
    expect(screen.getByText(SAVE_FAILED)).toBeTruthy();

    // A reload hands the slot to a different plugin: the failed answer was
    // about the last one, so retrying it would answer for this one unasked.
    act(() => {
      usePluginProjectSurfacesStore.setState({
        surfaces: { emptyCanvas: { ...claim, pluginId: "project__p1__acme.other" } },
      });
    });

    expect(screen.queryByText(SAVE_FAILED)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(notice()).toBeTruthy();
  });

  it("asks again when the slot has passed to a different plugin", () => {
    registerSurfaceKind();
    setClaim(answer("stock", "acme.other"));

    renderFrame();

    expect(notice()).toBeTruthy();
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

  it("waits for the answers before resolving", () => {
    registerSurfaceKind();
    setClaim({}, false);
    const { result, rerender } = renderHook(() => useProjectSurface("emptyCanvas"));
    expect(result.current).toBeNull();

    act(() => usePluginProjectSurfacesStore.setState({ choicesLoaded: true }));
    rerender();

    expect(result.current).not.toBeNull();
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
});
