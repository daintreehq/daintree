// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectApplicationState } from "@shared/types/plugin";

vi.mock("@/hooks/useHostPlatform", () => ({ hostScopedKey: (id: string) => `local:${id}` }));
vi.mock("@/hooks/useRenderableSurfaceClaim", () => ({ currentProjectSurface: () => null }));
vi.mock("@/store/projectPluginStore", async () => {
  const { create } = await import("zustand");
  return {
    useProjectPluginStore: create<{ application: ProjectApplicationState | null }>()(() => ({
      application: null,
    })),
  };
});

const OWNER = "project:acme.ledger";

const APPLICATION: ProjectApplicationState = {
  status: "active",
  ownerId: "acme.ledger",
  version: "1.0.0",
  instanceId: OWNER,
  application: {
    name: "Ledger",
    destination: "grid",
    navigation: {
      version: 1,
      defaultSectionId: "overview",
      sections: [
        { id: "overview", title: "Overview" },
        { id: "record", title: "Record", params: { recordId: { type: "string", required: true } } },
      ],
    },
  },
  fallback: null,
};

async function setup() {
  const { useApplicationNavigation } = await import("../useApplicationNavigation");
  const { useProjectPluginStore } = await import("@/store/projectPluginStore");
  const lifecycle = await import("@/services/plugin/pluginPanelLifecycle");
  useProjectPluginStore.setState({ application: APPLICATION });
  return { useApplicationNavigation, useProjectPluginStore, lifecycle };
}

beforeEach(() => {
  vi.resetModules();
  const backing = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => backing.set(key, value),
      removeItem: (key: string) => backing.delete(key),
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(window, "__DAINTREE_INITIAL_PROJECT__", {
    configurable: true,
    writable: true,
    value: { id: "project-a" },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "__DAINTREE_INITIAL_PROJECT__");
});

const current = () => true;

describe("useApplicationNavigation", () => {
  it("shares one live location between the application's views", async () => {
    const { useApplicationNavigation } = await setup();
    const sidebar = renderHook(() =>
      useApplicationNavigation({
        pluginId: OWNER,
        panelId: "sidebar:books",
        enabled: true,
        attempt: 0,
        isAttemptCurrent: current,
      })
    );
    const home = renderHook(() =>
      useApplicationNavigation({
        pluginId: OWNER,
        panelId: "surface:home",
        enabled: true,
        attempt: 0,
        isAttemptCurrent: current,
      })
    );
    const before = home.result.current?.location;
    expect(before).toEqual({ sectionId: "overview", params: {} });

    act(() => {
      expect(
        sidebar.result.current?.navigate({ sectionId: "record", params: { recordId: "inv-1" } }).ok
      ).toBe(true);
    });
    expect(home.result.current?.location).toEqual({
      sectionId: "record",
      params: { recordId: "inv-1" },
    });
    expect(home.result.current?.canGoBack).toBe(true);
    expect(home.result.current?.location).toBe(sidebar.result.current?.location);
  });

  it("refuses a move another view of the application would lose a form to", async () => {
    const { useApplicationNavigation, lifecycle } = await setup();
    const sidebar = renderHook(() =>
      useApplicationNavigation({
        pluginId: OWNER,
        panelId: "sidebar:books",
        enabled: true,
        attempt: 0,
        isAttemptCurrent: current,
      })
    );
    const home = renderHook(() =>
      useApplicationNavigation({
        pluginId: OWNER,
        panelId: "surface:home",
        enabled: true,
        attempt: 0,
        isAttemptCurrent: current,
      })
    );
    lifecycle.setViewUnsavedChanges("surface:home", {}, true);
    act(() => {
      expect(
        sidebar.result.current?.navigate({ sectionId: "record", params: { recordId: "inv-1" } })
      ).toEqual({ ok: false, reason: "unsaved" });
    });
    expect(home.result.current?.location.sectionId).toBe("overview");
  });

  it("hands nothing to a view of another plugin, or a host with no project", async () => {
    const { useApplicationNavigation } = await setup();
    const other = renderHook(() =>
      useApplicationNavigation({
        pluginId: "project:acme.other",
        panelId: "panel:1",
        enabled: true,
        attempt: 0,
        isAttemptCurrent: current,
      })
    );
    const userSettings = renderHook(() =>
      useApplicationNavigation({
        pluginId: OWNER,
        panelId: "settings:prefs",
        enabled: false,
        attempt: 0,
        isAttemptCurrent: current,
      })
    );
    expect(other.result.current).toBeUndefined();
    expect(userSettings.result.current).toBeUndefined();
  });

  it("withdraws navigation when the application stops being in force", async () => {
    const { useApplicationNavigation, useProjectPluginStore } = await setup();
    const view = renderHook(() =>
      useApplicationNavigation({
        pluginId: OWNER,
        panelId: "surface:home",
        enabled: true,
        attempt: 0,
        isAttemptCurrent: current,
      })
    );
    expect(view.result.current).toBeDefined();
    act(() => {
      useProjectPluginStore.setState({
        application: {
          ...APPLICATION,
          status: "disabled",
          reason: "muted",
          fallback: "standard-workspace",
        },
      });
    });
    expect(view.result.current).toBeUndefined();
  });

  it("refuses a call from an attempt that is no longer current", async () => {
    const { useApplicationNavigation } = await setup();
    let live = true;
    const view = renderHook(() =>
      useApplicationNavigation({
        pluginId: OWNER,
        panelId: "surface:home",
        enabled: true,
        attempt: 0,
        isAttemptCurrent: () => live,
      })
    );
    const held = view.result.current;
    live = false;
    expect(held?.navigate({ sectionId: "overview" })).toEqual({ ok: false, reason: "stale" });
    expect(held?.back()).toEqual({ ok: false, reason: "stale" });
  });
});
