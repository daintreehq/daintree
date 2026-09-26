// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));

let currentProjectId: string | null = "proj-1";
vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: { currentProject: { id: string } | null }) => unknown) =>
    selector({ currentProject: currentProjectId ? { id: currentProjectId } : null }),
}));

vi.mock("@/store/pluginRuntimeStore", () => ({
  usePluginRuntimeStore: (
    selector: (s: {
      pluginMetaById: Map<string, { displayName: string }>;
      init: () => void;
    }) => unknown
  ) =>
    selector({
      pluginMetaById: new Map([["acme.linear", { displayName: "Linear" }]]),
      init: () => undefined,
    }),
}));

import { PluginKindSetupStrip, PluginSetupStrip } from "../PluginSetupStrip";
import { registerPanelKind, unregisterPanelKind } from "@shared/config/panelKindRegistry";

const getRequiredSettingsStatus = vi.fn();
let settingsListeners: Array<(payload: { pluginId: string }) => void> = [];

function announce(pluginId: string) {
  for (const listener of settingsListeners) listener({ pluginId });
}

beforeEach(() => {
  currentProjectId = "proj-1";
  vi.clearAllMocks();
  settingsListeners = [];
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      plugin: {
        getRequiredSettingsStatus,
        onSettingsChanged: (cb: (payload: { pluginId: string }) => void) => {
          settingsListeners.push(cb);
          return () => {
            settingsListeners = settingsListeners.filter((l) => l !== cb);
          };
        },
      },
    },
  });
});

afterEach(() => {
  cleanup();
});

describe("PluginSetupStrip", () => {
  it("names the plugin and opens the first missing setting", async () => {
    getRequiredSettingsStatus.mockResolvedValue({
      missing: ["apiKey", "team"],
      unreadable: [],
      labels: {},
    });
    render(<PluginSetupStrip pluginId="acme.linear" />);

    const strip = await screen.findByTestId("plugin-setup-strip");
    expect(strip.textContent).toContain("Linear needs setup");
    expect(getRequiredSettingsStatus).toHaveBeenCalledWith("acme.linear", "proj-1");

    fireEvent.click(screen.getByRole("button", { name: "Open plugin settings" }));
    expect(dispatch).toHaveBeenCalledWith(
      "plugin.openSettings",
      { pluginId: "acme.linear", key: "apiKey" },
      { source: "user" }
    );
  });

  it("goes away once the required setting is stored, and comes back if it is cleared", async () => {
    getRequiredSettingsStatus.mockResolvedValue({
      missing: ["apiKey"],
      unreadable: [],
      labels: {},
    });
    render(<PluginSetupStrip pluginId="acme.linear" />);
    await screen.findByTestId("plugin-setup-strip");

    getRequiredSettingsStatus.mockResolvedValue({ missing: [], unreadable: [], labels: {} });
    await act(async () => announce("acme.linear"));
    await waitFor(() => expect(screen.queryByTestId("plugin-setup-strip")).toBeNull());

    getRequiredSettingsStatus.mockResolvedValue({
      missing: ["apiKey"],
      unreadable: [],
      labels: {},
    });
    await act(async () => announce("acme.linear"));
    expect(await screen.findByTestId("plugin-setup-strip")).toBeTruthy();
  });

  it("ignores another plugin's settings changes", async () => {
    getRequiredSettingsStatus.mockResolvedValue({
      missing: ["apiKey"],
      unreadable: [],
      labels: {},
    });
    render(<PluginSetupStrip pluginId="acme.linear" />);
    await screen.findByTestId("plugin-setup-strip");

    await act(async () => announce("acme.other"));
    expect(getRequiredSettingsStatus).toHaveBeenCalledTimes(1);
  });

  it("shows nothing when nothing is missing or the read fails", async () => {
    getRequiredSettingsStatus.mockRejectedValue(new Error("boom"));
    render(<PluginSetupStrip pluginId="acme.linear" />);
    await waitFor(() => expect(getRequiredSettingsStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("plugin-setup-strip")).toBeNull();
  });

  it("says which required key it couldn't read, and opens it", async () => {
    getRequiredSettingsStatus.mockResolvedValue({
      missing: [],
      unreadable: ["apiKey"],
      labels: { apiKey: "API key" },
    });
    render(<PluginSetupStrip pluginId="acme.linear" />);

    const strip = await screen.findByTestId("plugin-setup-strip");
    // What was observed, not a guess that it is unset.
    expect(strip.textContent).toContain("Couldn't read API key");
    expect(strip.textContent).not.toContain("needs setup");
    fireEvent.click(screen.getByRole("button", { name: "Open plugin settings" }));
    expect(dispatch).toHaveBeenCalledWith(
      "plugin.openSettings",
      { pluginId: "acme.linear", key: "apiKey" },
      { source: "user" }
    );
  });

  it("puts an unset key ahead of an unreadable one", async () => {
    getRequiredSettingsStatus.mockResolvedValue({
      missing: ["team"],
      unreadable: ["apiKey"],
      labels: { team: "Team", apiKey: "API key" },
    });
    render(<PluginSetupStrip pluginId="acme.linear" />);

    const strip = await screen.findByTestId("plugin-setup-strip");
    expect(strip.textContent).toContain("Linear needs setup");
  });
});

describe("PluginKindSetupStrip", () => {
  afterEach(() => {
    unregisterPanelKind("acme.linear.shell");
  });

  function registerKind(hasRequiredSettings: boolean) {
    registerPanelKind({
      id: "acme.linear.shell",
      name: "Linear shell",
      iconId: "terminal",
      color: "#abcdef",
      hasPty: true,
      canRestart: false,
      canConvert: false,
      extensionId: "acme.linear",
      ...(hasRequiredSettings ? { hasRequiredSettings: true } : {}),
    });
  }

  it("draws the strip for a kind whose plugin requires settings", async () => {
    getRequiredSettingsStatus.mockResolvedValue({
      missing: ["apiKey"],
      unreadable: [],
      labels: {},
    });
    registerKind(true);
    render(<PluginKindSetupStrip kind="acme.linear.shell" />);
    expect(await screen.findByTestId("plugin-setup-strip")).toBeTruthy();
    expect(getRequiredSettingsStatus).toHaveBeenCalledWith("acme.linear", "proj-1");
  });

  it("draws nothing, and reads nothing, for a built-in or unrequired kind", () => {
    registerKind(false);
    render(<PluginKindSetupStrip kind="acme.linear.shell" />);
    render(<PluginKindSetupStrip kind="terminal" />);
    expect(screen.queryByTestId("plugin-setup-strip")).toBeNull();
    expect(getRequiredSettingsStatus).not.toHaveBeenCalled();
  });
});
