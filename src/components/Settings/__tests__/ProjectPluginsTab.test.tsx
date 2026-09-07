// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProjectPluginsTab } from "../ProjectPluginsTab";
import {
  __resetProjectPluginStoreForTesting,
  useProjectPluginStore,
} from "@/store/projectPluginStore";
import type { LoadedPluginInfo, PluginManifest, ProjectPluginInfo } from "@shared/types/plugin";

const PROJECT_ID = "a".repeat(64);

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: unknown) => unknown) =>
    selector({ currentProject: { id: PROJECT_ID, path: "/tmp/proj" } }),
}));

const showItemInFolder = vi.fn().mockResolvedValue(undefined);
vi.mock("@/clients", () => ({
  systemClient: { showItemInFolder: (p: string) => showItemInFolder(p) },
}));

function projectPlugin(over: Partial<ProjectPluginInfo> = {}): ProjectPluginInfo {
  return {
    projectId: PROJECT_ID,
    id: "acme.dashboard",
    instanceId: `project__${PROJECT_ID}__acme.dashboard`,
    displayName: "Acme Dashboard",
    version: "1.2.0",
    capabilities: [],
    dirName: "dashboard",
    state: "active",
    muted: false,
    collidesWithGlobal: false,
    ...over,
  };
}

const EMPTY_CONTRIBUTES: PluginManifest["contributes"] = {
  panels: [],
  toolbarButtons: [],
  menuItems: [],
  commands: [],
  views: [],
  mcpServers: [],
  skills: [],
  keybindings: [],
  contextMenus: [],
  forgeProviders: [],
  fileDecorationProviders: [],
  agents: [],
  processTools: [],
  recipes: [],
  settings: [],
};

function installed(over: Partial<LoadedPluginInfo> = {}): LoadedPluginInfo {
  return {
    manifest: {
      name: "acme.tools",
      version: "2.0.0",
      displayName: "Acme Tools",
      contributes: EMPTY_CONTRIBUTES,
    },
    instanceId: "acme.tools",
    origin: "global",
    projectId: null,
    dir: "/tmp/acme.tools",
    loadedAt: 0,
    isBuiltin: false,
    source: "sideload",
    installedAt: 0,
    archiveHash: null,
    originalUrl: null,
    loadError: null,
    disabled: false,
    updateAvailable: null,
    devMode: false,
    pluginDanger: "safe",
    blocklisted: false,
    ...over,
  };
}

const pluginApi = {
  list: vi.fn(),
  onProvenanceChanged: vi.fn(() => vi.fn()),
  setProjectPluginMuted: vi.fn().mockResolvedValue(undefined),
  setProjectPluginVisibility: vi.fn().mockResolvedValue(undefined),
  setPluginVisibilityDefault: vi.fn().mockResolvedValue(undefined),
  setProjectPluginTrust: vi.fn().mockResolvedValue(undefined),
  activateStagedProjectPlugin: vi.fn().mockResolvedValue(undefined),
  reloadProjectPlugins: vi.fn().mockResolvedValue(undefined),
  getSettingValues: vi.fn().mockResolvedValue({
    values: {},
    secretsSet: [],
    secretsPlaintext: [],
    secretTier: "keychain",
  }),
};

/** Seed the store the way a `plugin:project-plugins-changed` push would. */
function seed(plugins: ProjectPluginInfo[], enabled = true) {
  act(() => {
    useProjectPluginStore.getState().setViewProjectId(PROJECT_ID);
    useProjectPluginStore.getState().applySnapshot({
      projectId: PROJECT_ID,
      plugins,
      trust: {
        projectId: PROJECT_ID,
        decision: enabled ? "enabled" : "disabled",
        enabled,
        persisted: true,
      },
    });
  });
}

/** Open the picker and choose the entry whose visible text starts with `label`. */
async function select(label: string) {
  fireEvent.click(screen.getByTestId("project-plugin-selector-trigger"));
  const option = await screen.findByText(label);
  fireEvent.click(option);
}

beforeEach(() => {
  vi.clearAllMocks();
  pluginApi.list.mockResolvedValue([]);
  pluginApi.onProvenanceChanged.mockReturnValue(vi.fn());
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { plugin: pluginApi },
  });
});

