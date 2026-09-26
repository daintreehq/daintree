// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type {
  LoadedPluginInfo,
  PluginSettingsViewContext,
  SettingDefinition,
} from "@shared/types/plugin";

let currentProjectId: string | null = null;

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: { currentProject: { id: string } | null }) => unknown) =>
    selector({ currentProject: currentProjectId ? { id: currentProjectId } : null }),
}));

const madeFor = vi.hoisted(() => [] as Array<Record<string, unknown>>);

// The loader is exercised by its own suites; here it only has to show what the
// settings home handed it.
vi.mock("@/components/Plugin/PluginViewContent", () => ({
  makePluginViewContent: (config: Record<string, unknown>) => {
    madeFor.push(config);
    return function FakeContent(props: {
      panelId: string;
      settingsContext?: PluginSettingsViewContext;
    }) {
      return (
        <div
          data-testid="fake-settings-view"
          data-panel-id={props.panelId}
          data-scope={props.settingsContext?.scope}
          data-project={props.settingsContext?.projectId ?? ""}
        />
      );
    };
  },
}));

import { PluginSettingsForm } from "../PluginSettingsForm";
import {
  _resetPluginSettingsViewRuntimesForTest,
  pruneSettingsViewRuntimes,
} from "@/components/Plugin/PluginSettingsView";

const pluginApi = {
  getSettingValues: vi.fn(),
  setSettingValue: vi.fn(),
  deleteSettingValue: vi.fn(),
  revealSecretSetting: vi.fn(),
  pickPath: vi.fn(),
  pathExists: vi.fn(),
};

function makePlugin(
  settings: SettingDefinition[],
  settingsViewPath?: string,
  overrides: { declaresView?: boolean; disabled?: boolean } = {}
): LoadedPluginInfo {
  const declaresView = overrides.declaresView ?? settingsViewPath !== undefined;
  return {
    manifest: {
      name: "acme.test",
      version: "1.0.0",
      contributes: {
        panels: [],
        toolbarButtons: [],
        menuItems: [],
        commands: [],
        views: declaresView
          ? [{ id: "prefs", componentPath: "dist/prefs.js", location: "settings" }]
          : [],
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
        settings,
      },
    },
    instanceId: "acme.test",
    origin: "global",
    projectId: null,
    dir: "/plugins/acme.test",
    loadedAt: 1,
    isBuiltin: false,
    source: "sideload",
    installedAt: 1,
    archiveHash: null,
    originalUrl: null,
    loadError: null,
    disabled: overrides.disabled ?? false,
    updateAvailable: null,
    devMode: false,
    pluginDanger: "safe",
    blocklisted: false,
    ...(settingsViewPath ? { settingsViewPath } : {}),
  };
}

beforeEach(() => {
  currentProjectId = null;
  madeFor.length = 0;
  vi.clearAllMocks();
  _resetPluginSettingsViewRuntimesForTest();
  pluginApi.getSettingValues.mockResolvedValue({
    values: {},
    secretsSet: [],
    secretsPlaintext: [],
    secretTier: "keychain",
  });
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { plugin: pluginApi },
  });
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
});

