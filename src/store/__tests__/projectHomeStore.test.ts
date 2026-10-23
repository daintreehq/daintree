// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginApplicationDescriptor } from "@shared/types/plugin";

const STORAGE_KEY = "daintree-project-home";

type ProjectHomeModule = typeof import("../projectHomeStore");

function seedViewWorkspace(id: string | null): void {
  Object.defineProperty(window, "__DAINTREE_INITIAL_PROJECT__", {
    configurable: true,
    writable: true,
    value: id === null ? undefined : { id },
  });
}

function installLocalStorage(initial: Record<string, string> = {}): Map<string, string> {
  const backing = new Map<string, string>(Object.entries(initial));
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => {
        backing.set(key, value);
      },
      removeItem: (key: string) => {
        backing.delete(key);
      },
    },
    configurable: true,
    writable: true,
  });
  return backing;
}

interface StoredBlob {
  version?: number;
  state?: { routeByProject?: Record<string, unknown> };
}

function readBlob(backing: Map<string, string>): StoredBlob {
  const blob: StoredBlob = JSON.parse(backing.get(STORAGE_KEY) ?? "{}");
  return blob;
}

function readRoutes(backing: Map<string, string>): Record<string, unknown> {
  return readBlob(backing).state?.routeByProject ?? {};
}

function blob(routeByProject: Record<string, unknown>): string {
  return JSON.stringify({ version: 2, state: { routeByProject } });
}

async function load(): Promise<ProjectHomeModule> {
  return import("../projectHomeStore");
}

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

beforeEach(() => {
  vi.resetModules();
  seedViewWorkspace("project-a");
});

afterEach(() => {
  if (originalLocalStorage) Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  Reflect.deleteProperty(window, "__DAINTREE_INITIAL_PROJECT__");
  vi.resetModules();
});

