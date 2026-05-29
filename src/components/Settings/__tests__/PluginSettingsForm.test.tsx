// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PluginSettingsForm } from "../PluginSettingsForm";
import type { LoadedPluginInfo, SettingDefinition } from "@shared/types/plugin";

let currentProjectId: string | null = null;

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: { currentProject: { id: string } | null }) => unknown) =>
    selector({ currentProject: currentProjectId ? { id: currentProjectId } : null }),
}));

const pluginApi = {
  getSettingValues: vi.fn(),
  setSettingValue: vi.fn().mockResolvedValue(undefined),
  deleteSettingValue: vi.fn().mockResolvedValue(undefined),
  revealSecretSetting: vi.fn(),
};

function makePlugin(settings: SettingDefinition[]): LoadedPluginInfo {
  return {
    manifest: {
      name: "acme.test",
      version: "1.0.0",
      contributes: {
        panels: [],
        toolbarButtons: [],
        menuItems: [],
        keybindings: [],
        contextMenus: [],
        commands: [],
        experimental_views: [],
        experimental_mcpServers: [],
        forgeProviders: [],
        fileDecorationProviders: [],
        settings,
      },
    },
    dir: "/tmp/acme.test",
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
  } as unknown as LoadedPluginInfo;
}

beforeEach(() => {
  currentProjectId = null;
  vi.clearAllMocks();
  pluginApi.setSettingValue.mockResolvedValue(undefined);
  pluginApi.deleteSettingValue.mockResolvedValue(undefined);
  pluginApi.getSettingValues.mockResolvedValue({ values: {}, secretsSet: [] });
  (window as unknown as { electron: unknown }).electron = { plugin: pluginApi };
});

afterEach(() => {
  cleanup();
});

describe("PluginSettingsForm", () => {
  it("renders field chrome immediately, before values resolve", () => {
    let resolve!: (v: { values: Record<string, unknown>; secretsSet: string[] }) => void;
    pluginApi.getSettingValues.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      })
    );
    render(
      <PluginSettingsForm
        plugin={makePlugin([{ id: "apiKey", type: "string", label: "API key" }])}
      />
    );
    // Label + control paint synchronously from the manifest; the input is
    // disabled until the bridge call resolves.
    const input = screen.getByLabelText("API key") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.disabled).toBe(true);
    resolve({ values: {}, secretsSet: [] });
  });

  it("populates a stored string value and writes it on blur", async () => {
    pluginApi.getSettingValues.mockResolvedValue({ values: { apiKey: "stored" }, secretsSet: [] });
    render(
      <PluginSettingsForm
        plugin={makePlugin([{ id: "apiKey", type: "string", label: "API key" }])}
      />
    );

    const input = (await screen.findByLabelText("API key")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("stored"));

    fireEvent.change(input, { target: { value: "changed" } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(pluginApi.setSettingValue).toHaveBeenCalledWith(
        "acme.test",
        "apiKey",
        "changed",
        "user",
        null
      )
    );
  });

  it("shows the declared default when no value is stored", async () => {
    render(
      <PluginSettingsForm
        plugin={makePlugin([{ id: "host", type: "string", label: "Host", default: "localhost" }])}
      />
    );
    const input = (await screen.findByLabelText("Host")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("localhost"));
  });

  it("writes a boolean on toggle", async () => {
    render(
      <PluginSettingsForm plugin={makePlugin([{ id: "flag", type: "boolean", label: "Flag" }])} />
    );
    const toggle = (await screen.findByRole("switch", { name: "Flag" })) as HTMLButtonElement;
    await waitFor(() => expect(toggle.disabled).toBe(false));
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(pluginApi.setSettingValue).toHaveBeenCalledWith(
        "acme.test",
        "flag",
        true,
        "user",
        null
      )
    );
  });

  it("writes an enum on change", async () => {
    render(
      <PluginSettingsForm
        plugin={makePlugin([{ id: "mode", type: "enum", label: "Mode", options: ["a", "b"] }])}
      />
    );
    const select = (await screen.findByLabelText("Mode")) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    fireEvent.change(select, { target: { value: "b" } });
    await waitFor(() =>
      expect(pluginApi.setSettingValue).toHaveBeenCalledWith("acme.test", "mode", "b", "user", null)
    );
  });

  it("surfaces an inline error for invalid JSON and does not write", async () => {
    render(
      <PluginSettingsForm plugin={makePlugin([{ id: "cfg", type: "json", label: "Config" }])} />
    );
    const textarea = (await screen.findByLabelText("Config")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.disabled).toBe(false));
    fireEvent.change(textarea, { target: { value: "{ not json" } });
    fireEvent.blur(textarea);
    expect(await screen.findByText("Enter valid JSON")).toBeTruthy();
    expect(pluginApi.setSettingValue).not.toHaveBeenCalled();
  });

  it("never shows a secret value until revealed, then re-masks on blur", async () => {
    pluginApi.getSettingValues.mockResolvedValue({ values: {}, secretsSet: ["token"] });
    pluginApi.revealSecretSetting.mockResolvedValue("sekret");
    render(
      <PluginSettingsForm plugin={makePlugin([{ id: "token", type: "secret", label: "Token" }])} />
    );

    const input = (await screen.findByLabelText("Token")) as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    // Bulk load never carried the secret value.
    expect(input.value).toBe("");
    expect(input.type).toBe("password");

    fireEvent.click(screen.getByRole("button", { name: "Reveal Token" }));
    await waitFor(() => expect(input.value).toBe("sekret"));
    expect(input.type).toBe("text");

    fireEvent.blur(input);
    await waitFor(() =>
      expect(pluginApi.setSettingValue).toHaveBeenCalledWith(
        "acme.test",
        "token",
        "sekret",
        "user",
        null
      )
    );
    // Re-masked: value cleared from the DOM.
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("renders a scope badge per field", async () => {
    render(
      <PluginSettingsForm
        plugin={makePlugin([{ id: "p", type: "string", label: "P", scope: "project" }])}
      />
    );
    expect(await screen.findByText("Project")).toBeTruthy();
  });

  it("disables project-scoped fields when no project is active", async () => {
    currentProjectId = null;
    render(
      <PluginSettingsForm
        plugin={makePlugin([{ id: "p", type: "string", label: "P", scope: "project" }])}
      />
    );
    const input = (await screen.findByLabelText("P")) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(screen.getByText("Open a project to edit this setting.")).toBeTruthy();
  });
});
