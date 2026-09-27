// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createContext, use } from "react";
import type { ReactNode } from "react";
import { ProjectPluginsTab } from "../ProjectPluginsTab";
import {
  __resetProjectPluginStoreForTesting,
  useProjectPluginStore,
} from "@/store/projectPluginStore";
import {
  _resetPluginProjectSurfacesStoreForTest,
  usePluginProjectSurfacesStore,
} from "@/store/pluginProjectSurfacesStore";
import { usePluginManagerStore } from "@/store/pluginManagerStore";
import { registerPanelKind, unregisterPanelKind } from "@shared/config/panelKindRegistry";
import type {
  LoadedPluginInfo,
  PluginManifest,
  ProjectPluginInfo,
  ProjectSurfaceChoice,
} from "@shared/types/plugin";

const PROJECT_ID = "a".repeat(64);

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: unknown) => unknown) =>
    selector({ currentProject: { id: PROJECT_ID, path: "/tmp/proj" } }),
}));

// The real Select lazy-loads Radix. This stand-in keeps the trigger's own props (its
// test id and label) and lets a test pick an option with a click.
vi.mock("@/components/ui/select", () => {
  interface Ctx {
    value: string;
    onValueChange: (v: string) => void;
    disabled?: boolean;
  }
  const SelectCtx = createContext<Ctx | null>(null);
  return {
    Select: ({ children, ...ctx }: Ctx & { children: ReactNode }) => (
      <SelectCtx value={ctx}>{children}</SelectCtx>
    ),
    SelectTrigger: ({ children, ...props }: { children: ReactNode }) => {
      const ctx = use(SelectCtx)!;
      return (
        <button type="button" role="combobox" disabled={ctx.disabled} {...props}>
          {children}
        </button>
      );
    },
    SelectValue: () => <span>{use(SelectCtx)!.value}</span>,
    SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    SelectItem: ({ value, children }: { value: string; children: ReactNode }) => {
      const ctx = use(SelectCtx)!;
      return (
        <button type="button" data-select-item={value} onClick={() => ctx.onValueChange(value)}>
          {children}
        </button>
      );
    },
  };
});

const showItemInFolder = vi.fn().mockResolvedValue(undefined);
const dispatch = vi.fn();
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatch(...args) },
}));

// The generated form's secret-clear confirm pulls the app dialog stack (and the panel
// store behind it) into this suite; nothing here opens it.
vi.mock("@/components/ui/ConfirmDialog", () => ({ ConfirmDialog: () => null }));

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
  fileEditors: [],
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
  // Main records the answer against the slot's owner and returns the new set.
  setProjectSurfaceChoice: vi.fn((_slot: string, choice: ProjectSurfaceChoice | null) =>
    Promise.resolve({
      projectId: PROJECT_ID,
      choices:
        choice === null
          ? {}
          : { emptyCanvas: { pluginId: "acme.dashboard", choice, decidedAt: 2 } },
    })
  ),
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
  // Within the list: a plugin's name can also be on the page (the overview lists
  // plugins that need a look).
  const list = await screen.findByRole("listbox", { name: "Plugins" });
  const option = await within(list).findByText(label);
  fireEvent.click(option);
}

beforeEach(() => {
  vi.clearAllMocks();
  pluginApi.list.mockResolvedValue([]);
  pluginApi.onProvenanceChanged.mockReturnValue(vi.fn());
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      plugin: pluginApi,
      pluginAgentMcp: {
        listProjectPlugins: vi.fn().mockResolvedValue({ plugins: [], mcpServerEnabled: true }),
        setPluginAccess: vi.fn(),
      },
    },
  });
});

afterEach(() => {
  cleanup();
  __resetProjectPluginStoreForTesting();
  _resetPluginProjectSurfacesStoreForTest();
  unregisterPanelKind(CANVAS_KIND_ID);
});

const CANVAS_KIND_ID = `project:${PROJECT_ID}/acme.dashboard/overview`;
const CANVAS_OWNER = `project__${PROJECT_ID}__acme.dashboard`;

