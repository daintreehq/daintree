// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginApplicationNavigation, ProjectApplicationState } from "@shared/types/plugin";

const surface = vi.hoisted(() => ({
  current: null as null | { claim: { pluginId: string; panelKindId: string } },
}));
const exitMaximize = vi.hoisted(() => vi.fn());
const panels = vi.hoisted(() => ({ maximizedId: null as string | null }));

vi.mock("@/hooks/useHostPlatform", () => ({ hostScopedKey: (id: string) => `local:${id}` }));
vi.mock("@/hooks/useRenderableSurfaceClaim", () => ({
  currentProjectSurface: () => surface.current,
}));
vi.mock("@/store/projectPluginStore", async () => {
  const { create } = await import("zustand");
  return {
    useProjectPluginStore: create<{ application: ProjectApplicationState | null }>()(() => ({
      application: null,
    })),
  };
});

const STORAGE_KEY = "daintree-application-navigation";

const NAVIGATION: PluginApplicationNavigation = {
  version: 1,
  defaultSectionId: "overview",
  sections: [
    { id: "overview", title: "Overview" },
    {
      id: "record",
      title: "Record",
      params: {
        recordId: { type: "string", required: true, persist: true },
        draftTab: { type: "integer" },
      },
    },
  ],
};

function application(
  overrides: Partial<ProjectApplicationState> = {},
  navigation: PluginApplicationNavigation | null = NAVIGATION
): ProjectApplicationState {
  return {
    status: "active",
    ownerId: "acme.ledger",
    version: "1.0.0",
    instanceId: "project:acme.ledger",
    application: {
      name: "Ledger",
      destination: "home",
      ...(navigation ? { navigation } : {}),
    },
    fallback: null,
    ...overrides,
  };
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

async function load(app: ProjectApplicationState | null = application()) {
  const { setPanelMaximizeAccessor } = await import("@/store/storeAccessors");
  setPanelMaximizeAccessor({
    isMaximized: () => panels.maximizedId !== null,
    exit: exitMaximize,
  });
  const navigation = await import("../applicationNavigation");
  const lifecycle = await import("../pluginPanelLifecycle");
  const { useProjectPluginStore } = await import("@/store/projectPluginStore");
  const { useProjectHomeStore, selectProjectMainAreaRoute } =
    await import("@/store/projectHomeStore");
  const { useApplicationNavigationStore, selectApplicationNavigationRecord } =
    await import("@/store/applicationNavigationStore");
  useProjectPluginStore.setState({ application: app });
  const current = () => {
    const state = useProjectPluginStore.getState().application;
    const context = navigation.applicationNavigationContext(state, "local:project-a");
    if (context === null) return null;
    const record = selectApplicationNavigationRecord(
      useApplicationNavigationStore.getState(),
      context.key,
      { ownerId: context.ownerId, version: context.navigation.version }
    );
    return navigation.applicationNavigationSnapshot(
      context,
      navigation.resolveApplicationNavigationHistory(context, record)
    );
  };
  return {
    ...navigation,
    lifecycle,
    useProjectPluginStore,
    useProjectHomeStore,
    route: () => selectProjectMainAreaRoute(useProjectHomeStore.getState()),
    current,
  };
}

const OWNER = "project:acme.ledger";

beforeEach(() => {
  vi.resetModules();
  installLocalStorage();
  Object.defineProperty(window, "__DAINTREE_INITIAL_PROJECT__", {
    configurable: true,
    writable: true,
    value: { id: "project-a" },
  });
  surface.current = { claim: { pluginId: OWNER, panelKindId: "kind" } };
  exitMaximize.mockReset();
  panels.maximizedId = null;
});

afterEach(() => {
  Reflect.deleteProperty(window, "__DAINTREE_INITIAL_PROJECT__");
});

describe("navigateApplication", () => {
  it("starts on the default section", async () => {
    const { current } = await load();
    expect(current()).toMatchObject({
      location: { sectionId: "overview", params: {} },
      sections: [
        { id: "overview", title: "Overview" },
        { id: "record", title: "Record" },
      ],
      canGoBack: false,
      canGoForward: false,
    });
  });

  it("moves the shared location and keeps history", async () => {
    const nav = await load();
    const result = nav.navigateApplication(OWNER, {
      sectionId: "record",
      params: { recordId: "inv-1" },
    });
    expect(result).toEqual({
      ok: true,
      location: { sectionId: "record", params: { recordId: "inv-1" } },
    });
    expect(nav.current()).toMatchObject({
      location: { sectionId: "record", params: { recordId: "inv-1" } },
      canGoBack: true,
      canGoForward: false,
    });
    expect(nav.navigateApplicationBack(OWNER)).toMatchObject({
      ok: true,
      location: { sectionId: "overview" },
    });
    expect(nav.current()).toMatchObject({ canGoBack: false, canGoForward: true });
    expect(nav.navigateApplicationForward(OWNER)).toMatchObject({
      ok: true,
      location: { sectionId: "record" },
    });
    expect(nav.navigateApplicationForward(OWNER)).toEqual({ ok: false, reason: "no-history" });
  });

  it("refuses a view of any other plugin", async () => {
    const nav = await load();
    expect(nav.navigateApplication("project:acme.other", { sectionId: "overview" })).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(nav.navigateApplicationBack("project:acme.other")).toEqual({
      ok: false,
      reason: "stale",
    });
  });

  it.each([
    ["loading", { status: "loading" as const, instanceId: undefined }],
    ["disabled", { status: "disabled" as const, reason: "muted" as const }],
    ["replaced", { status: "replaced" as const, heldBy: "project:acme.other" }],
  ])("is not in force while the application is %s", async (_label, overrides) => {
    const nav = await load(application(overrides));
    expect(nav.current()).toBeNull();
    expect(nav.navigateApplication(OWNER, { sectionId: "overview" })).toEqual({
      ok: false,
      reason: "stale",
    });
  });

  it("is not in force for an application that declares no navigation", async () => {
    const nav = await load(application({}, null));
    expect(nav.current()).toBeNull();
  });

  it.each([
    ["a non-object", "record"],
    ["an undeclared intent field", { sectionId: "overview", action: "acme.ledger.delete" }],
    ["a non-boolean replace", { sectionId: "overview", replace: "yes" }],
  ])("refuses %s as an invalid intent", async (_label, intent) => {
    const nav = await load();
    expect(nav.navigateApplication(OWNER, intent)).toEqual({
      ok: false,
      reason: "invalid-intent",
    });
  });

  it("refuses a section or parameter the application does not declare", async () => {
    const nav = await load();
    expect(nav.navigateApplication(OWNER, { sectionId: "admin" })).toEqual({
      ok: false,
      reason: "unknown-section",
    });
    expect(
      nav.navigateApplication(OWNER, { sectionId: "record", params: { recordId: "a b" } })
    ).toEqual({ ok: false, reason: "invalid-params" });
    expect(nav.current()?.location.sectionId).toBe("overview");
  });

  it("refuses to move while a view of the application holds unsaved work", async () => {
    const nav = await load();
    const owner = {};
    const unregister = nav.registerApplicationNavigationView(OWNER, "surface:form");
    nav.lifecycle.setViewUnsavedChanges("surface:form", owner, true);
    nav.useProjectHomeStore.getState().showGrid();

    expect(
      nav.navigateApplication(OWNER, { sectionId: "record", params: { recordId: "inv-1" } })
    ).toEqual({ ok: false, reason: "unsaved" });
    // Nothing moved: not the location, not the main area.
    expect(nav.current()?.location.sectionId).toBe("overview");
    expect(nav.route()).toBe("grid");

    nav.lifecycle.setViewUnsavedChanges("surface:form", owner, false);
    expect(
      nav.navigateApplication(OWNER, { sectionId: "record", params: { recordId: "inv-1" } }).ok
    ).toBe(true);
    unregister();
  });

  it("refuses to switch the main area for unsaved work even when the location stays", async () => {
    const nav = await load();
    const owner = {};
    const unregister = nav.registerApplicationNavigationView(OWNER, "panel:form");
    nav.useProjectHomeStore.getState().showGrid();
    nav.lifecycle.setViewUnsavedChanges("panel:form", owner, true);

    expect(nav.navigateApplication(OWNER, { sectionId: "overview" })).toEqual({
      ok: false,
      reason: "unsaved",
    });
    expect(nav.route()).toBe("grid");
    // Nothing to switch: the same location without a reveal is not a move.
    expect(nav.navigateApplication(OWNER, { sectionId: "overview", reveal: false }).ok).toBe(true);

    nav.lifecycle.setViewUnsavedChanges("panel:form", owner, false);
    unregister();
  });

  it("ignores unsaved work in a view that was never handed navigation", async () => {
    const nav = await load();
    nav.lifecycle.setViewUnsavedChanges("panel:elsewhere", {}, true);
    expect(
      nav.navigateApplication(OWNER, { sectionId: "record", params: { recordId: "a" } }).ok
    ).toBe(true);
  });

  it("brings the application's own Home forward unless asked not to", async () => {
    const nav = await load();
    nav.useProjectHomeStore.getState().showGrid();
    nav.navigateApplication(OWNER, {
      sectionId: "record",
      params: { recordId: "a" },
      reveal: false,
    });
    expect(nav.route()).toBe("grid");
    nav.navigateApplication(OWNER, { sectionId: "record", params: { recordId: "b" } });
    expect(nav.route()).toBe("home");
    expect(exitMaximize).toHaveBeenCalledTimes(1);
  });

  it("brings Home out from behind a maximized panel when the route is already Home", async () => {
    const nav = await load();
    nav.useProjectHomeStore.getState().showHome();
    panels.maximizedId = "terminal-1";
    nav.navigateApplication(OWNER, { sectionId: "record", params: { recordId: "a" } });
    expect(exitMaximize).toHaveBeenCalledTimes(1);
  });

  it("leaves the split as it is, since it already shows Home", async () => {
    const nav = await load();
    nav.useProjectHomeStore.getState().showSplit();
    panels.maximizedId = "terminal-1";
    expect(
      nav.navigateApplication(OWNER, { sectionId: "record", params: { recordId: "a" } }).ok
    ).toBe(true);
    expect(nav.route()).toBe("split");
    expect(exitMaximize).not.toHaveBeenCalled();
  });

  it("leaves a grid-destination application in the split, since the grid shows there", async () => {
    const nav = await load(
      application({
        application: { name: "Ledger", destination: "grid", navigation: NAVIGATION },
      })
    );
    nav.useProjectHomeStore.getState().showSplit();
    nav.navigateApplication(OWNER, { sectionId: "record", params: { recordId: "a" } });
    expect(nav.route()).toBe("split");
  });

  it("reads an unchosen route as the application's beside-grid default", async () => {
    const nav = await load(
      application({
        application: {
          name: "Ledger",
          destination: "home",
          arrangement: "beside-grid",
          navigation: NAVIGATION,
        },
      })
    );
    nav.navigateApplication(OWNER, { sectionId: "record", params: { recordId: "a" } });
    expect(nav.useProjectHomeStore.getState().routeByProject).toEqual({});
    expect(exitMaximize).not.toHaveBeenCalled();
  });

  it("never brings forward a Home the application does not hold", async () => {
    const nav = await load();
    nav.useProjectHomeStore.getState().showGrid();
    surface.current = { claim: { pluginId: "project:acme.other", panelKindId: "kind" } };
    nav.navigateApplication(OWNER, { sectionId: "record", params: { recordId: "a" } });
    expect(nav.route()).toBe("grid");
    surface.current = null;
    nav.navigateApplication(OWNER, { sectionId: "record", params: { recordId: "b" } });
    expect(nav.route()).toBe("grid");
  });

  it("hands every reader the same snapshot until the location moves", async () => {
    const nav = await load();
    const first = nav.current();
    expect(nav.current()).toBe(first);
    // A fresh plugin snapshot with the same declaration keeps it too.
    nav.useProjectPluginStore.setState({ application: application() });
    expect(nav.current()).toBe(first);
    nav.navigateApplication(OWNER, { sectionId: "record", params: { recordId: "a" } });
    expect(nav.current()).not.toBe(first);
  });
});

describe("restoring the location", () => {
  async function navigateThenReload(next: ProjectApplicationState) {
    const backing = installLocalStorage();
    const nav = await load();
    nav.navigateApplication(OWNER, {
      sectionId: "record",
      params: { recordId: "inv-7", draftTab: 2 },
    });
    const saved = backing.get(STORAGE_KEY);
    expect(saved).toBeDefined();
    vi.resetModules();
    installLocalStorage({ [STORAGE_KEY]: saved ?? "" });
    return load(next);
  }

  it("writes only the parameters marked persist", async () => {
    const backing = installLocalStorage();
    const nav = await load();
    nav.navigateApplication(OWNER, {
      sectionId: "record",
      params: { recordId: "inv-7", draftTab: 2 },
    });
    const blob: { state: { byProject: Record<string, { entries: { params: object }[] }> } } =
      JSON.parse(backing.get(STORAGE_KEY) ?? "{}");
    expect(blob.state.byProject["local:project-a"]?.entries.map((entry) => entry.params)).toEqual([
      {},
      { recordId: "inv-7" },
    ]);
    // The session keeps everything for this window.
    expect(nav.current()?.location.params).toEqual({ draftTab: 2, recordId: "inv-7" });
  });

  it("restores a valid location after a restart", async () => {
    const nav = await navigateThenReload(application());
    expect(nav.current()).toMatchObject({
      location: { sectionId: "record", params: { recordId: "inv-7" } },
      canGoBack: true,
    });
  });

  it("falls back to the default section when the section is gone", async () => {
    const nav = await navigateThenReload(
      application({}, { ...NAVIGATION, sections: [{ id: "overview", title: "Overview" }] })
    );
    expect(nav.current()).toMatchObject({
      location: { sectionId: "overview" },
      canGoBack: false,
    });
  });

  it("does not restore from disk a parameter that has since become session-only", async () => {
    const record = NAVIGATION.sections[1];
    const nav = await navigateThenReload(
      application(
        {},
        {
          ...NAVIGATION,
          sections: [
            { id: "overview", title: "Overview" },
            {
              ...record!,
              params: {
                recordId: { type: "string", required: true },
                draftTab: { type: "integer" },
              },
            },
          ],
        }
      )
    );
    expect(nav.current()).toMatchObject({ location: { sectionId: "overview" } });
  });

  it("starts over when the application raises its navigation version", async () => {
    const nav = await navigateThenReload(application({}, { ...NAVIGATION, version: 2 }));
    expect(nav.current()).toMatchObject({ location: { sectionId: "overview" }, canGoBack: false });
  });

  it("never hands one application's location to another owner", async () => {
    const nav = await navigateThenReload(
      application({ ownerId: "acme.other", instanceId: "project:acme.other" })
    );
    expect(nav.current()).toMatchObject({ location: { sectionId: "overview" }, canGoBack: false });
  });

  it("keeps a record that is not in force untouched", async () => {
    const backing = installLocalStorage();
    const nav = await load();
    nav.navigateApplication(OWNER, { sectionId: "record", params: { recordId: "inv-7" } });
    const saved = backing.get(STORAGE_KEY);
    nav.useProjectPluginStore.setState({ application: application({ status: "loading" }) });
    expect(nav.current()).toBeNull();
    expect(backing.get(STORAGE_KEY)).toBe(saved);
  });
});
