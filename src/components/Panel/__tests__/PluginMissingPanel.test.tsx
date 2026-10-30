// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act, cleanup } from "@testing-library/react";
import type {
  LoadedPluginInfo,
  PluginManifest,
  ProjectPluginInfo,
  ProjectPluginVisibility,
} from "@shared/types/plugin";
import {
  PluginMissingPanel,
  identifyMissingPlugin,
  resolvePluginRecovery,
  type PluginRecovery,
} from "../PluginMissingPanel";
import {
  useProjectPluginStore,
  __resetProjectPluginStoreForTesting,
} from "@/store/projectPluginStore";
import { usePluginManagerStore } from "@/store/pluginManagerStore";

const { placeholderMock, dispatch, logWarn } = vi.hoisted(() => ({
  placeholderMock: vi.fn(),
  dispatch: vi.fn<(actionId: string, args?: unknown, options?: unknown) => Promise<unknown>>(),
  logWarn: vi.fn<(message: string, context?: unknown) => void>(),
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

vi.mock("@/utils/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/logger")>()),
  logWarn,
}));

const PROJECT_ID = "a".repeat(64);
const OTHER_PROJECT_ID = "b".repeat(64);
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

function unrelatedPlugin(): LoadedPluginInfo {
  return installed({
    manifest: {
      name: "other.plugin",
      version: "1.0.0",
      displayName: "Other",
      contributes: EMPTY_CONTRIBUTES,
    },
    instanceId: "other.plugin",
  });
}

/** An installed singleton that happens to share the repository plugin's manifest id. */
function dashboardSingleton(over: Partial<LoadedPluginInfo> = {}): LoadedPluginInfo {
  return installed({
    manifest: {
      name: "acme.dashboard",
      version: "1.0.0",
      displayName: "Dashboard Singleton",
      contributes: EMPTY_CONTRIBUTES,
    },
    instanceId: "acme.dashboard",
    ...over,
  });
}

function dashboardPackage(over: Partial<LoadedPluginInfo> = {}): LoadedPluginInfo {
  return dashboardSingleton({
    manifest: {
      name: "acme.dashboard",
      version: "1.0.0",
      displayName: "Dashboard Package",
      contributes: EMPTY_CONTRIBUTES,
    },
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
  // Unread by default: a spec that needs the list settled says what it holds.
  pluginApi.list.mockReturnValue(new Promise(() => {}));
  pluginApi.onProvenanceChanged.mockReturnValue(unsubscribe);
  dispatch.mockResolvedValue({ ok: true });
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { plugin: pluginApi },
  });
});

