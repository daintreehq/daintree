import { describe, it, expect, beforeEach, vi } from "vitest";

interface FakeProject {
  id: string;
  path: string;
  status: string;
}

const projectStoreMock = vi.hoisted(() => ({
  getCurrentProjectId: vi.fn<() => string | null>(() => null),
  getProjectById: vi.fn<(id: string) => FakeProject | null>(() => null),
}));

vi.mock("../services/ProjectStore.js", () => ({ projectStore: projectStoreMock }));

const windowRefMock = vi.hoisted(() => ({
  getWindowRegistry: vi.fn<() => unknown>(() => undefined),
}));

vi.mock("../window/windowRef.js", () => windowRefMock);

// Mirrors the real menu: getMenuItemById hands back the live MenuItem, and
// assigning .enabled on it is what repaints the native menu.
const menuItems = new Map<string, { enabled: boolean }>();
const applicationMenu = {
  getMenuItemById: vi.fn((id: string) => menuItems.get(id) ?? null),
};
const getApplicationMenuMock = vi.hoisted(() => vi.fn<() => unknown>());

vi.mock("electron", () => ({
  Menu: { getApplicationMenu: getApplicationMenuMock },
}));

const { PROJECT_MENU_ITEM_IDS, refreshProjectMenuState, resolveProjectIdForApplicationMenu } =
  await import("../projectMenuState.js");

const [SETTINGS_ID, CLOSE_ID] = PROJECT_MENU_ITEM_IDS;

function openProject(id: string, status = "active"): FakeProject {
  return { id, path: `/tmp/${id}`, status };
}

/** A window whose ProjectViewManager reports `activeId` as its active workspace. */
function pvmWindow(activeId: string | null) {
  return { services: { projectViewManager: { getActiveProjectId: () => activeId } } };
}

/** A window with no ProjectViewManager at all (legacy host). */
function legacyWindow() {
  return { services: {} };
}

function registryWith(primary: unknown) {
  return { getPrimary: () => primary };
}

beforeEach(() => {
  vi.clearAllMocks();
  projectStoreMock.getCurrentProjectId.mockReturnValue(null);
  projectStoreMock.getProjectById.mockReturnValue(null);
  windowRefMock.getWindowRegistry.mockReturnValue(undefined);

  menuItems.clear();
  menuItems.set(SETTINGS_ID, { enabled: false });
  menuItems.set(CLOSE_ID, { enabled: false });
  getApplicationMenuMock.mockReturnValue(applicationMenu);
});

