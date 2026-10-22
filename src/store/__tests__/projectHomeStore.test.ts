// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  state?: { homeByProject?: Record<string, unknown> };
}

function readBlob(backing: Map<string, string>): StoredBlob {
  const blob: StoredBlob = JSON.parse(backing.get(STORAGE_KEY) ?? "{}");
  return blob;
}

function readHomes(backing: Map<string, string>): Record<string, unknown> {
  return readBlob(backing).state?.homeByProject ?? {};
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

  it("goes to Home and back for this view's project only", async () => {
    const backing = installLocalStorage();
    const { useProjectHomeStore, selectProjectMainAreaRoute } = await load();

    useProjectHomeStore.getState().showHome();
    expect(selectProjectMainAreaRoute(useProjectHomeStore.getState())).toBe("home");
    expect(readHomes(backing)).toEqual({ "project-a": true });

    useProjectHomeStore.getState().showGrid();
    expect(selectProjectMainAreaRoute(useProjectHomeStore.getState())).toBe("grid");
    // A grid route leaves nothing behind for the project.
    expect(readHomes(backing)).toEqual({});
  });

  it("reads another project's Home as nothing to this view", async () => {
    installLocalStorage({
      [STORAGE_KEY]: JSON.stringify({
        version: 1,
        state: { homeByProject: { "project-b": true } },
      }),
    });
    const { useProjectHomeStore, selectProjectMainAreaRoute } = await load();

    expect(selectProjectMainAreaRoute(useProjectHomeStore.getState())).toBe("grid");
  });

  it("restores a project left on Home", async () => {
    installLocalStorage({
      [STORAGE_KEY]: JSON.stringify({
        version: 1,
        state: { homeByProject: { "project-a": true } },
      }),
    });
    const { useProjectHomeStore, selectProjectMainAreaRoute } = await load();

    expect(selectProjectMainAreaRoute(useProjectHomeStore.getState())).toBe("home");
  });

  it("drops malformed stored entries rather than trusting them", async () => {
    installLocalStorage({
      [STORAGE_KEY]: JSON.stringify({
        version: 1,
        state: { homeByProject: { "project-a": "yes", "project-b": true } },
      }),
    });
    const { useProjectHomeStore, selectProjectMainAreaRoute } = await load();

    expect(selectProjectMainAreaRoute(useProjectHomeStore.getState())).toBe("grid");
    expect(useProjectHomeStore.getState().homeByProject).toEqual({ "project-b": true });
  });

  it("keeps a sibling view's Home when this view writes its own", async () => {
    const backing = installLocalStorage();
    const { useProjectHomeStore } = await load();

    // Another project's view went Home after this one hydrated.
    backing.set(
      STORAGE_KEY,
      JSON.stringify({ version: 1, state: { homeByProject: { "project-b": true } } })
    );
    useProjectHomeStore.getState().showHome();

    expect(readHomes(backing)).toEqual({ "project-a": true, "project-b": true });

    useProjectHomeStore.getState().showGrid();
    expect(readHomes(backing)).toEqual({ "project-b": true });
  });

  it("does nothing in a view with no workspace", async () => {
    seedViewWorkspace(null);
    const backing = installLocalStorage();
    const { useProjectHomeStore, selectProjectMainAreaRoute } = await load();

    useProjectHomeStore.getState().showHome();

    expect(selectProjectMainAreaRoute(useProjectHomeStore.getState())).toBe("grid");
    expect(readHomes(backing)).toEqual({});
  });

  it("never persists whether Home is on screen", async () => {
    const backing = installLocalStorage();
    const { useProjectHomeStore } = await load();

    useProjectHomeStore.getState().setPresented(true);
    useProjectHomeStore.getState().showHome();

    expect(Object.keys(readBlob(backing).state ?? {})).toEqual(["homeByProject"]);
  });
});
