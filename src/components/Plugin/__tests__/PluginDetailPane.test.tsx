// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { PluginDetailPane } from "../PluginDetailPane";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  BUILT_IN_PLUGIN_CAPABILITIES,
  type BuiltInPluginCapability,
  type LoadedPluginInfo,
} from "@shared/types/plugin";

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

const openExternalMock = vi.hoisted(() => vi.fn());
vi.mock("@/clients/systemClient", () => ({
  systemClient: { openExternal: openExternalMock },
}));

// PluginSettingsForm reads the active project via this selector.
vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: { currentProject: { id: string } | null }) => unknown) =>
    selector({ currentProject: null }),
}));

// PluginMcpServersSection polls this on mount when its tab is active.
const pluginMcpListMock = vi.hoisted(() => vi.fn(() => Promise.resolve([])));
beforeEach(() => {
  pluginMcpListMock.mockClear();
  (globalThis as unknown as { window: Window }).window.electron = {
    pluginMcp: {
      list: pluginMcpListMock,
      getStderr: vi.fn(() =>
        Promise.resolve({ pluginId: "", serverId: "", lines: [], totalLines: 0 })
      ),
      restart: vi.fn(() => Promise.resolve()),
    },
    // PluginSettingsForm hydrates from these the moment a Settings tab renders.
    plugin: {
      getSettingValues: vi.fn(() => Promise.resolve({})),
      setSettingValue: vi.fn(() => Promise.resolve()),
      deleteSettingValue: vi.fn(() => Promise.resolve()),
      revealSecretSetting: vi.fn(() => Promise.resolve(null)),
      pathExists: vi.fn(() => Promise.resolve(true)),
    },
  } as unknown as Window["electron"];
});

function makePlugin(overrides: Partial<LoadedPluginInfo> = {}): LoadedPluginInfo {
  return {
    manifest: {
      name: "acme.demo",
      version: "1.0.0",
      displayName: "Acme Demo",
      contributes: {
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
      },
    },
    dir: "/plugins/acme.demo",
    loadedAt: 1,
    isBuiltin: false,
    disabled: false,
    pendingRestart: false,
    source: "sideload",
    installedAt: 1,
    archiveHash: null,
    originalUrl: null,
    loadError: null,
    updateAvailable: null,
    devMode: false,
    pluginDanger: "safe",
    blocklisted: false,
    ...overrides,
  };
}

function withCapabilities(
  caps: BuiltInPluginCapability[],
  overrides: Partial<LoadedPluginInfo> = {}
): LoadedPluginInfo {
  const base = makePlugin(overrides);
  return {
    ...base,
    manifest: { ...base.manifest, capabilities: caps, ...overrides.manifest },
  };
}

// Capabilities now live behind the "Permissions" subtab in the graduated
// tabbed detail pane (#9558); activate it so the permission rows render.
function renderPane(plugin: LoadedPluginInfo) {
  const result = render(
    <TooltipProvider>
      <PluginDetailPane
        plugin={plugin}
        checkingUpdate={false}
        upToDate={false}
        onUninstall={vi.fn()}
        onCheckForUpdate={vi.fn()}
      />
    </TooltipProvider>
  );
  fireEvent.click(screen.getByRole("tab", { name: "Permissions" }));
  return result;
}

// Overview is the default tab, so no subtab click is needed.
function renderOverview(plugin: LoadedPluginInfo) {
  return render(
    <TooltipProvider>
      <PluginDetailPane
        plugin={plugin}
        checkingUpdate={false}
        upToDate={false}
        onUninstall={vi.fn()}
        onCheckForUpdate={vi.fn()}
      />
    </TooltipProvider>
  );
}

function withAuthors(
  authors: NonNullable<LoadedPluginInfo["manifest"]["authors"]>
): LoadedPluginInfo {
  const base = makePlugin();
  return { ...base, manifest: { ...base.manifest, authors } };
}

