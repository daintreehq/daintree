// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { LoadedPluginInfo, PluginManifest, ProjectPluginInfo } from "@shared/types/plugin";
import { PluginMissingPanel } from "../PluginMissingPanel";
import {
  useProjectPluginStore,
  __resetProjectPluginStoreForTesting,
} from "@/store/projectPluginStore";
import { usePluginManagerStore } from "@/store/pluginManagerStore";

const { placeholderMock, dispatch } = vi.hoisted(() => ({
  placeholderMock: vi.fn(),
  dispatch: vi.fn<(actionId: string, args?: unknown, options?: unknown) => Promise<unknown>>(),
}));

vi.mock("@/components/Plugin/PluginNotOnHostPlaceholder", () => ({
  PluginNotOnHostPlaceholder: (props: {
    pluginId: string;
    kind?: string;
    onRemove?: () => void;
  }) => {
    placeholderMock(props);
    return (
      <div data-testid="plugin-not-on-host">
        <button type="button" onClick={props.onRemove}>
          remove {props.pluginId}
        </button>
      </div>
    );
  },
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch },
}));

const PROJECT_ID = "a".repeat(64);
const REPO_INSTANCE = `project__${PROJECT_ID}__acme.dashboard`;
const PACKAGE_INSTANCE = `project__${PROJECT_ID}__installed__acme.dashboard`;
const PROJECT_KIND = `project:${PROJECT_ID}/acme.dashboard/overview`;

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

function dashboardPackage(over: Partial<LoadedPluginInfo> = {}): LoadedPluginInfo {
  return installed({
    manifest: {
      name: "acme.dashboard",
      version: "1.0.0",
      displayName: "Dashboard Package",
      contributes: EMPTY_CONTRIBUTES,
    },
    instanceId: "acme.dashboard",
    instanceMode: "project",
    enabledInProjects: [],
    ...over,
  });
}

function repoPlugin(over: Partial<ProjectPluginInfo> = {}): ProjectPluginInfo {
  return {
    projectId: PROJECT_ID,
    id: "acme.dashboard",
    instanceId: REPO_INSTANCE,
    displayName: "Acme Dashboard",
    version: "1.2.0",
    capabilities: [],
    dirName: "dashboard",
    state: "blocked",
    muted: true,
    collidesWithGlobal: false,
    ...over,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const pluginApi = {
  list: vi.fn<() => Promise<LoadedPluginInfo[]>>(),
  onProvenanceChanged: vi.fn<(callback: () => void) => () => void>(),
};
const unsubscribe = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  pluginApi.list.mockResolvedValue([]);
  pluginApi.onProvenanceChanged.mockReturnValue(unsubscribe);
  dispatch.mockResolvedValue({ ok: true });
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { plugin: pluginApi },
  });
});

afterEach(() => {
  delete (window as { __DAINTREE_HOST_ID__?: unknown }).__DAINTREE_HOST_ID__;
  placeholderMock.mockClear();
  __resetProjectPluginStoreForTesting();
  usePluginManagerStore.setState({ settingsRequest: null, isOpen: false });
});

function actionLabels(): string[] {
  return screen.getAllByRole("button").map((button) => button.textContent ?? "");
}

function description(): string {
  return screen.getByRole("region", { name: "Plugin unavailable" }).textContent ?? "";
}

