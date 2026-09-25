// @vitest-environment jsdom
import { afterEach, describe, it, expect, beforeEach, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PluginTourDescriptor } from "@shared/types/plugin";

const { actions, getToursMock, onToursChangedMock } = vi.hoisted(() => ({
  actions: new Map<string, { title: string; run: () => Promise<void> }>(),
  getToursMock: vi.fn(),
  onToursChangedMock: vi.fn(),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    has: (id: string) => actions.has(id),
    register: (definition: { id: string; title: string; run: () => Promise<void> }) => {
      if (actions.has(definition.id)) throw new Error("duplicate");
      actions.set(definition.id, definition);
    },
    unregister: (id: string) => actions.delete(id),
  },
}));

import { OPEN_TOUR_EVENT, tourIdOf } from "@/components/Tour/tourEvents";
import { getTour } from "@/components/Tour/tourRegistry";
import { pluginTourActionId, usePluginTours } from "../usePluginTours";

const tour = (localId: string, overrides: Partial<PluginTourDescriptor> = {}) => ({
  id: `acme.site.${localId}`,
  pluginId: "acme.site",
  pluginName: "Acme Site Builder",
  title: `${localId} tour`,
  moduleUrl: "plugin://pi-1/__dtv-1/dist/tour.js",
  chapters: [{ id: "intro", duration: 30, cues: {}, captions: [], audioUrl: null }],
  ...overrides,
});

let push: ((payload: { tours: PluginTourDescriptor[] }) => void) | null;

beforeEach(() => {
  actions.clear();
  push = null;
  getToursMock.mockReset().mockResolvedValue([]);
  onToursChangedMock.mockReset().mockImplementation((cb: typeof push) => {
    push = cb;
    return () => {};
  });
  Reflect.set(window, "electron", {
    plugin: { getTours: getToursMock, onToursChanged: onToursChangedMock },
  });
});

afterEach(() => {
  // Unmounting withdraws what each test registered from the shared tour registry.
  cleanup();
});

describe("usePluginTours (#12773)", () => {
  it("registers pulled tours and lists them in the palette under the plugin's name", async () => {
    getToursMock.mockResolvedValue([tour("welcome")]);
    const { unmount } = renderHook(() => usePluginTours());
    await waitFor(() => expect(getTour("acme.site.welcome")).toBeDefined());
    expect(actions.get(pluginTourActionId("acme.site.welcome"))?.title).toBe(
      "Acme Site Builder: welcome tour"
    );

    const opened: string[] = [];
    const onOpen = (event: Event) => opened.push(tourIdOf(event));
    window.addEventListener(OPEN_TOUR_EVENT, onOpen);
    await actions.get(pluginTourActionId("acme.site.welcome"))!.run();
    window.removeEventListener(OPEN_TOUR_EVENT, onOpen);
    expect(opened).toEqual(["acme.site.welcome"]);

    unmount();
    expect(getTour("acme.site.welcome")).toBeUndefined();
    expect(actions.size).toBe(0);
  });

  it("withdraws a tour that leaves the snapshot, as when its plugin is disabled", async () => {
    renderHook(() => usePluginTours());
    await waitFor(() => expect(push).not.toBeNull());
    act(() => push!({ tours: [tour("welcome"), tour("advanced")] }));
    expect(getTour("acme.site.advanced")).toBeDefined();

    act(() => push!({ tours: [tour("welcome")] }));
    expect(getTour("acme.site.advanced")).toBeUndefined();
    expect(actions.has(pluginTourActionId("acme.site.advanced"))).toBe(false);
    expect(getTour("acme.site.welcome")).toBeDefined();
  });

  it("keeps an unchanged tour's registration and replaces a reloaded one", async () => {
    renderHook(() => usePluginTours());
    await waitFor(() => expect(push).not.toBeNull());
    act(() => push!({ tours: [tour("welcome")] }));
    const first = getTour("acme.site.welcome");

    act(() => push!({ tours: [tour("welcome")] }));
    expect(getTour("acme.site.welcome")).toBe(first);

    act(() =>
      push!({ tours: [tour("welcome", { moduleUrl: "plugin://pi-2/__dtv-2/dist/tour.js" })] })
    );
    expect(getTour("acme.site.welcome")).not.toBe(first);
    expect(getTour("acme.site.welcome")).toBeDefined();
  });

  it("registers a panel tour for playback without listing it app-wide", async () => {
    renderHook(() => usePluginTours());
    await waitFor(() => expect(push).not.toBeNull());
    act(() => push!({ tours: [tour("panel", { panelKind: "site-builder" })] }));
    expect(getTour("acme.site.panel")).toBeDefined();
    expect(actions.size).toBe(0);
  });

  it("ignores a mount-time pull that resolves after a push", async () => {
    let resolvePull: (tours: PluginTourDescriptor[]) => void = () => {};
    getToursMock.mockReturnValue(new Promise((resolve) => (resolvePull = resolve)));
    renderHook(() => usePluginTours());
    await waitFor(() => expect(push).not.toBeNull());
    act(() => push!({ tours: [] }));
    await act(async () => {
      resolvePull([tour("stale")]);
    });
    expect(getTour("acme.site.stale")).toBeUndefined();
  });
});