afterEach(() => {
  cleanup();
  __resetProjectPluginStoreForTesting();
});

describe("ProjectPluginsTab", () => {
  it("opens on the project overview and offers the folder trust control", async () => {
    seed([projectPlugin()]);
    render(<ProjectPluginsTab />);

    await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());
    expect(screen.getByTestId("project-plugins-overview")).toBeTruthy();
    expect(
      screen.getAllByRole("button").some((b) => b.textContent === "Turn off project plugins")
    ).toBe(true);
  });

  it("offers enable choices instead when the folder is not trusted", async () => {
    seed([projectPlugin({ state: "blocked" })], false);
    render(<ProjectPluginsTab />);

    await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());
    const labels = screen.getAllByRole("button").map((b) => b.textContent);
    expect(labels).toContain("Enable for this project");
    expect(labels).toContain("Enable for this session");
  });

  it("mutes a project plugin through its own switch, not the folder trust control", async () => {
    seed([projectPlugin()]);
    render(<ProjectPluginsTab />);
    await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());

    await select("Acme Dashboard");
    fireEvent.click(await screen.findByTestId("project-plugin-mute-switch"));

    await waitFor(() =>
      expect(pluginApi.setProjectPluginMuted).toHaveBeenCalledWith("acme.dashboard", true)
    );
    expect(pluginApi.setProjectPluginTrust).not.toHaveBeenCalled();
  });

  it("says a muted plugin is off on its own, not that the folder is off", async () => {
    seed([projectPlugin({ state: "blocked", muted: true })]);
    render(<ProjectPluginsTab />);
    await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());

    await select("Acme Dashboard");
    const pane = await screen.findByTestId("project-plugin-detail");
    expect(pane.textContent).toContain("Switched off on its own");
    expect(pane.textContent).not.toContain("turned off as a folder");
  });

  it("hides Activate for a muted staged plugin, so the switch is the only way back", async () => {
    seed([projectPlugin({ state: "staged", muted: true })]);
    render(<ProjectPluginsTab />);
    await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());

    await select("Acme Dashboard");
    await screen.findByTestId("project-plugin-detail");
    expect(screen.queryAllByRole("button").map((b) => b.textContent)).not.toContain(
      "Activate plugin"
    );
  });

  it("reveals the plugin's folder under the project root", async () => {
    seed([projectPlugin()]);
    render(<ProjectPluginsTab />);
    await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());

    await select("Acme Dashboard");
    const reveal = (await screen.findAllByRole("button")).find(
      (b) => b.textContent === "Reveal folder"
    )!;
    fireEvent.click(reveal);

    expect(showItemInFolder).toHaveBeenCalledWith("/tmp/proj/.daintree/plugins/dashboard");
  });

  it("hides an installed plugin in this project without touching the global list", async () => {
    pluginApi.list.mockResolvedValue([installed()]);
    seed([]);
    render(<ProjectPluginsTab />);
    await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());

    await select("Acme Tools");
    fireEvent.click(await screen.findByTestId("installed-plugin-visibility-switch"));

    await waitFor(() =>
      expect(pluginApi.setProjectPluginVisibility).toHaveBeenCalledWith("acme.tools", false)
    );
  });

  it("clears the override rather than storing an explicit allow when re-enabling", async () => {
    pluginApi.list.mockResolvedValue([installed()]);
    seed([]);
    act(() => {
      useProjectPluginStore.getState().applyVisibility({
        projectId: PROJECT_ID,
        visibility: { defaultHiddenPluginIds: [], overrides: { "acme.tools": false } },
      });
    });
    render(<ProjectPluginsTab />);
    await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());

    await select("Acme Tools");
    fireEvent.click(await screen.findByTestId("installed-plugin-visibility-switch"));

    // Back to agreeing with the default, so no record is kept.
    await waitFor(() =>
      expect(pluginApi.setProjectPluginVisibility).toHaveBeenCalledWith("acme.tools", null)
    );
  });

  it("writes an explicit allow when the plugin is hidden by default", async () => {
    pluginApi.list.mockResolvedValue([installed()]);
    seed([]);
    act(() => {
      useProjectPluginStore.getState().applyVisibility({
        projectId: PROJECT_ID,
        visibility: { defaultHiddenPluginIds: ["acme.tools"], overrides: {} },
      });
    });
    render(<ProjectPluginsTab />);
    await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());

    await select("Acme Tools");
    fireEvent.click(await screen.findByTestId("installed-plugin-visibility-switch"));

    await waitFor(() =>
      expect(pluginApi.setProjectPluginVisibility).toHaveBeenCalledWith("acme.tools", true)
    );
  });

  it("switches an installed plugin to opt-in-only through the default control", async () => {
    pluginApi.list.mockResolvedValue([installed()]);
    seed([]);
    render(<ProjectPluginsTab />);
    await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());

    await select("Acme Tools");
    fireEvent.change(await screen.findByTestId("installed-plugin-visibility-default"), {
      target: { value: "selected" },
    });

    await waitFor(() =>
      expect(pluginApi.setPluginVisibilityDefault).toHaveBeenCalledWith("acme.tools", true)
    );
  });

  it("disables the per-project switch for a plugin turned off everywhere", async () => {
    pluginApi.list.mockResolvedValue([installed({ disabled: true })]);
    seed([]);
    render(<ProjectPluginsTab />);
    await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());

    await select("Acme Tools");
    const toggle = await screen.findByTestId("installed-plugin-visibility-switch");
    expect(toggle.getAttribute("data-disabled")).not.toBeNull();
    expect(screen.getByTestId("installed-plugin-detail").textContent).toContain(
      "Turned off everywhere"
    );
  });

  it("keeps a project plugin's own instance out of the installed list", async () => {
    // A project plugin loads under its instance key, so `list()` returns it
    // alongside the installed ones — it must not appear twice in the picker.
    pluginApi.list.mockResolvedValue([
      installed(),
      // How main really reports a loaded project plugin: the manifest keeps its
      // BARE name, and only `instanceId` says which project owns it.
      installed({
        instanceId: `project__${PROJECT_ID}__acme.dashboard`,
        manifest: {
          name: "acme.dashboard",
          version: "1.2.0",
          displayName: "Acme Dashboard",
          contributes: EMPTY_CONTRIBUTES,
        },
      }),
    ]);
    seed([projectPlugin()]);
    render(<ProjectPluginsTab />);
    await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("project-plugin-selector-trigger"));
    const list = await screen.findByRole("listbox");
    const names = [...list.querySelectorAll('[role="option"]')].map((o) =>
      (o.textContent ?? "").trim()
    );
    expect(names.filter((n) => n.startsWith("Acme Dashboard"))).toHaveLength(1);
  });

  it("keeps a colliding project and installed plugin apart in the picker and the pane", async () => {
    // The `collidesWithGlobal` case: same manifest id, two different plugins
    // whose switches mean different things. Picking one must open exactly one
    // pane, and the two rows must not share a DOM id.
    pluginApi.list.mockResolvedValue([installed()]);
    seed([
      projectPlugin({
        id: "acme.tools",
        instanceId: `project__${PROJECT_ID}__acme.tools`,
        displayName: "Acme Tools (project)",
        collidesWithGlobal: true,
      }),
    ]);
    render(<ProjectPluginsTab />);
    await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("project-plugin-selector-trigger"));
    const list = await screen.findByRole("listbox");
    const ids = [...list.querySelectorAll("[id^='project-plugin-selector-item-']")].map(
      (el) => el.id
    );
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    fireEvent.click(await screen.findByText("Acme Tools (project)"));

    expect(await screen.findByTestId("project-plugin-detail")).toBeTruthy();
    expect(screen.queryByTestId("installed-plugin-detail")).toBeNull();

    await select("Acme Tools");
    expect(await screen.findByTestId("installed-plugin-detail")).toBeTruthy();
    expect(screen.queryByTestId("project-plugin-detail")).toBeNull();
  });

  it("falls back to the overview when the selected plugin disappears", async () => {
    seed([projectPlugin()]);
    render(<ProjectPluginsTab />);
    await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());
    await select("Acme Dashboard");
    expect(screen.queryByTestId("project-plugin-detail")).toBeTruthy();

    seed([]);

    await waitFor(() => expect(screen.queryByTestId("project-plugin-detail")).toBeNull());
    expect(screen.getByTestId("project-plugins-overview")).toBeTruthy();
  });
});
