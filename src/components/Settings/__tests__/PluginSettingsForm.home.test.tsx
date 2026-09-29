// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type {
  LoadedPluginInfo,
  PluginRuntimeStatusChangedEvent,
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
import { _resetPluginRuntimeStatusStoreForTest } from "@/store/pluginRuntimeStatusStore";
import {
  _resetPluginSettingsViewRuntimesForTest,
  _settingsViewRemovalSignalForTest,
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
  _resetPluginRuntimeStatusStoreForTest();
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

  it("retires a cached runtime when its plugin stops or reloads, with no settings page open", () => {
    const listeners: Array<(payload: PluginRuntimeStatusChangedEvent) => void> = [];
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: {
        plugin: pluginApi,
        events: {
          on: (_name: string, cb: (payload: PluginRuntimeStatusChangedEvent) => void) => {
            listeners.push(cb);
            return () => {};
          },
        },
      },
    });
    const push = (status: PluginRuntimeStatusChangedEvent["status"]) =>
      listeners.forEach((cb) => cb({ pluginId: "acme.test", status }));
    const status = (viewGeneration: number | null) => ({
      pluginId: "acme.test",
      viewGeneration,
      worker: null,
      dev: null,
    });

    // Mounted once, then the page closes: the runtime stays cached.
    render(
      <PluginSettingsForm
        plugin={makePlugin([], "plugin://a/__dtv-3/settings.js")}
        viewScope="user"
      />
    );
    cleanup();
    const signal = _settingsViewRemovalSignalForTest("acme.test")!;
    expect(signal.aborted).toBe(false);

    // Still the same generation: nothing to retire.
    push(status(3));
    expect(signal.aborted).toBe(false);

    // Reloaded onto a new module: retired at once, not on the next visit.
    push(status(4));
    expect(signal.aborted).toBe(true);
    expect(_settingsViewRemovalSignalForTest("acme.test")).toBeUndefined();

    // Stopped: the same, for the runtime minted after the reload.
    render(
      <PluginSettingsForm
        plugin={makePlugin([], "plugin://a/__dtv-4/settings.js")}
        viewScope="user"
      />
    );
    cleanup();
    const next = _settingsViewRemovalSignalForTest("acme.test")!;
    push(null);
    expect(next.aborted).toBe(true);
  });

  it("swaps a mounted view for the reloaded module while the page stays open", async () => {
    const listeners: Array<(payload: PluginRuntimeStatusChangedEvent) => void> = [];
    const list = vi.fn(async () => [makePlugin([], "plugin://b/__dtv-4/settings.js")]);
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: {
        plugin: { ...pluginApi, list },
        events: {
          on: (name: string, cb: (payload: PluginRuntimeStatusChangedEvent) => void) => {
            if (name === "plugin:runtime-status-changed") listeners.push(cb);
            return () => {};
          },
        },
      },
    });
    const push = (viewGeneration: number) =>
      act(() =>
        listeners.forEach((cb) =>
          cb({
            pluginId: "acme.test",
            status: { pluginId: "acme.test", viewGeneration, worker: null, dev: null },
          })
        )
      );
    render(
      <PluginSettingsForm
        plugin={makePlugin([], "plugin://a/__dtv-3/settings.js")}
        viewScope="user"
      />
    );
    push(3);
    expect(screen.getByTestId("fake-settings-view")).toBeTruthy();

    // A dev rebuild: the live generation moves on, the props do not.
    push(4);

    await waitFor(() =>
      expect(madeFor.at(-1)?.componentPath).toBe("plugin://b/__dtv-4/settings.js")
    );
    expect(screen.getByTestId("fake-settings-view")).toBeTruthy();
    expect(list).toHaveBeenCalled();
  });

  it("says the reloaded section couldn't load when the inventory never catches up", async () => {
    const listeners: Array<(payload: PluginRuntimeStatusChangedEvent) => void> = [];
    const list = vi.fn(async () => [makePlugin([], "plugin://a/__dtv-3/settings.js")]);
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: {
        plugin: { ...pluginApi, list },
        events: {
          on: (name: string, cb: (payload: PluginRuntimeStatusChangedEvent) => void) => {
            if (name === "plugin:runtime-status-changed") listeners.push(cb);
            return () => {};
          },
        },
      },
    });
    render(
      <PluginSettingsForm
        plugin={makePlugin([], "plugin://a/__dtv-3/settings.js")}
        viewScope="user"
      />
    );
    act(() =>
      listeners.forEach((cb) =>
        cb({
          pluginId: "acme.test",
          status: { pluginId: "acme.test", viewGeneration: 4, worker: null, dev: null },
        })
      )
    );
    expect(screen.getByText("Reloading…")).toBeTruthy();

    await waitFor(
      () => expect(screen.getByText(/Couldn't load the reloaded section/)).toBeTruthy(),
      {
        timeout: 5000,
      }
    );
    expect(list.mock.calls.length).toBe(5);
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

describe("PluginSettingsForm settings edited by the plugin's own section", () => {
  const cadence: SettingDefinition = {
    id: "cadence",
    type: "json",
    label: "Posting cadence",
    editor: "view",
  };
  const channel: SettingDefinition = { id: "channel", type: "string", label: "Default channel" };

  it("leaves a view-edited value to the plugin's section instead of showing it twice", () => {
    render(
      <PluginSettingsForm
        plugin={makePlugin([cadence, channel], "plugin://a/settings.js")}
        viewScope="user"
      />
    );

    expect(screen.queryByText("Posting cadence")).toBeNull();
    expect(screen.getByText("Default channel")).toBeTruthy();
    expect(screen.getByTestId("fake-settings-view")).toBeTruthy();
  });

  it("lands a link to a view-edited key on the plugin's own section", async () => {
    const onFocusHandled = vi.fn();
    render(
      <PluginSettingsForm
        plugin={makePlugin([cadence, channel], "plugin://a/settings.js")}
        viewScope="user"
        focusRequest={{ key: "cadence", nonce: 3 }}
        onFocusHandled={onFocusHandled}
      />
    );

    await waitFor(() => expect(onFocusHandled).toHaveBeenCalledWith(3));
    const section = screen.getByTestId("fake-settings-view").closest(".settings-highlight");
    expect(section).not.toBeNull();
  });

  it("still shows the field when the plugin declares no section to edit it", () => {
    render(<PluginSettingsForm plugin={makePlugin([cadence, channel])} viewScope="user" />);

    expect(screen.getByText("Posting cadence")).toBeTruthy();
  });
});

describe("PluginSettingsForm after the plugin reloads with new declarations", () => {
  it("re-reads stored values instead of showing a newly declared field as unset", async () => {
    const channel: SettingDefinition = { id: "channel", type: "string", label: "Channel" };
    const extra: SettingDefinition = { id: "extra", type: "string", label: "Extra" };
    const first = makePlugin([channel]);
    const { rerender } = render(<PluginSettingsForm plugin={first} viewScope="user" />);
    await waitFor(() => expect(pluginApi.getSettingValues).toHaveBeenCalledTimes(1));

    rerender(
      <PluginSettingsForm
        plugin={{ ...makePlugin([channel, extra]), loadedAt: 2 }}
        viewScope="user"
      />
    );

    await waitFor(() => expect(pluginApi.getSettingValues).toHaveBeenCalledTimes(2));
  });
});