describe("PluginDetailPane capabilities", () => {
  it("renders a labelled row for each declared capability", () => {
    renderPane(withCapabilities(["fs:project-read", "shell:exec"]));
    expect(screen.getByText("Read project files")).toBeTruthy();
    expect(screen.getByText("Run shell commands")).toBeTruthy();
  });

  it("does not show the danger summary banner when pluginDanger is safe", () => {
    renderPane(withCapabilities(["fs:project-read"], { pluginDanger: "safe" }));
    expect(screen.queryByText(/Requests sensitive permissions/)).toBeNull();
  });

  it("shows the danger summary banner when pluginDanger is confirm", () => {
    renderPane(withCapabilities(["shell:exec"], { pluginDanger: "confirm" }));
    expect(screen.getByText(/Requests sensitive permissions/)).toBeTruthy();
  });

  it("lists the network allowlist under the network:fetch row when scoped", () => {
    const plugin = withCapabilities(["network:fetch"], {
      pluginDanger: "safe",
      manifest: {
        ...makePlugin().manifest,
        capabilities: ["network:fetch"],
        scopes: { network: { allowedUrls: ["https://api.example.com/v1"] } },
      },
    });
    renderPane(plugin);
    expect(screen.getByText("https://api.example.com/v1")).toBeTruthy();
  });

  it("renders a label for every built-in capability when all are declared", () => {
    renderPane(withCapabilities([...BUILT_IN_PLUGIN_CAPABILITIES]));
    // One representative label per family, covering all three severity tiers.
    for (const label of [
      "Read project files",
      "Write project files",
      "Make network requests",
      "Launch agents",
      "Register agent CLIs",
      "Run git commands",
      "Read clipboard",
      "Run shell commands",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("renders capabilities in BUILT_IN_PLUGIN_CAPABILITIES order, not manifest order", () => {
    // Declared shell:exec first, but fs:project-read sorts earlier in the canon.
    renderPane(withCapabilities(["shell:exec", "fs:project-read"]));
    const list = screen.getByText("Read project files").closest("ul");
    expect(list).toBeTruthy();
    if (!list) return;
    const labels = within(list)
      .getAllByText(/Read project files|Run shell commands/)
      .map((el) => el.textContent);
    expect(labels[0]).toBe("Read project files");
    expect(labels[1]).toBe("Run shell commands");
  });
});

describe("PluginDetailPane contributors (issue #10516)", () => {
  it("does not render a Contributors section when authors are absent", () => {
    renderOverview(makePlugin());
    expect(screen.queryByText("Contributors")).toBeNull();
  });

  it("does not render a Contributors section when authors is empty", () => {
    renderOverview(withAuthors([]));
    expect(screen.queryByText("Contributors")).toBeNull();
  });

  it("renders each author's name, with the role attached to the right author", () => {
    renderOverview(withAuthors([{ name: "Alice", role: "Maintainer" }, { name: "Bob" }]));
    expect(screen.getByText("Contributors")).toBeTruthy();
    expect(screen.getByText("Bob")).toBeTruthy();
    // Role must sit within Alice's list item, not Bob's.
    const aliceItem = screen.getByText("Alice").closest("li");
    expect(aliceItem).toBeTruthy();
    if (aliceItem) {
      expect(within(aliceItem).getByText(/Maintainer/)).toBeTruthy();
    }
    const bobItem = screen.getByText("Bob").closest("li");
    if (bobItem) {
      expect(within(bobItem).queryByText(/Maintainer/)).toBeNull();
    }
  });

  it("renders no contact buttons for a name-only author", () => {
    renderOverview(withAuthors([{ name: "Alice" }]));
    const aliceItem = screen.getByText("Alice").closest("li");
    expect(aliceItem).toBeTruthy();
    if (aliceItem) {
      expect(within(aliceItem).queryAllByRole("button")).toHaveLength(0);
    }
  });

  it("opens an author url through systemClient.openExternal exactly once", () => {
    openExternalMock.mockClear();
    renderOverview(withAuthors([{ name: "Alice", url: "https://alice.example.com" }]));
    fireEvent.click(screen.getByRole("button", { name: "https://alice.example.com" }));
    expect(openExternalMock).toHaveBeenCalledTimes(1);
    expect(openExternalMock).toHaveBeenCalledWith("https://alice.example.com");
  });

  it("opens an author email as a mailto link through systemClient.openExternal", () => {
    openExternalMock.mockClear();
    renderOverview(withAuthors([{ name: "Alice", email: "alice@example.com" }]));
    fireEvent.click(screen.getByRole("button", { name: "alice@example.com" }));
    expect(openExternalMock).toHaveBeenCalledTimes(1);
    expect(openExternalMock).toHaveBeenCalledWith("mailto:alice@example.com");
  });
});

describe("PluginDetailPane MCP servers tab (issue #10584)", () => {
  function withMcpServers(
    servers: NonNullable<LoadedPluginInfo["manifest"]["contributes"]["mcpServers"]>
  ): LoadedPluginInfo {
    const base = makePlugin();
    return {
      ...base,
      manifest: {
        ...base.manifest,
        contributes: { ...base.manifest.contributes, mcpServers: servers },
      },
    };
  }

  it("hides the MCP servers tab when the plugin declares none", () => {
    renderOverview(makePlugin());
    expect(screen.queryByRole("tab", { name: "MCP servers" })).toBeNull();
  });

  it("shows the MCP servers tab when the plugin declares at least one server", () => {
    renderOverview(withMcpServers([{ id: "srv", name: "Demo Server", command: "node" }]));
    expect(screen.getByRole("tab", { name: "MCP servers" })).toBeTruthy();
  });

  it("renders the declared server and polls the supervisor when the tab is opened", async () => {
    renderOverview(withMcpServers([{ id: "srv", name: "Demo Server", command: "node" }]));
    fireEvent.click(screen.getByRole("tab", { name: "MCP servers" }));
    expect(await screen.findByText("Demo Server")).toBeTruthy();
    expect(pluginMcpListMock).toHaveBeenCalled();
  });
});

describe("PluginDetailPane content-gated tabs (#11302)", () => {
  function withContributes(
    contributes: Partial<LoadedPluginInfo["manifest"]["contributes"]>,
    overrides: Partial<LoadedPluginInfo> = {}
  ): LoadedPluginInfo {
    const base = makePlugin(overrides);
    return {
      ...base,
      manifest: {
        ...base.manifest,
        contributes: { ...base.manifest.contributes, ...contributes },
      },
    };
  }

  const SETTING = {
    id: "token",
    type: "string" as const,
    label: "API token",
    scope: "user" as const,
  };

  it("leaves a plugin with no settings and no capabilities on Overview alone", () => {
    renderOverview(makePlugin());
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["Overview"]);
  });

  it("hides Settings when the plugin declares none", () => {
    renderOverview(makePlugin());
    expect(screen.queryByRole("tab", { name: "Settings" })).toBeNull();
  });

  it("shows Settings when the plugin declares one", () => {
    renderOverview(withContributes({ settings: [SETTING] }));
    expect(screen.getByRole("tab", { name: "Settings" })).toBeTruthy();
  });

  it("shows Permissions when the plugin declares a built-in capability", () => {
    renderOverview(withCapabilities(["fs:project-read"]));
    expect(screen.getByRole("tab", { name: "Permissions" })).toBeTruthy();
  });

  it("shows Permissions only when the plugin declares a built-in capability", () => {
    renderOverview(makePlugin());
    expect(screen.queryByRole("tab", { name: "Permissions" })).toBeNull();
  });

  it("falls back to Overview when the active tab disappears on a same-id reinstall", () => {
    // The detail subtree is keyed on the plugin NAME, so reinstalling the same
    // plugin re-renders in place rather than remounting — a version that drops
    // its last setting would otherwise strand the pane on a dead tab.
    const withSettings = withContributes({ settings: [SETTING] });
    const { rerender } = render(
      <TooltipProvider>
        <PluginDetailPane
          plugin={withSettings}
          checkingUpdate={false}
          upToDate={false}
          onUninstall={vi.fn()}
          onCheckForUpdate={vi.fn()}
        />
      </TooltipProvider>
    );
    fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
    expect(screen.getByRole("tab", { name: "Settings" }).getAttribute("aria-selected")).toBe(
      "true"
    );

    rerender(
      <TooltipProvider>
        <PluginDetailPane
          plugin={makePlugin()}
          checkingUpdate={false}
          upToDate={false}
          onUninstall={vi.fn()}
          onCheckForUpdate={vi.fn()}
        />
      </TooltipProvider>
    );
    expect(screen.queryByRole("tab", { name: "Settings" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe(
      "true"
    );

    // The vanished tab must not resurrect as active when a later version brings
    // it back — deriving the rendered tab alone would leave `activeTab` pointing
    // at "settings", teleporting the user there without them asking.
    rerender(
      <TooltipProvider>
        <PluginDetailPane
          plugin={withSettings}
          checkingUpdate={false}
          upToDate={false}
          onUninstall={vi.fn()}
          onCheckForUpdate={vi.fn()}
        />
      </TooltipProvider>
    );
    expect(screen.getByRole("tab", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe(
      "true"
    );
  });
});

describe("PluginDetailPane overview contributions (#11302)", () => {
  function withContributes(
    contributes: Partial<LoadedPluginInfo["manifest"]["contributes"]>
  ): LoadedPluginInfo {
    const base = makePlugin();
    return {
      ...base,
      manifest: {
        ...base.manifest,
        contributes: { ...base.manifest.contributes, ...contributes },
      },
    };
  }

  const COMMAND = {
    id: "acme.demo.greet",
    title: "Say hello",
    description: "Prints a greeting",
    category: "Demo",
    kind: "command" as const,
    danger: "safe" as const,
  };

  const PANEL = {
    id: "acme.demo.board",
    name: "Demo board",
    iconId: "layout",
    color: "#888888",
    hasPty: false,
    canRestart: false,
    canConvert: false,
    showInPalette: true,
  };

  it("names each contributed command and how to reach it", () => {
    renderOverview(withContributes({ commands: [COMMAND] }));
    expect(screen.getByText("Say hello")).toBeTruthy();
    expect(screen.getByText("Prints a greeting")).toBeTruthy();
    expect(screen.getByText("Run it from the command palette")).toBeTruthy();
  });

  it("distinguishes query commands, which the palette never lists", () => {
    renderOverview(withContributes({ commands: [{ ...COMMAND, kind: "query" }] }));
    expect(screen.getByText("Available to agents and automation")).toBeTruthy();
    expect(screen.queryByText("Run it from the command palette")).toBeNull();
  });

  it("never echoes the manifest's self-declared danger", () => {
    // Only the host's effectiveDanger is authoritative; rendering the plugin's
    // own claim here would read as a host guarantee it never made.
    renderOverview(withContributes({ commands: [{ ...COMMAND, danger: "confirm" }] }));
    // Anchor on the row actually existing first — a bare "no /confirm/ anywhere"
    // assertion would also pass if commands stopped rendering entirely.
    const row = screen.getByText("Say hello").closest("li");
    expect(row).toBeTruthy();
    if (!row) return;
    expect(within(row).queryByText(/confirm/i)).toBeNull();
  });

  it("names each contributed panel and how to open it", () => {
    renderOverview(withContributes({ panels: [PANEL] }));
    expect(screen.getByText("Demo board")).toBeTruthy();
    expect(screen.getByText("Open it from the new-panel menu")).toBeTruthy();
  });

  it("labels a palette-hidden panel accurately rather than dropping it", () => {
    renderOverview(withContributes({ panels: [{ ...PANEL, showInPalette: false }] }));
    expect(screen.getByText("Demo board")).toBeTruthy();
    expect(screen.getByText("Opened by the plugin")).toBeTruthy();
  });

  it("omits both sections entirely when the plugin contributes neither", () => {
    renderOverview(makePlugin());
    expect(screen.queryByText("Commands")).toBeNull();
    expect(screen.queryByText("Panels")).toBeNull();
  });
});

describe("PluginDetailPane blocklist (#10891)", () => {
  it("shows the blocked banner with the reason in the overview", () => {
    renderOverview(makePlugin({ blocklisted: true, blocklistReason: "Steals tokens" }));
    expect(screen.getByText(/Blocked from loading: Steals tokens/)).toBeTruthy();
  });

  it("falls back to a generic reason when none is provided", () => {
    renderOverview(makePlugin({ blocklisted: true }));
    expect(screen.getByText(/flagged by the Daintree blocklist/)).toBeTruthy();
  });

  it("does not show the blocked banner for a normal plugin", () => {
    renderOverview(makePlugin());
    expect(screen.queryByText(/Blocked from loading/)).toBeNull();
  });
});