describe("resolveProjectIdForApplicationMenu", () => {
  it("reads the focused window's project, not the global most-recently-switched pointer", () => {
    // The classic multi-window trap: the global pointer names the project that
    // switched last, which is NOT what the focused window is showing.
    projectStoreMock.getCurrentProjectId.mockReturnValue("other-window-project");
    projectStoreMock.getProjectById.mockImplementation((id) => openProject(id));
    windowRefMock.getWindowRegistry.mockReturnValue(registryWith(pvmWindow("focused-project")));

    expect(resolveProjectIdForApplicationMenu()).toBe("focused-project");
  });

  it("reports no project when the focused window shows none, even if the pointer names one", () => {
    projectStoreMock.getCurrentProjectId.mockReturnValue("other-window-project");
    projectStoreMock.getProjectById.mockImplementation((id) => openProject(id));
    windowRefMock.getWindowRegistry.mockReturnValue(registryWith(pvmWindow(null)));

    expect(resolveProjectIdForApplicationMenu()).toBeNull();
  });

  it("rejects a project whose row is closed even while the window is still bound to it", () => {
    // Closing a project marks the row "closed" but leaves the window's PVM
    // pointing at it. Trusting the raw PVM id would leave the gates stuck open —
    // this is the close half of #11136.
    projectStoreMock.getProjectById.mockReturnValue(openProject("project-1", "closed"));
    windowRefMock.getWindowRegistry.mockReturnValue(registryWith(pvmWindow("project-1")));

    expect(resolveProjectIdForApplicationMenu()).toBeNull();
  });

  it("rejects a scratch workspace, which has a PVM id but no project row", () => {
    projectStoreMock.getProjectById.mockReturnValue(null);
    windowRefMock.getWindowRegistry.mockReturnValue(registryWith(pvmWindow("scratch-uuid")));

    expect(resolveProjectIdForApplicationMenu()).toBeNull();
  });

  it("keeps a project open when its row is background (status is process-global)", () => {
    // A project visible in a non-focused window is legitimately "background",
    // so only "closed" may disable the gates.
    projectStoreMock.getProjectById.mockReturnValue(openProject("project-1", "background"));
    windowRefMock.getWindowRegistry.mockReturnValue(registryWith(pvmWindow("project-1")));

    expect(resolveProjectIdForApplicationMenu()).toBe("project-1");
  });

  it("reports no project when the app is windowless, without falling back to the pointer", () => {
    // macOS keeps the menu bar alive with zero windows; nothing is on screen.
    projectStoreMock.getCurrentProjectId.mockReturnValue("project-1");
    projectStoreMock.getProjectById.mockImplementation((id) => openProject(id));
    windowRefMock.getWindowRegistry.mockReturnValue(registryWith(undefined));

    expect(resolveProjectIdForApplicationMenu()).toBeNull();
  });

  it("falls back to the global pointer for a window with no ProjectViewManager", () => {
    projectStoreMock.getCurrentProjectId.mockReturnValue("project-1");
    projectStoreMock.getProjectById.mockImplementation((id) => openProject(id));
    windowRefMock.getWindowRegistry.mockReturnValue(registryWith(legacyWindow()));

    expect(resolveProjectIdForApplicationMenu()).toBe("project-1");
  });

  it("falls back to the global pointer when there is no window layer at all", () => {
    projectStoreMock.getCurrentProjectId.mockReturnValue("project-1");
    projectStoreMock.getProjectById.mockImplementation((id) => openProject(id));
    windowRefMock.getWindowRegistry.mockReturnValue(undefined);

    expect(resolveProjectIdForApplicationMenu()).toBe("project-1");
  });

  it("still validates the row when falling back to the global pointer", () => {
    projectStoreMock.getCurrentProjectId.mockReturnValue("project-1");
    projectStoreMock.getProjectById.mockReturnValue(openProject("project-1", "closed"));
    windowRefMock.getWindowRegistry.mockReturnValue(undefined);

    expect(resolveProjectIdForApplicationMenu()).toBeNull();
  });
});

describe("refreshProjectMenuState", () => {
  it("enables both gates when a project opens in the focused window", () => {
    projectStoreMock.getProjectById.mockImplementation((id) => openProject(id));
    windowRefMock.getWindowRegistry.mockReturnValue(registryWith(pvmWindow("project-1")));

    refreshProjectMenuState();

    expect(menuItems.get(SETTINGS_ID)!.enabled).toBe(true);
    expect(menuItems.get(CLOSE_ID)!.enabled).toBe(true);
  });

  it("disables both gates when the focused project closes", () => {
    // Drive the real transition: enabled while open, then the row goes "closed"
    // with the PVM binding left intact, exactly as handleProjectClose leaves it.
    projectStoreMock.getProjectById.mockReturnValue(openProject("project-1"));
    windowRefMock.getWindowRegistry.mockReturnValue(registryWith(pvmWindow("project-1")));
    refreshProjectMenuState();
    expect(menuItems.get(CLOSE_ID)!.enabled).toBe(true);

    projectStoreMock.getProjectById.mockReturnValue(openProject("project-1", "closed"));
    refreshProjectMenuState();

    expect(menuItems.get(SETTINGS_ID)!.enabled).toBe(false);
    expect(menuItems.get(CLOSE_ID)!.enabled).toBe(false);
  });

  it("tracks focus moving between a project window and a welcome window", () => {
    projectStoreMock.getProjectById.mockImplementation((id) => openProject(id));

    windowRefMock.getWindowRegistry.mockReturnValue(registryWith(pvmWindow("project-1")));
    refreshProjectMenuState();
    expect(menuItems.get(CLOSE_ID)!.enabled).toBe(true);

    windowRefMock.getWindowRegistry.mockReturnValue(registryWith(pvmWindow(null)));
    refreshProjectMenuState();
    expect(menuItems.get(CLOSE_ID)!.enabled).toBe(false);

    windowRefMock.getWindowRegistry.mockReturnValue(registryWith(pvmWindow("project-2")));
    refreshProjectMenuState();
    expect(menuItems.get(CLOSE_ID)!.enabled).toBe(true);
  });

  it("does not throw when no application menu has been built yet", () => {
    getApplicationMenuMock.mockReturnValue(null);
    expect(() => refreshProjectMenuState()).not.toThrow();
  });

  it("does not throw when the menu is missing the project items", () => {
    menuItems.clear();
    expect(() => refreshProjectMenuState()).not.toThrow();
  });
});