describe("projectHomeStore", () => {
  it("starts every project on the grid", async () => {
    installLocalStorage();
    const { useProjectHomeStore, selectProjectMainAreaRoute } = await load();

    expect(selectProjectMainAreaRoute(useProjectHomeStore.getState())).toBe("grid");
  });

  it("goes to Home, the split and the grid for this view's project only", async () => {
    const backing = installLocalStorage();
    const { useProjectHomeStore, selectProjectMainAreaRoute } = await load();

    useProjectHomeStore.getState().showHome();
    expect(selectProjectMainAreaRoute(useProjectHomeStore.getState())).toBe("home");
    expect(readRoutes(backing)).toEqual({ "project-a": "home" });

    useProjectHomeStore.getState().showSplit();
    expect(selectProjectMainAreaRoute(useProjectHomeStore.getState())).toBe("split");

    useProjectHomeStore.getState().showGrid();
    expect(selectProjectMainAreaRoute(useProjectHomeStore.getState())).toBe("grid");
    // The grid is kept as a choice, so an application's default can't override it.
    expect(readRoutes(backing)).toEqual({ "project-a": "grid" });
    expect(selectProjectMainAreaRoute(useProjectHomeStore.getState(), "split")).toBe("grid");
  });

  it("takes the fallback only while the user has chosen nothing", async () => {
    installLocalStorage();
    const { useProjectHomeStore, selectProjectMainAreaRoute } = await load();

    expect(selectProjectMainAreaRoute(useProjectHomeStore.getState(), "split")).toBe("split");
    useProjectHomeStore.getState().showHome();
    expect(selectProjectMainAreaRoute(useProjectHomeStore.getState(), "split")).toBe("home");
  });

  it("reads another project's route as nothing to this view", async () => {
    installLocalStorage({ [STORAGE_KEY]: blob({ "project-b": "home" }) });
    const { useProjectHomeStore, selectProjectMainAreaRoute } = await load();

    expect(selectProjectMainAreaRoute(useProjectHomeStore.getState())).toBe("grid");
  });

  it("restores a project left in the split", async () => {
    installLocalStorage({ [STORAGE_KEY]: blob({ "project-a": "split" }) });
    const { useProjectHomeStore, selectProjectMainAreaRoute } = await load();

    expect(selectProjectMainAreaRoute(useProjectHomeStore.getState())).toBe("split");
  });

  it("carries a version 1 Home over, and leaves its absent grid unchosen", async () => {
    installLocalStorage({
      [STORAGE_KEY]: JSON.stringify({
        version: 1,
        state: { homeByProject: { "project-a": true, "project-b": "yes" } },
      }),
    });
    const { useProjectHomeStore, selectProjectMainAreaRoute } = await load();

    expect(selectProjectMainAreaRoute(useProjectHomeStore.getState())).toBe("home");
    expect(useProjectHomeStore.getState().routeByProject).toEqual({ "project-a": "home" });
  });

  it("drops malformed stored entries rather than trusting them", async () => {
    installLocalStorage({
      [STORAGE_KEY]: blob({ "project-a": "dashboard", "project-b": "split", "project-c": true }),
    });
    const { useProjectHomeStore, selectProjectMainAreaRoute } = await load();

    expect(selectProjectMainAreaRoute(useProjectHomeStore.getState())).toBe("grid");
    expect(useProjectHomeStore.getState().routeByProject).toEqual({ "project-b": "split" });
  });

  it("keeps a sibling view's route when this view writes its own", async () => {
    const backing = installLocalStorage();
    const { useProjectHomeStore } = await load();

    // Another project's view went Home after this one hydrated.
    backing.set(STORAGE_KEY, blob({ "project-b": "home" }));
    useProjectHomeStore.getState().showSplit();

    expect(readRoutes(backing)).toEqual({ "project-a": "split", "project-b": "home" });

    useProjectHomeStore.getState().showGrid();
    expect(readRoutes(backing)).toEqual({ "project-a": "grid", "project-b": "home" });
  });

  it("merges a version 1 Home left on disk instead of writing over it", async () => {
    const v1 = (homeByProject: Record<string, true>) =>
      JSON.stringify({ version: 1, state: { homeByProject } });
    const backing = installLocalStorage({ [STORAGE_KEY]: v1({ "project-b": true }) });
    const { useProjectHomeStore } = await load();

    // Another view still holding the old shape wrote after this one hydrated.
    backing.set(STORAGE_KEY, v1({ "project-b": true, "project-c": true }));
    useProjectHomeStore.getState().showSplit();

    expect(readBlob(backing).version).toBe(2);
    expect(readRoutes(backing)).toEqual({
      "project-a": "split",
      "project-b": "home",
      "project-c": "home",
    });
  });

  it("does nothing in a view with no workspace", async () => {
    seedViewWorkspace(null);
    const backing = installLocalStorage();
    const { useProjectHomeStore, selectProjectMainAreaRoute } = await load();

    useProjectHomeStore.getState().showHome();

    expect(selectProjectMainAreaRoute(useProjectHomeStore.getState())).toBe("grid");
    expect(readRoutes(backing)).toEqual({});
  });

  it("never persists whether Home is on screen", async () => {
    const backing = installLocalStorage();
    const { useProjectHomeStore } = await load();

    useProjectHomeStore.getState().setPresented(true);
    useProjectHomeStore.getState().showHome();

    expect(Object.keys(readBlob(backing).state ?? {})).toEqual(["routeByProject"]);
  });
});

describe("applicationDefaultRoute", () => {
  const application = (
    patch: Partial<PluginApplicationDescriptor>,
    status: "active" | "disabled"
  ) => ({
    status,
    application: { name: "Dash", destination: "home" as const, ...patch },
  });

  it.each<[Partial<PluginApplicationDescriptor>, "active" | "disabled", string]>([
    [{}, "active", "home"],
    [{ arrangement: "full" }, "active", "home"],
    [{ arrangement: "beside-grid" }, "active", "split"],
    [{ destination: "grid" }, "active", "grid"],
    [{ arrangement: "beside-grid" }, "disabled", "grid"],
  ])("maps %j while %s to %s", async (patch, status, expected) => {
    installLocalStorage();
    const { applicationDefaultRoute } = await load();
    expect(applicationDefaultRoute(application(patch, status))).toBe(expected);
  });

  it("keeps the grid with no application", async () => {
    installLocalStorage();
    const { applicationDefaultRoute } = await load();
    expect(applicationDefaultRoute(null)).toBe("grid");
  });
});