describe("PluginMissingPanel", () => {
  it("shows the plugin name from pluginId when provided", () => {
    render(
      <PluginMissingPanel kind="my-plugin.custom-panel" pluginId="my-plugin" onRemove={() => {}} />
    );
    expect(screen.getByText("my-plugin")).toBeDefined();
  });

  it("recovers the manifest id from a project-qualified kind", () => {
    render(
      <PluginMissingPanel kind="project:project-7/acme.dashboard/overview" onRemove={() => {}} />
    );
    expect(screen.getByText("acme.dashboard")).toBeDefined();
  });

  it("names a live project panel by its manifest id, not its instance key", () => {
    render(<PluginMissingPanel kind={PROJECT_KIND} pluginId={REPO_INSTANCE} onRemove={() => {}} />);
    expect(screen.getByText("acme.dashboard")).toBeDefined();
    expect(description()).not.toContain(PROJECT_ID);
  });

  it("falls back to the full kind string when there is no dot", () => {
    render(<PluginMissingPanel kind="singleword" onRemove={() => {}} />);
    expect(screen.getByText("singleword")).toBeDefined();
  });

  it("invokes onRemove when the Remove panel button is clicked", () => {
    const onRemove = vi.fn();
    render(<PluginMissingPanel kind="plug.panel" pluginId="plug" onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove panel" }));
    expect(onRemove).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("is composed from the EmptyState and Button primitives", () => {
    const { container } = render(
      <PluginMissingPanel kind="plug.panel" pluginId="plug" onRemove={() => {}} />
    );
    expect(container.querySelector("[data-empty-state-icon]")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Remove panel" }).getAttribute("data-variant")
    ).not.toBeNull();
  });

  it("scrolls rather than clips when the pane is shorter than the explanation", () => {
    render(<PluginMissingPanel kind="plug.panel" pluginId="plug" onRemove={() => {}} />);
    const region = screen.getByRole("region", { name: "Plugin unavailable" });
    expect(region.className).toMatch(/overflow-y-auto/);
  });

  describe("an installed plugin", () => {
    it("leads with the plugin manager for a disabled plugin, Remove panel second", async () => {
      pluginApi.list.mockResolvedValue([installed({ disabled: true })]);
      const onRemove = vi.fn();
      render(
        <PluginMissingPanel kind="acme.tools.board" pluginId="acme.tools" onRemove={onRemove} />
      );

      await screen.findByText("Enable this plugin");
      expect(screen.getByText("Acme Tools")).toBeDefined();
      expect(description()).toContain("turned off");
      expect(actionLabels()).toEqual(["Open plugin manager", "Remove panel"]);

      fireEvent.click(screen.getByRole("button", { name: "Open plugin manager" }));
      expect(dispatch).toHaveBeenCalledWith("app.pluginManager", undefined, { source: "user" });
      expect(onRemove).not.toHaveBeenCalled();
    });

    it("treats a disabled builtin the same way", async () => {
      pluginApi.list.mockResolvedValue([
        installed({ isBuiltin: true, source: "builtin", disabled: true }),
      ]);
      render(
        <PluginMissingPanel kind="acme.tools.board" pluginId="acme.tools" onRemove={vi.fn()} />
      );
      await screen.findByText("Enable this plugin");
    });

    it("offers a reinstall, not a re-enable, once the plugin is gone", async () => {
      pluginApi.list.mockResolvedValue([installed({ instanceId: "other.plugin" })]);
      render(
        <PluginMissingPanel kind="acme.tools.board" pluginId="acme.tools" onRemove={vi.fn()} />
      );

      await screen.findByText("Reinstall this plugin");
      expect(description()).toContain("isn't installed anymore");
      expect(description()).not.toMatch(/enable/i);
      fireEvent.click(screen.getByRole("button", { name: "Open plugin manager" }));
      expect(dispatch).toHaveBeenCalledWith("app.pluginManager", undefined, { source: "user" });
    });

    it("says a blocked plugin is blocked rather than asking to enable it", async () => {
      pluginApi.list.mockResolvedValue([installed({ blocklisted: true })]);
      render(
        <PluginMissingPanel kind="acme.tools.board" pluginId="acme.tools" onRemove={vi.fn()} />
      );
      await screen.findByText("Plugin blocked");
      expect(screen.getByRole("button", { name: "Open plugin manager" })).toBeDefined();
    });

    it("claims nothing about the plugin until the list is read", () => {
      pluginApi.list.mockReturnValue(new Promise(() => {}));
      render(
        <PluginMissingPanel kind="acme.tools.board" pluginId="acme.tools" onRemove={vi.fn()} />
      );
      expect(screen.getByText("Plugin unavailable")).toBeDefined();
      expect(description()).not.toContain("installed");
      expect(actionLabels()).toEqual(["Open plugin manager", "Remove panel"]);
    });

    it("keeps the neutral copy when the list can't be read", async () => {
      pluginApi.list.mockRejectedValue(new Error("ipc down"));
      render(
        <PluginMissingPanel kind="acme.tools.board" pluginId="acme.tools" onRemove={vi.fn()} />
      );
      await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());
      await act(async () => {});
      expect(screen.getByText("Plugin unavailable")).toBeDefined();
      expect(description()).not.toContain("installed");
    });

    it("sends a plugin hidden in this project to Project settings, selecting it there", async () => {
      pluginApi.list.mockResolvedValue([installed()]);
      useProjectPluginStore.setState({
        visibility: { defaultHiddenPluginIds: ["acme.tools"], overrides: {} },
      });
      render(
        <PluginMissingPanel kind="acme.tools.board" pluginId="acme.tools" onRemove={vi.fn()} />
      );

      await screen.findByText("Show this plugin in this project");
      fireEvent.click(screen.getByRole("button", { name: "Open project settings" }));
      expect(usePluginManagerStore.getState().settingsRequest).toMatchObject({
        pluginId: "acme.tools",
        home: "project",
      });
      expect(dispatch).toHaveBeenCalledWith(
        "app.settings.openTab",
        { tab: "project:plugins" },
        { source: "user" }
      );
    });

    it("lets this project's explicit answer beat the hidden-by-default list", async () => {
      pluginApi.list.mockResolvedValue([installed()]);
      useProjectPluginStore.setState({
        visibility: { defaultHiddenPluginIds: ["acme.tools"], overrides: { "acme.tools": true } },
      });
      render(
        <PluginMissingPanel kind="acme.tools.board" pluginId="acme.tools" onRemove={vi.fn()} />
      );
      await screen.findByText("Acme Tools");
      expect(screen.queryByText("Show this plugin in this project")).toBeNull();
      expect(screen.getByRole("button", { name: "Open plugin manager" })).toBeDefined();
    });

    it("follows the plugin through an uninstall while the placeholder is up", async () => {
      pluginApi.list.mockResolvedValue([installed({ disabled: true })]);
      render(
        <PluginMissingPanel kind="acme.tools.board" pluginId="acme.tools" onRemove={vi.fn()} />
      );
      await screen.findByText("Enable this plugin");

      pluginApi.list.mockResolvedValue([]);
      const onChanged = pluginApi.onProvenanceChanged.mock.calls[0]![0];
      act(() => onChanged());
      await screen.findByText("Reinstall this plugin");
    });

    it("keeps the newest read when an older one answers last", async () => {
      const first = deferred<LoadedPluginInfo[]>();
      const second = deferred<LoadedPluginInfo[]>();
      pluginApi.list.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      render(
        <PluginMissingPanel kind="acme.tools.board" pluginId="acme.tools" onRemove={vi.fn()} />
      );

      act(() => pluginApi.onProvenanceChanged.mock.calls[0]![0]());
      await act(async () => second.resolve([]));
      await act(async () => first.resolve([installed({ disabled: true })]));
      expect(screen.getByText("Reinstall this plugin")).toBeDefined();
    });

    it("stops listening when it unmounts", () => {
      const { unmount } = render(
        <PluginMissingPanel kind="acme.tools.board" pluginId="acme.tools" onRemove={vi.fn()} />
      );
      expect(unsubscribe).not.toHaveBeenCalled();
      unmount();
      expect(unsubscribe).toHaveBeenCalledOnce();
    });
  });

  describe("a repository plugin", () => {
    it("sends a plugin switched off here to Project settings though no list carries it", async () => {
      useProjectPluginStore.setState({ projectId: PROJECT_ID, plugins: [repoPlugin()] });
      const onRemove = vi.fn();
      render(
        <PluginMissingPanel kind={PROJECT_KIND} pluginId={REPO_INSTANCE} onRemove={onRemove} />
      );

      await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());
      expect(screen.getByText("Enable this plugin")).toBeDefined();
      expect(screen.getByText("Acme Dashboard")).toBeDefined();
      expect(description()).toContain("turned off in this project");
      expect(actionLabels()).toEqual(["Open project settings", "Remove panel"]);

      fireEvent.click(screen.getByRole("button", { name: "Open project settings" }));
      expect(usePluginManagerStore.getState().settingsRequest).toMatchObject({
        pluginId: REPO_INSTANCE,
        home: "project",
      });
      expect(dispatch).toHaveBeenCalledWith(
        "app.settings.openTab",
        { tab: "project:plugins" },
        { source: "user" }
      );
      expect(onRemove).not.toHaveBeenCalled();
    });

    it("finds a restored panel's plugin from its bare manifest id", () => {
      useProjectPluginStore.setState({ projectId: PROJECT_ID, plugins: [repoPlugin()] });
      render(
        <PluginMissingPanel kind={PROJECT_KIND} pluginId="acme.dashboard" onRemove={vi.fn()} />
      );
      expect(screen.getByText("Enable this plugin")).toBeDefined();
    });

    it("isn't confused with an installed plugin of the same name", async () => {
      pluginApi.list.mockResolvedValue([
        dashboardPackage({ instanceMode: undefined, enabledInProjects: undefined, disabled: true }),
      ]);
      useProjectPluginStore.setState({ projectId: PROJECT_ID, plugins: [repoPlugin()] });
      render(
        <PluginMissingPanel kind={PROJECT_KIND} pluginId={REPO_INSTANCE} onRemove={vi.fn()} />
      );
      await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());
      await act(async () => {});
      expect(screen.getByRole("button", { name: "Open project settings" })).toBeDefined();
      expect(screen.queryByRole("button", { name: "Open plugin manager" })).toBeNull();
    });

    it("opens Project settings without a selection when the plugin isn't listed", async () => {
      render(
        <PluginMissingPanel kind={PROJECT_KIND} pluginId={REPO_INSTANCE} onRemove={vi.fn()} />
      );
      await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());
      await act(async () => {});
      expect(screen.getByText("Plugin unavailable")).toBeDefined();
      expect(description()).not.toMatch(/enable|turned off/i);

      fireEvent.click(screen.getByRole("button", { name: "Open project settings" }));
      expect(usePluginManagerStore.getState().settingsRequest).toBeNull();
      expect(dispatch).toHaveBeenCalledWith(
        "app.settings.openTab",
        { tab: "project:plugins" },
        { source: "user" }
      );
    });
  });

  describe("an installed per-project package", () => {
    it("sends an instance switched off here to Project settings", async () => {
      pluginApi.list.mockResolvedValue([dashboardPackage()]);
      render(
        <PluginMissingPanel kind={PROJECT_KIND} pluginId={PACKAGE_INSTANCE} onRemove={vi.fn()} />
      );
      await screen.findByText("Dashboard Package");
      expect(description()).toContain("turned off in this project");

      fireEvent.click(screen.getByRole("button", { name: "Open project settings" }));
      expect(usePluginManagerStore.getState().settingsRequest).toMatchObject({
        pluginId: "acme.dashboard",
        home: "project",
      });
    });

    it("sends a package disabled everywhere to the plugin manager first", async () => {
      pluginApi.list.mockResolvedValue([
        dashboardPackage({ disabled: true, enabledInProjects: [PROJECT_ID] }),
      ]);
      render(
        <PluginMissingPanel kind={PROJECT_KIND} pluginId={PACKAGE_INSTANCE} onRemove={vi.fn()} />
      );
      await screen.findByText("Enable this plugin");
      expect(description()).not.toContain("in this project");
      expect(screen.getByRole("button", { name: "Open plugin manager" })).toBeDefined();
    });

    it("offers a reinstall once the package is gone", async () => {
      useProjectPluginStore.setState({ projectId: PROJECT_ID, plugins: [repoPlugin()] });
      render(
        <PluginMissingPanel kind={PROJECT_KIND} pluginId={PACKAGE_INSTANCE} onRemove={vi.fn()} />
      );
      await screen.findByText("Reinstall this plugin");
      expect(screen.getByRole("button", { name: "Open plugin manager" })).toBeDefined();
    });
  });

  describe("in a window attached to another machine", () => {
    it("offers the host placeholder instead, naming the plugin recovered from the kind", () => {
      window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
      const onRemove = vi.fn();
      render(
        <PluginMissingPanel kind="project:project-7/acme.dashboard/overview" onRemove={onRemove} />
      );
      expect(screen.queryByText("Plugin unavailable")).toBeNull();
      expect(placeholderMock).toHaveBeenCalledWith({
        pluginId: "acme.dashboard",
        kind: "project:project-7/acme.dashboard/overview",
        onRemove,
      });
      fireEvent.click(screen.getByRole("button", { name: "remove acme.dashboard" }));
      expect(onRemove).toHaveBeenCalledOnce();
    });

    it("prefers the explicit plugin id", () => {
      window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
      render(<PluginMissingPanel kind="plug.panel" pluginId="plug" onRemove={() => {}} />);
      expect(placeholderMock.mock.calls[0]![0]).toMatchObject({ pluginId: "plug" });
    });

    it("reads nothing about this machine's plugins", () => {
      window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
      render(<PluginMissingPanel kind="plug.panel" pluginId="plug" onRemove={() => {}} />);
      expect(pluginApi.list).not.toHaveBeenCalled();
      expect(pluginApi.onProvenanceChanged).not.toHaveBeenCalled();
    });

    it("keeps the local placeholder for a window on this machine", () => {
      window.__DAINTREE_HOST_ID__ = { id: "local" };
      render(<PluginMissingPanel kind="plug.panel" pluginId="plug" onRemove={() => {}} />);
      expect(screen.getByRole("region", { name: "Plugin unavailable" })).toBeDefined();
      expect(placeholderMock).not.toHaveBeenCalled();
    });
  });
});
