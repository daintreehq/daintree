// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PluginAccountBindingRow } from "../PluginAccountBindingRow";
import type { LoadedPluginInfo, PluginAccountBindingUiStatus } from "@shared/types/plugin";

const pluginApi = {
  getAccountBinding: vi.fn(),
  setAccountBinding: vi.fn(),
  onSettingsChanged: vi.fn((_cb: (payload: { pluginId: string }) => void) => () => {}),
};

const PLUGIN: LoadedPluginInfo = {
  manifest: {
    name: "acme.tracker",
    version: "1.0.0",
    contributes: {
      panels: [],
      toolbarButtons: [],
      menuItems: [],
      keybindings: [],
      contextMenus: [],
      commands: [],
      views: [],
      mcpServers: [],
      skills: [],
      forgeProviders: [],
      fileDecorationProviders: [],
      fileEditors: [],
      agents: [],
      processTools: [],
      recipes: [],
    },
  },
  instanceId: "acme.tracker",
  origin: "global",
  projectId: null,
  dir: "/tmp/acme.tracker",
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
};

function status(over: Partial<PluginAccountBindingUiStatus> = {}): PluginAccountBindingUiStatus {
  return {
    binding: null,
    selected: { connectionId: "work", source: "own" },
    choices: [
      { connectionId: "work", source: "own", label: "Work", connected: true, identity: "octo" },
      {
        connectionId: "personal",
        source: "own",
        label: "Personal",
        connected: false,
        identity: null,
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  pluginApi.onSettingsChanged.mockImplementation(() => () => {});
  Object.defineProperty(window, "electron", {
    value: { plugin: pluginApi },
    configurable: true,
    writable: true,
  });
});

afterEach(() => cleanup());

describe("PluginAccountBindingRow", () => {
  it("stays hidden while there is nothing to choose", async () => {
    pluginApi.getAccountBinding.mockResolvedValue(
      status({ choices: status().choices.slice(0, 1) })
    );
    const { container } = render(<PluginAccountBindingRow plugin={PLUGIN} />);
    await vi.waitFor(() => expect(pluginApi.getAccountBinding).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe("");
  });

  it("shows the project's choice and resets it to the default", async () => {
    pluginApi.getAccountBinding.mockResolvedValue(
      status({
        binding: { connectionId: "personal", source: "own" },
        selected: { connectionId: "personal", source: "own" },
      })
    );
    pluginApi.setAccountBinding.mockResolvedValue(status());
    render(<PluginAccountBindingRow plugin={PLUGIN} />);

    await screen.findByText(/Not connected yet\. Connect it in the plugin manager/);
    fireEvent.click(screen.getByRole("button", { name: "Use the default connection" }));
    await vi.waitFor(() =>
      expect(pluginApi.setAccountBinding).toHaveBeenCalledWith("acme.tracker", null)
    );
    await screen.findByText(/Nothing is written to the repository/);
  });

  it("keeps a choice the plugin no longer declares visible so it can be replaced", async () => {
    pluginApi.getAccountBinding.mockResolvedValue(
      status({
        binding: { connectionId: "gone", source: "own" },
        selected: { connectionId: "gone", source: "own" },
        choices: status().choices.slice(0, 1),
      })
    );
    render(<PluginAccountBindingRow plugin={PLUGIN} />);
    await screen.findByText(/The connection this project used is gone/);
  });

  it("offers Retry when the choice can't be read", async () => {
    pluginApi.getAccountBinding.mockRejectedValueOnce(new Error("boom"));
    pluginApi.getAccountBinding.mockResolvedValueOnce(status());
    render(<PluginAccountBindingRow plugin={PLUGIN} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await screen.findByText(/Nothing is written to the repository/);
  });
});