describe("PluginSettingsForm custom settings section", () => {
  it("mounts the plugin's settings view below its fields in the plugin manager home", () => {
    render(
      <PluginSettingsForm
        plugin={makePlugin([{ id: "apiKey", type: "secret" }], "plugin://a/settings.js")}
        viewScope="user"
      />
    );

    const view = screen.getByTestId("fake-settings-view");
    expect(view.getAttribute("data-scope")).toBe("user");
    expect(view.getAttribute("data-project")).toBe("");
    // Below the declared fields, in its own host-owned group.
    const field = document.getElementById("plugin-setting-acme.test-apiKey")!;
    expect(field.compareDocumentPosition(view) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("plugin-settings-view").closest(".settings-card")).not.toBeNull();
    expect(madeFor[0]).toMatchObject({
      id: "plugin-settings-view:acme.test",
      componentPath: "plugin://a/settings.js",
      extensionId: "acme.test",
      standalone: true,
    });
  });

  it("mounts it with the project context in Project settings", () => {
    currentProjectId = "proj-1";
    render(
      <PluginSettingsForm plugin={makePlugin([], "plugin://a/settings.js")} viewScope="project" />
    );

    const view = screen.getByTestId("fake-settings-view");
    expect(view.getAttribute("data-scope")).toBe("project");
    expect(view.getAttribute("data-project")).toBe("proj-1");
    // A view-only plugin draws no empty group for fields it doesn't have.
    expect(document.querySelectorAll(".settings-card")).toHaveLength(1);
  });

  it("contains the view so it can't paint over the page around it", () => {
    render(
      <PluginSettingsForm plugin={makePlugin([], "plugin://a/settings.js")} viewScope="user" />
    );
    const box = screen.getByTestId("plugin-settings-view");
    expect(box.style.contain).toBe("layout paint");
    expect(box.classList.contains("overflow-hidden")).toBe(true);
    expect(box.classList.contains("isolate")).toBe(true);
  });

  it("says a stopped plugin's section needs it enabled, instead of dropping it", () => {
    render(
      <PluginSettingsForm
        plugin={makePlugin([], undefined, { declaresView: true, disabled: true })}
        viewScope="user"
      />
    );
    expect(screen.queryByTestId("fake-settings-view")).toBeNull();
    expect(screen.getByText("Available when the plugin is enabled")).toBeTruthy();
  });

  it("unmounts a running section the home knows has stopped, before its list catches up", () => {
    currentProjectId = "proj-1";
    const plugin = makePlugin([], "plugin://a/settings.js");
    const { rerender } = render(<PluginSettingsForm plugin={plugin} viewScope="project" />);
    expect(screen.getByTestId("fake-settings-view")).toBeTruthy();

    rerender(<PluginSettingsForm plugin={plugin} viewScope="project" viewRunning={false} />);
    expect(screen.queryByTestId("fake-settings-view")).toBeNull();
    expect(screen.getByText("Available while the plugin is running")).toBeTruthy();
  });

  it("retires a cached runtime when its plugin leaves the list or reloads", () => {
    const first = makePlugin([], "plugin://a/gen1/settings.js");
    const { unmount } = render(<PluginSettingsForm plugin={first} viewScope="user" />);
    unmount();
    // Same module: the factory is reused.
    render(<PluginSettingsForm plugin={first} viewScope="user" />);
    expect(madeFor).toHaveLength(1);
    cleanup();

    // Reloaded onto a new generation: the list sweep retires the old factory
    // and the next mount mints one for the new module.
    const reloaded = makePlugin([], "plugin://a/gen2/settings.js");
    pruneSettingsViewRuntimes([reloaded]);
    render(<PluginSettingsForm plugin={reloaded} viewScope="user" />);
    expect(madeFor.map((c) => c.componentPath)).toEqual([
      "plugin://a/gen1/settings.js",
      "plugin://a/gen2/settings.js",
    ]);
  });

  it("renders nothing for a plugin with neither fields nor a view", () => {
    const { container } = render(<PluginSettingsForm plugin={makePlugin([])} viewScope="user" />);
    expect(container.innerHTML).toBe("");
  });
});

describe("PluginSettingsForm deep-link landing", () => {
  it("lands on the requested setting once its value has loaded, and reports it handled", async () => {
    const onFocusHandled = vi.fn();
    render(
      <PluginSettingsForm
        plugin={makePlugin([
          { id: "region", type: "string" },
          { id: "apiKey", type: "secret", required: true },
        ])}
        viewScope="user"
        focusRequest={{ key: "apiKey", nonce: 7 }}
        onFocusHandled={onFocusHandled}
      />
    );

    await waitFor(() => expect(onFocusHandled).toHaveBeenCalledWith(7));
    const row = document.getElementById("plugin-setting-acme.test-apiKey")!;
    expect(row.classList.contains("settings-highlight")).toBe(true);
    expect(row.scrollIntoView).toHaveBeenCalled();
    expect(row.contains(document.activeElement)).toBe(true);
    expect(row.textContent).toContain("Required");
  });

  it("waits for a hidden settings tab to show before landing", async () => {
    const onFocusHandled = vi.fn();
    const { container } = render(
      <div className="hidden" data-testid="tab">
        <PluginSettingsForm
          plugin={makePlugin([{ id: "apiKey", type: "string" }])}
          viewScope="user"
          focusRequest={{ key: "apiKey", nonce: 9 }}
          onFocusHandled={onFocusHandled}
        />
      </div>
    );
    const row = await waitFor(() => document.getElementById("plugin-setting-acme.test-apiKey")!);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(onFocusHandled).not.toHaveBeenCalled();
    expect(row.classList.contains("settings-highlight")).toBe(false);

    // The dialog switches to the tab: the next retry lands.
    container.querySelector('[data-testid="tab"]')!.classList.remove("hidden");
    await waitFor(() => expect(onFocusHandled).toHaveBeenCalledWith(9));
    expect(row.classList.contains("settings-highlight")).toBe(true);
  });

  it("still reports a request for a key it doesn't declare, so it isn't left pending", async () => {
    const onFocusHandled = vi.fn();
    render(
      <PluginSettingsForm
        plugin={makePlugin([{ id: "region", type: "string" }])}
        viewScope="user"
        focusRequest={{ key: "gone", nonce: 3 }}
        onFocusHandled={onFocusHandled}
      />
    );

    await waitFor(() => expect(onFocusHandled).toHaveBeenCalledWith(3));
    expect(document.querySelector(".settings-highlight")).toBeNull();
  });
});