afterEach(() => {
  // Unmount first: the panel subscribes to the stores reset below.
  cleanup();
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

function expectProjectSettingsOpened() {
  expect(dispatch).toHaveBeenCalledWith(
    "app.settings.openTab",
    { tab: "project:plugins" },
    { source: "user" }
  );
}

function expectManagerOpened() {
  expect(dispatch).toHaveBeenCalledWith("app.pluginManager", undefined, { source: "user" });
}

describe("PluginMissingPanel", () => {
  it("shows the plugin name from pluginId when provided", () => {
    render(
      <PluginMissingPanel kind="other.vendor.panel" pluginId="my-plugin" onRemove={() => {}} />
    );
    expect(screen.getByText("my-plugin")).toBeDefined();
    expect(screen.queryByText("other.vendor")).toBeNull();
  });

  it("recovers a scoped manifest id from a global kind", () => {
    render(<PluginMissingPanel kind="daintree.github.prs" onRemove={() => {}} />);
    expect(screen.getByText("daintree.github")).toBeDefined();
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
      expectManagerOpened();
      expect(onRemove).not.toHaveBeenCalled();
    });

    it("sends a disabled builtin to the plugin manager too", async () => {
      pluginApi.list.mockResolvedValue([
        installed({ isBuiltin: true, source: "builtin", disabled: true }),
      ]);
      render(
        <PluginMissingPanel kind="acme.tools.board" pluginId="acme.tools" onRemove={vi.fn()} />
      );
      await screen.findByText("Enable this plugin");
      fireEvent.click(screen.getByRole("button", { name: "Open plugin manager" }));
      expectManagerOpened();
    });

    it("asks for an install, not a re-enable, once the plugin is gone", async () => {
      pluginApi.list.mockResolvedValue([unrelatedPlugin()]);
      render(
        <PluginMissingPanel kind="acme.tools.board" pluginId="acme.tools" onRemove={vi.fn()} />
      );

      await screen.findByText("Install this plugin");
      expect(description()).toContain("isn't installed");
      expect(description()).not.toMatch(/enable|turn/i);
      fireEvent.click(screen.getByRole("button", { name: "Open plugin manager" }));
      expectManagerOpened();
    });

    it("says a blocked plugin is blocked rather than asking to enable it", async () => {
      pluginApi.list.mockResolvedValue([installed({ blocklisted: true, disabled: true })]);
      render(
        <PluginMissingPanel kind="acme.tools.board" pluginId="acme.tools" onRemove={vi.fn()} />
      );
      await screen.findByText("See why this plugin is blocked");
      expect(description()).toContain("blocked");
      expect(description()).not.toMatch(/enable/i);
    });

    it("claims nothing about the plugin until the list is read", () => {
      render(
        <PluginMissingPanel kind="acme.tools.board" pluginId="acme.tools" onRemove={vi.fn()} />
      );
      expect(screen.getByText("Check this plugin")).toBeDefined();
      expect(description()).not.toMatch(/installed|turned off|running/);
      expect(actionLabels()).toEqual(["Open plugin manager", "Remove panel"]);
    });

    it("keeps the neutral copy when the list can't be read", async () => {
      pluginApi.list.mockRejectedValue(new Error("ipc down"));
      render(
        <PluginMissingPanel kind="acme.tools.board" pluginId="acme.tools" onRemove={vi.fn()} />
      );
      await waitFor(() => expect(logWarn).toHaveBeenCalledOnce());
      expect(screen.getByText("Check this plugin")).toBeDefined();
    });

    it("keeps what it knew when a later read fails", async () => {
      pluginApi.list.mockResolvedValue([installed({ disabled: true })]);
      render(
        <PluginMissingPanel kind="acme.tools.board" pluginId="acme.tools" onRemove={vi.fn()} />
      );
      await screen.findByText("Enable this plugin");

      pluginApi.list.mockRejectedValue(new Error("ipc down"));
      act(() => pluginApi.onProvenanceChanged.mock.calls[0]![0]());
      await waitFor(() => expect(logWarn).toHaveBeenCalledOnce());
      expect(screen.getByText("Enable this plugin")).toBeDefined();
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
      expectProjectSettingsOpened();
    });

    it("follows the plugin through an uninstall while the placeholder is up", async () => {
      pluginApi.list.mockResolvedValue([installed({ disabled: true })]);
      render(
        <PluginMissingPanel kind="acme.tools.board" pluginId="acme.tools" onRemove={vi.fn()} />
      );
      await screen.findByText("Enable this plugin");

      pluginApi.list.mockResolvedValue([]);
      act(() => pluginApi.onProvenanceChanged.mock.calls[0]![0]());
      await screen.findByText("Install this plugin");
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
      expect(screen.getByText("Install this plugin")).toBeDefined();
    });

    it("ignores a read from an effect that was cleaned up", async () => {
      const discarded = deferred<LoadedPluginInfo[]>();
      const current = deferred<LoadedPluginInfo[]>();
      pluginApi.list.mockReturnValueOnce(discarded.promise).mockReturnValueOnce(current.promise);
      render(
        <StrictMode>
          <PluginMissingPanel kind="acme.tools.board" pluginId="acme.tools" onRemove={vi.fn()} />
        </StrictMode>
      );
      expect(pluginApi.list).toHaveBeenCalledTimes(2);

      await act(async () => current.resolve([]));
      await act(async () => discarded.resolve([installed({ disabled: true })]));
      expect(screen.getByText("Install this plugin")).toBeDefined();
    });

    it("stops listening when it unmounts, and drops a read still in flight", async () => {
      const pending = deferred<LoadedPluginInfo[]>();
      pluginApi.list.mockReturnValue(pending.promise);
      const { unmount } = render(
        <PluginMissingPanel kind="acme.tools.board" pluginId="acme.tools" onRemove={vi.fn()} />
      );
      expect(unsubscribe).not.toHaveBeenCalled();
      unmount();
      expect(unsubscribe).toHaveBeenCalledOnce();

      await act(async () => pending.reject(new Error("view closed")));
      expect(logWarn).not.toHaveBeenCalled();
    });

    it("says nothing about a failed read a newer one already answered", async () => {
      const stale = deferred<LoadedPluginInfo[]>();
      const newest = deferred<LoadedPluginInfo[]>();
      pluginApi.list.mockReturnValueOnce(stale.promise).mockReturnValueOnce(newest.promise);
      render(
        <PluginMissingPanel kind="acme.tools.board" pluginId="acme.tools" onRemove={vi.fn()} />
      );

      act(() => pluginApi.onProvenanceChanged.mock.calls[0]![0]());
      await act(async () => newest.resolve([installed({ disabled: true })]));
      await act(async () => stale.reject(new Error("superseded")));
      expect(logWarn).not.toHaveBeenCalled();
      expect(screen.getByText("Enable this plugin")).toBeDefined();
    });
  });

  describe("a repository plugin", () => {
    it("keeps a restored panel on Project settings until this project's plugins arrive", async () => {
      pluginApi.list.mockResolvedValue([]);
      render(
        <PluginMissingPanel kind={PROJECT_KIND} pluginId="acme.dashboard" onRemove={vi.fn()} />
      );
      await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());
      await act(async () => {});
      expect(screen.getByRole("button", { name: "Open project settings" })).toBeDefined();

      act(() => useProjectPluginStore.setState({ projectId: PROJECT_ID, plugins: [repoPlugin()] }));
      expect(screen.getByText("Turn on this plugin")).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "Open project settings" }));
      expect(usePluginManagerStore.getState().settingsRequest?.pluginId).toBe(REPO_INSTANCE);
    });

    it("sends a plugin switched off here to Project settings though no list carries it", async () => {
      pluginApi.list.mockResolvedValue([]);
      useProjectPluginStore.setState({ projectId: PROJECT_ID, plugins: [repoPlugin()] });
      const onRemove = vi.fn();
      render(
        <PluginMissingPanel kind={PROJECT_KIND} pluginId={REPO_INSTANCE} onRemove={onRemove} />
      );

      await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());
      expect(screen.getByText("Turn on this plugin")).toBeDefined();
      expect(screen.getByText("Acme Dashboard")).toBeDefined();
      expect(description()).toContain("turned off in this project");
      expect(actionLabels()).toEqual(["Open project settings", "Remove panel"]);

      fireEvent.click(screen.getByRole("button", { name: "Open project settings" }));
      expect(usePluginManagerStore.getState().settingsRequest).toMatchObject({
        pluginId: REPO_INSTANCE,
        home: "project",
      });
      expectProjectSettingsOpened();
      expect(onRemove).not.toHaveBeenCalled();
    });

    it("finds a restored panel's plugin from its bare manifest id", () => {
      useProjectPluginStore.setState({ projectId: PROJECT_ID, plugins: [repoPlugin()] });
      render(
        <PluginMissingPanel kind={PROJECT_KIND} pluginId="acme.dashboard" onRemove={vi.fn()} />
      );
      expect(screen.getByText("Turn on this plugin")).toBeDefined();
      expect(screen.getByText("Acme Dashboard")).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "Open project settings" }));
      expect(usePluginManagerStore.getState().settingsRequest?.pluginId).toBe(REPO_INSTANCE);
    });

    it("isn't confused with an installed plugin of the same name", async () => {
      pluginApi.list.mockResolvedValue([dashboardSingleton({ disabled: true })]);
      useProjectPluginStore.setState({ projectId: PROJECT_ID, plugins: [repoPlugin()] });
      render(
        <PluginMissingPanel kind={PROJECT_KIND} pluginId={REPO_INSTANCE} onRemove={vi.fn()} />
      );
      await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());
      await act(async () => {});

      expect(screen.getByText("Acme Dashboard")).toBeDefined();
      expect(screen.queryByRole("button", { name: "Open plugin manager" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Open project settings" }));
      expect(usePluginManagerStore.getState().settingsRequest?.pluginId).toBe(REPO_INSTANCE);
    });

    it("opens Project settings without a selection when the plugin isn't listed", async () => {
      pluginApi.list.mockResolvedValue([]);
      render(
        <PluginMissingPanel kind={PROJECT_KIND} pluginId={REPO_INSTANCE} onRemove={vi.fn()} />
      );
      await waitFor(() => expect(pluginApi.list).toHaveBeenCalled());
      await act(async () => {});
      expect(screen.getByText("Check this plugin")).toBeDefined();
      expect(description()).not.toMatch(/enable|turned off|installed/i);

      fireEvent.click(screen.getByRole("button", { name: "Open project settings" }));
      expect(usePluginManagerStore.getState().settingsRequest).toBeNull();
      expectProjectSettingsOpened();
    });
  });

  describe("an installed per-project package", () => {
    it("sends an instance switched off here to Project settings", async () => {
      pluginApi.list.mockResolvedValue([dashboardPackage()]);
      render(
        <PluginMissingPanel kind={PROJECT_KIND} pluginId={PACKAGE_INSTANCE} onRemove={vi.fn()} />
      );
      await screen.findByText("Dashboard Package");
      expect(screen.getByText("Turn on this plugin")).toBeDefined();

      fireEvent.click(screen.getByRole("button", { name: "Open project settings" }));
      expect(usePluginManagerStore.getState().settingsRequest).toMatchObject({
        pluginId: "acme.dashboard",
        home: "project",
      });
      expectProjectSettingsOpened();
    });

    it("sends a package disabled everywhere to the plugin manager first", async () => {
      pluginApi.list.mockResolvedValue([dashboardPackage({ disabled: true })]);
      render(
        <PluginMissingPanel kind={PROJECT_KIND} pluginId={PACKAGE_INSTANCE} onRemove={vi.fn()} />
      );
      await screen.findByText("Enable this plugin");
      expect(description()).not.toContain("in this project");
      fireEvent.click(screen.getByRole("button", { name: "Open plugin manager" }));
      expectManagerOpened();
    });

    it("asks for an install once the package is gone", async () => {
      pluginApi.list.mockResolvedValue([]);
      useProjectPluginStore.setState({ projectId: PROJECT_ID, plugins: [repoPlugin()] });
      render(
        <PluginMissingPanel kind={PROJECT_KIND} pluginId={PACKAGE_INSTANCE} onRemove={vi.fn()} />
      );
      await screen.findByText("Install this plugin");
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
      expect(screen.queryByRole("region", { name: "Plugin unavailable" })).toBeNull();
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
      render(<PluginMissingPanel kind="other.vendor.panel" pluginId="plug" onRemove={() => {}} />);
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

describe("resolvePluginRecovery", () => {
  const VISIBLE: ProjectPluginVisibility = { defaultHiddenPluginIds: [], overrides: {} };
  const globalTools = identifyMissingPlugin("acme.tools.board", "acme.tools");
  const liveRepo = identifyMissingPlugin(PROJECT_KIND, REPO_INSTANCE);
  const livePackage = identifyMissingPlugin(PROJECT_KIND, PACKAGE_INSTANCE);
  const restored = identifyMissingPlugin(PROJECT_KIND, "acme.dashboard");

  function outcome(recovery: PluginRecovery) {
    return { home: recovery.home, state: recovery.state, target: recovery.settingsTarget };
  }

  it.each<{
    name: string;
    identity: ReturnType<typeof identifyMissingPlugin>;
    inventory: LoadedPluginInfo[] | null;
    repository?: ProjectPluginInfo[];
    /** The project the repository snapshot describes; `null` before one arrived. */
    repositoryProjectId?: string | null;
    visibility?: ProjectPluginVisibility;
    expected: ReturnType<typeof outcome>;
  }>([
    {
      name: "a blocklisted plugin is blocked before it is off",
      identity: globalTools,
      inventory: [installed({ blocklisted: true, disabled: true })],
      expected: { home: "manager", state: "blocked", target: null },
    },
    {
      name: "a disabled plugin is off before it is hidden",
      identity: globalTools,
      inventory: [installed({ disabled: true })],
      visibility: { defaultHiddenPluginIds: ["acme.tools"], overrides: {} },
      expected: { home: "manager", state: "off", target: null },
    },
    {
      name: "this project's explicit show beats the hidden-by-default list",
      identity: globalTools,
      inventory: [installed()],
      visibility: { defaultHiddenPluginIds: ["acme.tools"], overrides: { "acme.tools": true } },
      expected: { home: "manager", state: "unknown", target: null },
    },
    {
      name: "this project's explicit hide beats the visible default",
      identity: globalTools,
      inventory: [installed()],
      visibility: { defaultHiddenPluginIds: [], overrides: { "acme.tools": false } },
      expected: { home: "project", state: "hidden", target: "acme.tools" },
    },
    {
      name: "a plugin that is on and shown is only unexplained",
      identity: globalTools,
      inventory: [installed()],
      expected: { home: "manager", state: "unknown", target: null },
    },
    {
      name: "a project-origin row of the same name is no installed plugin",
      identity: globalTools,
      inventory: [
        installed({ instanceId: `project__${PROJECT_ID}__acme.tools`, origin: "project" }),
      ],
      expected: { home: "manager", state: "missing", target: null },
    },
    {
      name: "a running repository plugin is unexplained, not off",
      identity: liveRepo,
      inventory: [],
      repository: [repoPlugin({ state: "active", muted: false })],
      expected: { home: "project", state: "unknown", target: REPO_INSTANCE },
    },
    {
      name: "a staged repository plugin needs activating, not turning on",
      identity: liveRepo,
      inventory: [],
      repository: [repoPlugin({ state: "staged", muted: false })],
      expected: { home: "project", state: "unknown", target: REPO_INSTANCE },
    },
    {
      name: "an untrusted folder's plugin isn't off by its own switch",
      identity: liveRepo,
      inventory: [],
      repository: [repoPlugin({ state: "blocked", muted: false })],
      expected: { home: "project", state: "unknown", target: REPO_INSTANCE },
    },
    {
      name: "an unreadable manifest in a folder named for the plugin offers no selection",
      identity: restored,
      inventory: [],
      repository: [repoPlugin({ state: "invalid", muted: false, instanceId: undefined })],
      expected: { home: "project", state: "unknown", target: null },
    },
    {
      name: "another project's repository row is not this panel's plugin",
      identity: liveRepo,
      inventory: [],
      repository: [repoPlugin({ projectId: OTHER_PROJECT_ID })],
      expected: { home: "project", state: "unknown", target: null },
    },
    {
      name: "a repository panel never adopts a package of the same name",
      identity: liveRepo,
      inventory: [dashboardPackage({ disabled: true })],
      expected: { home: "project", state: "unknown", target: null },
    },
    {
      name: "a restored panel never adopts an installed singleton of the same name",
      identity: restored,
      inventory: [dashboardSingleton({ disabled: true })],
      expected: { home: "manager", state: "unknown", target: null },
    },
    {
      name: "a blocklisted package is blocked",
      identity: livePackage,
      inventory: [dashboardPackage({ blocklisted: true })],
      expected: { home: "manager", state: "blocked", target: null },
    },
    {
      name: "a package on in this project is only unexplained",
      identity: livePackage,
      inventory: [dashboardPackage({ enabledInProjects: [PROJECT_ID] })],
      expected: { home: "project", state: "unknown", target: "acme.dashboard" },
    },
    {
      name: "a restored package panel finds its package",
      identity: restored,
      inventory: [dashboardPackage()],
      expected: { home: "project", state: "off", target: "acme.dashboard" },
    },
    {
      name: "a restored panel neither list carries goes where a package comes back from",
      identity: restored,
      inventory: [],
      expected: { home: "manager", state: "unknown", target: null },
    },
    {
      name: "a restored panel waits for this project's own plugins before leaving Project settings",
      identity: restored,
      inventory: [],
      repositoryProjectId: null,
      expected: { home: "project", state: "unknown", target: null },
    },
    {
      name: "a restored panel stays with Project settings while a manifest there is unreadable",
      identity: restored,
      inventory: [],
      repository: [
        repoPlugin({
          id: "dashboard",
          dirName: "dashboard",
          instanceId: undefined,
          state: "invalid",
          muted: false,
        }),
      ],
      expected: { home: "project", state: "unknown", target: null },
    },
    {
      name: "another project's snapshot says nothing about this panel's project",
      identity: restored,
      inventory: [],
      repositoryProjectId: OTHER_PROJECT_ID,
      expected: { home: "project", state: "unknown", target: null },
    },
    {
      name: "a restored panel claims nothing before the list is read",
      identity: restored,
      inventory: null,
      expected: { home: "project", state: "unknown", target: null },
    },
    {
      name: "a live package panel claims nothing before the list is read",
      identity: livePackage,
      inventory: null,
      expected: { home: "project", state: "unknown", target: null },
    },
  ])(
    "$name",
    ({
      identity,
      inventory,
      repository = [],
      repositoryProjectId = PROJECT_ID,
      visibility = VISIBLE,
      expected,
    }) => {
      const recovery = resolvePluginRecovery(
        identity,
        inventory,
        { projectId: repositoryProjectId, plugins: repository },
        visibility
      );
      expect(outcome(recovery)).toEqual(expected);
    }
  );
});
