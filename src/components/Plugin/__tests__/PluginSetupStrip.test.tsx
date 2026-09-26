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

import { PluginSetupStrip } from "../PluginSetupStrip";

const getMissingRequiredSettings = vi.fn();
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
        getMissingRequiredSettings,
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
    getMissingRequiredSettings.mockResolvedValue(["apiKey", "team"]);
    render(<PluginSetupStrip pluginId="acme.linear" />);

    const strip = await screen.findByTestId("plugin-setup-strip");
    expect(strip.textContent).toContain("Linear needs setup");
    expect(getMissingRequiredSettings).toHaveBeenCalledWith("acme.linear", "proj-1");

    fireEvent.click(screen.getByRole("button", { name: "Configure…" }));
    expect(dispatch).toHaveBeenCalledWith(
      "plugin.openSettings",
      { pluginId: "acme.linear", key: "apiKey" },
      { source: "user" }
    );
  });

  it("goes away once the required setting is stored, and comes back if it is cleared", async () => {
    getMissingRequiredSettings.mockResolvedValue(["apiKey"]);
    render(<PluginSetupStrip pluginId="acme.linear" />);
    await screen.findByTestId("plugin-setup-strip");

    getMissingRequiredSettings.mockResolvedValue([]);
    await act(async () => announce("acme.linear"));
    await waitFor(() => expect(screen.queryByTestId("plugin-setup-strip")).toBeNull());

    getMissingRequiredSettings.mockResolvedValue(["apiKey"]);
    await act(async () => announce("acme.linear"));
    expect(await screen.findByTestId("plugin-setup-strip")).toBeTruthy();
  });

  it("ignores another plugin's settings changes", async () => {
    getMissingRequiredSettings.mockResolvedValue(["apiKey"]);
    render(<PluginSetupStrip pluginId="acme.linear" />);
    await screen.findByTestId("plugin-setup-strip");

    await act(async () => announce("acme.other"));
    expect(getMissingRequiredSettings).toHaveBeenCalledTimes(1);
  });

  it("shows nothing when nothing is missing or the read fails", async () => {
    getMissingRequiredSettings.mockRejectedValue(new Error("boom"));
    render(<PluginSetupStrip pluginId="acme.linear" />);
    await waitFor(() => expect(getMissingRequiredSettings).toHaveBeenCalled());
    expect(screen.queryByTestId("plugin-setup-strip")).toBeNull();
  });
});