/** A running project plugin whose empty-canvas claim can render, answered or not. */
function claimEmptyCanvas(choice?: ProjectSurfaceChoice) {
  registerPanelKind({
    id: CANVAS_KIND_ID,
    name: "Overview",
    iconId: "gauge",
    color: "#ffffff",
    hasPty: false,
    canRestart: false,
    canConvert: false,
    extensionId: CANVAS_OWNER,
    componentPath: "plugin://acme.dashboard/1/panel.js",
  });
  act(() => {
    usePluginProjectSurfacesStore.setState({
      surfaces: {
        emptyCanvas: { pluginId: CANVAS_OWNER, panelKindId: CANVAS_KIND_ID },
      },
      choices: choice ? { emptyCanvas: { pluginId: "acme.dashboard", choice, decidedAt: 1 } } : {},
      choicesLoaded: true,
    });
  });
}

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

  it("discloses which plugin owns the empty canvas and resets the answer", async () => {
    seed([projectPlugin()]);
    claimEmptyCanvas("stock");
    render(<ProjectPluginsTab />);
    await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());

    // A remembered "use the launcher" is never silent: the plugin is named, the
    // answer is stated, and it can be undone from here.
    const section = screen.getByTestId("project-plugins-empty-canvas");
    expect(section.textContent).toContain("Acme Dashboard draws what this project shows");
    expect(section.textContent).toContain("You chose the launcher, so it's hidden.");

    fireEvent.click(within(section).getByRole("button", { name: "Reset choice" }));

    await waitFor(() =>
      expect(pluginApi.setProjectSurfaceChoice).toHaveBeenCalledWith("emptyCanvas", null)
    );
    await waitFor(() =>
      expect(section.textContent).toContain("You haven't chosen yet, so it shows.")
    );
    expect(
      within(section).getByRole("button", { name: "Reset choice" }).hasAttribute("disabled")
    ).toBe(true);
  });

  it("switches the empty canvas to the launcher from settings", async () => {
    seed([projectPlugin()]);
    claimEmptyCanvas();
    render(<ProjectPluginsTab />);
    await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());

    const section = screen.getByTestId("project-plugins-empty-canvas");
    expect(section.textContent).toContain("You haven't chosen yet, so it shows.");
    // Nothing to reset until something has been chosen.
    expect(
      within(section).getByRole("button", { name: "Reset choice" }).hasAttribute("disabled")
    ).toBe(true);

    fireEvent.click(screen.getByTestId("project-empty-canvas-switch"));

    await waitFor(() =>
      expect(pluginApi.setProjectSurfaceChoice).toHaveBeenCalledWith("emptyCanvas", "stock")
    );
    await waitFor(() =>
      expect(section.textContent).toContain("You chose the launcher, so it's hidden.")
    );
  });

  it("says so when the canvas choice couldn't be saved", async () => {
    seed([projectPlugin()]);
    claimEmptyCanvas();
    pluginApi.setProjectSurfaceChoice.mockRejectedValueOnce(new Error("ENOSPC"));
    render(<ProjectPluginsTab />);
    await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("project-empty-canvas-switch"));

    const section = screen.getByTestId("project-plugins-empty-canvas");
    expect((await within(section).findByRole("alert")).textContent).toContain(
      "Couldn't save the canvas choice"
    );
    // Nothing was recorded, so the section still describes what is on disk.
    expect(section.textContent).toContain("You haven't chosen yet, so it shows.");

    fireEvent.click(within(section).getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(section.textContent).toContain("You chose the launcher, so it's hidden.")
    );
    expect(within(section).queryByRole("alert")).toBeNull();
  });

  it("says nothing about the empty canvas when no plugin claims it", async () => {
    seed([projectPlugin()]);
    render(<ProjectPluginsTab />);
    await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());

    expect(screen.queryByTestId("project-plugins-empty-canvas")).toBeNull();
  });

  it("describes the empty canvas only once its answer is known and the claim can render", async () => {
    seed([projectPlugin()]);
    claimEmptyCanvas();
    act(() => {
      usePluginProjectSurfacesStore.setState({ choicesLoaded: false });
    });
    render(<ProjectPluginsTab />);
    await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());

    // Before the answer is read, "you haven't chosen yet" could be false.
    expect(screen.queryByTestId("project-plugins-empty-canvas")).toBeNull();

    act(() => {
      usePluginProjectSurfacesStore.setState({ choicesLoaded: true });
    });
    expect(screen.getByTestId("project-plugins-empty-canvas")).toBeTruthy();

    // A claim whose view cannot render leaves the canvas stock: nothing to describe.
    act(() => {
      unregisterPanelKind(CANVAS_KIND_ID);
    });
    expect(screen.queryByTestId("project-plugins-empty-canvas")).toBeNull();
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

  it("offers a staged plugin's activation in place of a switch that would read as on", async () => {
    seed([projectPlugin({ state: "staged", muted: false })]);
    render(<ProjectPluginsTab />);
    await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());

    await select("Acme Dashboard");
    await screen.findByTestId("project-plugin-detail");
    expect(screen.queryByTestId("project-plugin-mute-switch")).toBeNull();
    expect(screen.getByRole("button", { name: "Activate plugin" })).toBeTruthy();
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

  it("sends a forge plugin's settings to its own Code forge page instead of editing them here", async () => {
    const settings = [{ id: "instanceUrl", type: "string" as const, label: "Instance URL" }];
    pluginApi.list.mockResolvedValue([
      installed({
        manifest: {
          name: "acme.forge",
          version: "1.0.0",
          displayName: "Acme Forge",
          contributes: {
            ...EMPTY_CONTRIBUTES,
            settings,
            forgeProviders: [
              {
                id: "acme",
                name: "Acme",
                matches: ["acme.test"],
                slots: { settingsTab: "acme.settingsTab" },
              },
            ],
          },
        } as LoadedPluginInfo["manifest"],
        instanceId: "acme.forge",
      }),
    ]);
    seed([]);
    const opened = vi.fn();
    window.addEventListener("daintree:open-settings-tab", opened);
    render(<ProjectPluginsTab />);
    await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());

    await select("Acme Forge");
    // Its own page guards changes this generic form can't (a token tied to the value).
    expect(screen.queryByRole("textbox", { name: "Instance URL" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Open Code forge" }));
    expect(opened).toHaveBeenCalledTimes(1);
    expect((opened.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      tab: "code-forge",
      subtab: "acme.forge.acme",
    });
    window.removeEventListener("daintree:open-settings-tab", opened);
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
    const trigger = await screen.findByTestId("installed-plugin-visibility-default");
    expect(trigger.getAttribute("aria-label")).toBe("Which projects show this plugin by default");
    fireEvent.click(screen.getByRole("button", { name: "Only projects I turn it on in" }));

    await waitFor(() =>
      expect(pluginApi.setPluginVisibilityDefault).toHaveBeenCalledWith("acme.tools", true)
    );
  });

  it("offers no show/hide switch for a plugin turned off everywhere, only the way back", async () => {
    pluginApi.list.mockResolvedValue([installed({ disabled: true })]);
    seed([]);
    render(<ProjectPluginsTab />);
    await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());

    await select("Acme Tools");
    const pane = await screen.findByTestId("installed-plugin-detail");
    // Nothing runs, so there is nothing to show or hide: no switch that could read "on".
    expect(screen.queryByTestId("installed-plugin-visibility-switch")).toBeNull();
    expect(pane.textContent).toContain("Turned off everywhere");
    fireEvent.click(within(pane).getByRole("button", { name: "Open plugin manager" }));
    expect(dispatch).toHaveBeenCalledWith("app.pluginManager", undefined, { source: "user" });
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

describe("ProjectPluginsTab settings deep link and lifecycle", () => {
  const INSTANCE = `project__${PROJECT_ID}__acme.dashboard`;

  function loadedProjectPlugin(): LoadedPluginInfo {
    return installed({
      manifest: {
        name: "acme.dashboard",
        version: "1.2.0",
        displayName: "Acme Dashboard",
        contributes: {
          ...EMPTY_CONTRIBUTES,
          settings: [{ id: "apiKey", type: "string", label: "API key", scope: "project" }],
        },
      },
      instanceId: INSTANCE,
      origin: "project",
      projectId: PROJECT_ID,
    });
  }

  afterEach(() => {
    usePluginManagerStore.setState({ settingsRequest: null });
  });

  it("selects the plugin a link names and lands on the requested field", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    pluginApi.list.mockResolvedValue([loadedProjectPlugin()]);
    seed([projectPlugin()]);
    act(() =>
      usePluginManagerStore
        .getState()
        .requestSettings({ pluginId: INSTANCE, key: "apiKey", home: "project" })
    );
    render(<ProjectPluginsTab />);

    const field = await screen.findByLabelText("API key");
    await waitFor(() => expect(document.activeElement).toBe(field));
    await waitFor(() => expect(usePluginManagerStore.getState().settingsRequest).toBeNull());
  });

  it("puts a key-less link on the plugin's Settings heading", async () => {
    pluginApi.list.mockResolvedValue([loadedProjectPlugin()]);
    seed([projectPlugin()]);
    act(() =>
      usePluginManagerStore.getState().requestSettings({ pluginId: INSTANCE, home: "project" })
    );
    render(<ProjectPluginsTab />);

    await waitFor(() =>
      expect(document.activeElement?.hasAttribute("data-settings-section-title")).toBe(true)
    );
    expect(document.activeElement?.textContent).toBe("Settings");
    expect(usePluginManagerStore.getState().settingsRequest).toBeNull();
  });

  it("keeps a muted plugin's Settings section, saying what it needs, with nothing to write to", async () => {
    // Muted: no loaded instance, so no manifest reaches the settings bridge.
    pluginApi.list.mockResolvedValue([]);
    seed([
      projectPlugin({
        muted: true,
        state: "blocked",
        settings: [{ id: "apiKey", type: "secret", label: "API key", scope: "project" }],
        declaresSettingsView: true,
      }),
    ]);
    render(<ProjectPluginsTab />);
    await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());
    await select("Acme Dashboard");

    const detail = screen.getByTestId("project-plugin-detail");
    expect(within(detail).getByText("API key")).toBeTruthy();
    expect(within(detail).getByText("More settings")).toBeTruthy();
    expect(within(detail).getAllByText("Available once the plugin is turned on")).toHaveLength(2);
    // Declarations only: nothing is read or editable without the plugin loaded.
    expect(within(detail).queryByRole("textbox")).toBeNull();
    expect(pluginApi.getSettingValues).not.toHaveBeenCalled();
  });

  it("drops the editable form the moment the plugin stops, before the loaded list catches up", async () => {
    // The list keeps answering with the loaded instance — the refresh that
    // would drop it has not landed — while the project state says it stopped.
    pluginApi.list.mockResolvedValue([loadedProjectPlugin()]);
    seed([projectPlugin()]);
    render(<ProjectPluginsTab />);
    await select("Acme Dashboard");
    expect(await screen.findByLabelText("API key")).toBeTruthy();

    seed([
      projectPlugin({
        muted: true,
        settings: [{ id: "apiKey", type: "string", label: "API key", scope: "project" }],
      }),
    ]);

    const detail = screen.getByTestId("project-plugin-detail");
    await waitFor(() => expect(within(detail).queryByRole("textbox")).toBeNull());
    expect(within(detail).getByText("Available once the plugin is turned on")).toBeTruthy();
  });

  it("lands a link to a stopped plugin's field on its Settings heading, even with a stale list", async () => {
    pluginApi.list.mockResolvedValue([loadedProjectPlugin()]);
    seed([
      projectPlugin({
        muted: true,
        settings: [{ id: "apiKey", type: "string", label: "API key", scope: "project" }],
      }),
    ]);
    act(() =>
      usePluginManagerStore
        .getState()
        .requestSettings({ pluginId: INSTANCE, key: "apiKey", home: "project" })
    );
    render(<ProjectPluginsTab />);

    await waitFor(() =>
      expect(document.activeElement?.hasAttribute("data-settings-section-title")).toBe(true)
    );
    expect(usePluginManagerStore.getState().settingsRequest).toBeNull();
  });

  it("re-reads the running plugins when a project plugin is muted, not only on provenance", async () => {
    pluginApi.list.mockResolvedValue([loadedProjectPlugin()]);
    seed([projectPlugin()]);
    render(<ProjectPluginsTab />);
    await waitFor(() => expect(pluginApi.list).toHaveBeenCalledTimes(1));

    seed([projectPlugin({ muted: true })]);

    await waitFor(() => expect(pluginApi.list).toHaveBeenCalledTimes(2));
  });
});

describe("ProjectPluginsTab failures and state honesty", () => {
  /** Every alert on the page, and the settings row each one sits in. */
  function alertsWithRows() {
    return screen.getAllByRole("alert").map((alert) => ({
      alert,
      row: alert.closest<HTMLElement>("[data-settings-row]"),
    }));
  }

  it("states a failed action on the row whose control made it, and retries that write", async () => {
    pluginApi.setProjectPluginMuted.mockRejectedValueOnce(new Error("EACCES: permission denied"));
    seed([projectPlugin()]);
    render(<ProjectPluginsTab />);
    await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());
    await select("Acme Dashboard");

    const toggle = await screen.findByTestId("project-plugin-mute-switch");
    fireEvent.click(toggle);

    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));
    for (const { alert, row } of alertsWithRows()) {
      // Never a line of its own above the page: on the row, beside the control.
      expect(row).not.toBeNull();
      expect(row!.contains(toggle)).toBe(true);
      expect(alert.textContent).toContain("Couldn't turn off Acme Dashboard");
      expect(alert.textContent).toContain("EACCES");
    }

    fireEvent.click(within(alertsWithRows()[0]!.row!).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(pluginApi.setProjectPluginMuted).toHaveBeenCalledTimes(2));
    expect(pluginApi.setProjectPluginMuted.mock.calls[1]).toEqual(
      pluginApi.setProjectPluginMuted.mock.calls[0]
    );
    await waitFor(() => expect(screen.queryAllByRole("alert")).toHaveLength(0));
  });

  it("keeps a failure's words off the status colours, leaving severity to the glyph", async () => {
    pluginApi.setProjectPluginMuted.mockRejectedValueOnce(new Error("EACCES"));
    seed([projectPlugin()]);
    render(<ProjectPluginsTab />);
    await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());
    await select("Acme Dashboard");
    fireEvent.click(await screen.findByTestId("project-plugin-mute-switch"));
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));

    for (const { row } of alertsWithRows()) {
      const coloured = [...row!.querySelectorAll<HTMLElement>("*")].filter(
        (el) =>
          el.tagName.toLowerCase() !== "svg" &&
          el.closest("svg") === null &&
          [...el.classList].some((c) => c.startsWith("text-status-"))
      );
      expect(coloured).toEqual([]);
    }
  });

  it("drops a failure when the page moves on to another pane", async () => {
    pluginApi.setProjectPluginMuted.mockRejectedValueOnce(new Error("EACCES"));
    seed([projectPlugin()]);
    render(<ProjectPluginsTab />);
    await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());
    await select("Acme Dashboard");
    fireEvent.click(await screen.findByTestId("project-plugin-mute-switch"));
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));

    await select("This project");
    await screen.findByTestId("project-plugins-overview");
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    // Coming back finds the plugin as it is now, not the old attempt waiting to be read.
    await select("Acme Dashboard");
    await screen.findByTestId("project-plugin-mute-switch");
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  it.each([
    { folder: true, muted: false, state: "active" as const },
    { folder: true, muted: true, state: "active" as const },
    { folder: false, muted: false, state: "blocked" as const },
    { folder: false, muted: true, state: "blocked" as const },
  ])(
    "shows the run switch on only while the plugin is running (folder $folder, muted $muted)",
    async ({ folder, muted, state }) => {
      seed([projectPlugin({ muted, state })], folder);
      render(<ProjectPluginsTab />);
      await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());
      await select("Acme Dashboard");

      const toggle = await screen.findByTestId("project-plugin-mute-switch");
      const trigger = screen.getByTestId("project-plugin-selector-trigger");
      const running = trigger.textContent?.includes("Running") ?? false;
      expect(toggle.getAttribute("aria-checked")).toBe(String(running));
    }
  );

  it("keeps a failure that isn't one plugin's when moving between panes, until it is retried", async () => {
    pluginApi.list.mockResolvedValue([installed()]);
    seed([]);
    act(() =>
      useProjectPluginStore.setState({
        error: "store is read-only",
        errorSource: { action: "loadVisibility", reason: "store is read-only" },
      })
    );
    render(<ProjectPluginsTab />);
    await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());

    // Read while the overview showed, stated on the pane the read was for.
    await select("Acme Tools");
    const alert = await screen.findByRole("alert");
    expect(alert.closest("[data-settings-row]")?.textContent).toContain("Show in this project");
    expect(alert.textContent).toContain("store is read-only");
  });

  it("lists a running plugin whose required settings aren't set, and sets it up at the first one", async () => {
    const getRequiredSettingsStatus = vi.fn().mockResolvedValue({
      missing: ["apiKey", "region"],
      unreadable: [],
      labels: { apiKey: "API key", region: "Region" },
    });
    Object.assign(pluginApi, {
      getRequiredSettingsStatus,
      onSettingsChanged: vi.fn(() => vi.fn()),
    });
    seed([
      projectPlugin({
        settings: [
          { id: "apiKey", type: "secret", label: "API key", required: true, scope: "project" },
          { id: "region", type: "string", label: "Region", required: true, scope: "project" },
        ],
      }),
    ]);
    render(<ProjectPluginsTab />);

    const group = await screen.findByRole("group", { name: "Needs attention" });
    await waitFor(() => expect(group.textContent).toContain("API key, Region aren't set yet"));
    fireEvent.click(within(group).getByRole("button", { name: "Set up" }));
    expect(dispatch).toHaveBeenCalledWith(
      "plugin.openSettings",
      { pluginId: `project__${PROJECT_ID}__acme.dashboard`, key: "apiKey" },
      { source: "user" }
    );
    delete (pluginApi as Partial<typeof pluginApi & { getRequiredSettingsStatus: unknown }>)
      .getRequiredSettingsStatus;
  });

  it("lists a stored path that no longer exists, and says so when the check itself fails", async () => {
    const getRequiredSettingsStatus = vi
      .fn()
      .mockResolvedValue({ missing: [], unreadable: [], labels: {} });
    const pathExists = vi.fn().mockResolvedValue(false);
    Object.assign(pluginApi, {
      getRequiredSettingsStatus,
      pathExists,
      onSettingsChanged: vi.fn(() => vi.fn()),
    });
    pluginApi.getSettingValues.mockResolvedValue({
      values: { out: "/Volumes/gone" },
      secretsSet: [],
      secretsPlaintext: [],
      secretTier: "keychain",
    });
    seed([
      projectPlugin({
        settings: [
          {
            id: "out",
            type: "directory",
            label: "Output folder",
            mustExist: true,
            scope: "project",
          },
        ],
      }),
    ]);
    const { unmount } = render(<ProjectPluginsTab />);
    const group = await screen.findByRole("group", { name: "Needs attention" });
    await waitFor(() => expect(group.textContent).toContain("Output folder no longer exists"));
    expect(pathExists).toHaveBeenCalledWith(
      `project__${PROJECT_ID}__acme.dashboard`,
      "/Volumes/gone"
    );
    unmount();

    // The check can't be made: the row says the list may be incomplete, and Retry checks again.
    pathExists.mockReset().mockRejectedValueOnce(new Error("EIO")).mockResolvedValue(true);
    render(<ProjectPluginsTab />);
    const failed = await screen.findByRole("group", { name: "Needs attention" });
    const alert = await within(failed).findByRole("alert");
    expect(alert.textContent).toContain("Couldn't check all of its settings");
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Needs attention" })).toBeNull()
    );
    for (const key of ["getRequiredSettingsStatus", "pathExists", "onSettingsChanged"]) {
      delete (pluginApi as Record<string, unknown>)[key];
    }
  });

  it("lists each group by name and says Hidden for an installed plugin hidden here", async () => {
    pluginApi.list.mockResolvedValue([
      installed({
        instanceId: "zeta.tools",
        manifest: { ...installed().manifest, displayName: "Zeta Tools" },
      }),
      installed({
        instanceId: "alpha.tools",
        manifest: { ...installed().manifest, displayName: "alpha Tools" },
      }),
    ]);
    seed([
      projectPlugin({
        id: "b.one",
        instanceId: `project__${PROJECT_ID}__b.one`,
        displayName: "Beta",
        dirName: "b",
      }),
      projectPlugin({
        id: "a.one",
        instanceId: `project__${PROJECT_ID}__a.one`,
        displayName: "Alpha",
        dirName: "a",
      }),
    ]);
    act(() =>
      useProjectPluginStore.getState().applyVisibility({
        projectId: PROJECT_ID,
        visibility: { defaultHiddenPluginIds: [], overrides: { "zeta.tools": false } },
      })
    );
    render(<ProjectPluginsTab />);
    await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("project-plugin-selector-trigger"));
    const list = await screen.findByRole("listbox", { name: "Plugins" });
    await within(list).findByText("Zeta Tools");
    const rows = [...list.querySelectorAll('[role="option"]:not([aria-disabled="true"])')].map(
      (el) => el.textContent
    );
    expect(rows.slice(1)).toEqual([
      expect.stringContaining("Alpha"),
      expect.stringContaining("Beta"),
      expect.stringContaining("alpha Tools"),
      expect.stringContaining("Zeta Tools"),
    ]);
    expect(rows[4]).toContain("Hidden");
    expect(rows[3]).toContain("Installed");
  });

  it("names the right verb when returning to a hidden default fails", async () => {
    pluginApi.list.mockResolvedValue([installed()]);
    pluginApi.setProjectPluginVisibility.mockRejectedValueOnce(new Error("EACCES"));
    seed([]);
    act(() =>
      useProjectPluginStore.getState().applyVisibility({
        projectId: PROJECT_ID,
        visibility: { defaultHiddenPluginIds: ["acme.tools"], overrides: { "acme.tools": true } },
      })
    );
    render(<ProjectPluginsTab />);
    await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());
    await select("Acme Tools");
    // Shown by override over a hidden default: switching off writes null (back to hidden).
    fireEvent.click(await screen.findByTestId("installed-plugin-visibility-switch"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't hide Acme Tools");
  });

  it("says so on its row when revealing the plugin's folder fails, and retries it", async () => {
    showItemInFolder.mockRejectedValueOnce(new Error("Finder isn't responding"));
    seed([projectPlugin()]);
    render(<ProjectPluginsTab />);
    await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());
    await select("Acme Dashboard");
    fireEvent.click(await screen.findByRole("button", { name: "Reveal folder" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't reveal the plugin's folder");
    expect(alert.closest("[data-settings-row]")?.textContent).toContain("Plugins folder");
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(showItemInFolder).toHaveBeenCalledTimes(2);
  });

  it("keeps a gap it found when another part of the check fails", async () => {
    Object.assign(pluginApi, {
      getRequiredSettingsStatus: vi.fn().mockResolvedValue({
        missing: ["token"],
        unreadable: [],
        labels: { token: "Token" },
      }),
      pathExists: vi.fn().mockRejectedValue(new Error("EIO")),
      onSettingsChanged: vi.fn(() => vi.fn()),
    });
    pluginApi.getSettingValues.mockResolvedValue({
      values: { out: "/srv/out" },
      secretsSet: [],
      secretsPlaintext: [],
      secretTier: "keychain",
    });
    seed([
      projectPlugin({
        settings: [
          { id: "token", type: "string", label: "Token", required: true, scope: "project" },
          { id: "out", type: "directory", label: "Out", mustExist: true, scope: "project" },
        ],
      }),
    ]);
    render(<ProjectPluginsTab />);
    const group = await screen.findByRole("group", { name: "Needs attention" });
    await waitFor(() => expect(group.textContent).toContain("Token isn't set yet"));
    expect(within(group).getByRole("button", { name: "Set up" })).toBeTruthy();
    expect(within(group).getByRole("alert").textContent).toContain(
      "Couldn't check all of its settings"
    );
    for (const key of ["getRequiredSettingsStatus", "pathExists", "onSettingsChanged"]) {
      delete (pluginApi as Record<string, unknown>)[key];
    }
  });

  it("lists the plugins that need a look on the overview, each with a way to it", async () => {
    seed([
      projectPlugin(),
      projectPlugin({
        id: "acme.fresh",
        instanceId: `project__${PROJECT_ID}__acme.fresh`,
        displayName: "Fresh Plugin",
        dirName: "fresh",
        state: "staged",
      }),
      projectPlugin({
        id: "acme.broken",
        instanceId: `project__${PROJECT_ID}__acme.broken`,
        displayName: "acme.broken",
        dirName: "broken",
        state: "invalid",
        error: "version: must be a valid semver",
      }),
    ]);
    render(<ProjectPluginsTab />);
    await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());

    const group = await screen.findByRole("group", { name: "Needs attention" });
    const labels = [...group.querySelectorAll("[data-settings-row-label]")].map(
      (el) => el.textContent
    );
    expect(labels.sort()).toEqual(["Fresh Plugin", "acme.broken"]);

    const fresh = [...group.querySelectorAll<HTMLElement>("[data-settings-row]")].find((row) =>
      row.textContent?.includes("Fresh Plugin")
    )!;
    fireEvent.click(within(fresh).getByRole("button", { name: "Review" }));
    const pane = await screen.findByTestId("project-plugin-detail");
    expect(within(pane).getByRole("button", { name: "Activate plugin" })).toBeTruthy();
  });
});
