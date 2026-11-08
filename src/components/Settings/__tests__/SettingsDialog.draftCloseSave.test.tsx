// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@shared/types/project";

const editor = vi.hoisted(() => ({
  getConfig: vi.fn(),
  setConfig: vi.fn(),
  setDefault: vi.fn(),
  clearProjectPreference: vi.fn(),
  discover: vi.fn(),
}));
vi.mock("@/clients/editorClient", () => ({ editorClient: editor }));
vi.mock("@/components/ui/select", () => import("@/components/ui/__tests__/nativeSelectMock"));
vi.mock("@/hooks/useProjectSettingsForm", () => ({
  useProjectSettingsForm: () => ({
    currentProject: null,
    projectIsLoading: false,
    flush: async () => {},
    saveNow: async () => {},
  }),
}));
vi.mock("@/components/Hosts/hostList", () => ({ useHostList: () => ({ hosts: [] }) }));
vi.mock("../pluginSettingsSearch", () => ({ usePluginSettingsSearchIndex: () => [] }));
vi.mock("../GeneralTab", () => ({ GeneralTab: () => <p>General page</p> }));
vi.mock("@/clients", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/clients")>()),
  appClient: { getVersionInfo: () => Promise.resolve({ appVersion: "0.0.0", arch: "arm64" }) },
}));

import { SettingsDialog } from "../SettingsDialog";
import { useProjectStore } from "@/store/projectStore";
import { cleanupProjectSettingsStore } from "@/store/projectSettingsStore";
import { invalidateProjectSettingsCache } from "@/clients/projectClient";

vi.stubGlobal("requestIdleCallback", () => 0);
vi.stubGlobal("cancelIdleCallback", () => {});
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

const PROJECT = { id: "proj-1", name: "Repo", emoji: "🌲", path: "/repo" } as Project;

/** Stands in for the project settings file both Integrations writers go through. */
let settingsFile: Record<string, unknown>;
let saveSettings: ReturnType<typeof vi.fn>;

const mcp = {
  getStatus: vi.fn(),
  getRuntimeState: vi.fn(),
  setPort: vi.fn(),
  setAuditMaxRecords: vi.fn(),
};

beforeEach(() => {
  settingsFile = { runCommands: [], preferredEditor: { id: "vscode" } };
  invalidateProjectSettingsCache();
  cleanupProjectSettingsStore();
  useProjectStore.setState({ currentProject: PROJECT, projects: [PROJECT] });

  editor.getConfig.mockReset().mockImplementation(async () => ({
    preferredEditor: settingsFile.preferredEditor ?? null,
    defaultEditor: null,
    discoveredEditors: [
      { id: "vscode", available: true, executablePath: "/usr/bin/code" },
      { id: "zed", available: true, executablePath: "/usr/bin/zed" },
    ],
  }));
  // The same shape as main's handler: read the file, then write it back with one field set.
  editor.setConfig.mockReset().mockImplementation(async ({ editor: next }) => {
    const read = { ...settingsFile };
    await Promise.resolve();
    settingsFile = { ...read, preferredEditor: next };
  });
  editor.setDefault.mockReset().mockResolvedValue(undefined);
  editor.clearProjectPreference.mockReset().mockResolvedValue(undefined);
  editor.discover.mockReset().mockResolvedValue([]);

  saveSettings = vi.fn(async (_projectId: string, next: Record<string, unknown>) => {
    await Promise.resolve();
    settingsFile = next;
  });
  mcp.getStatus.mockReset().mockResolvedValue({
    enabled: true,
    port: 9020,
    configuredPort: 9020,
    apiKey: "dnt-key",
  });
  mcp.getRuntimeState
    .mockReset()
    .mockResolvedValue({ enabled: true, state: "ready", port: 9020, lastError: null });
  mcp.setPort.mockReset().mockImplementation(async (port: number | null) => ({
    enabled: true,
    port: port ?? 9020,
    configuredPort: port,
    apiKey: "dnt-key",
  }));
  mcp.setAuditMaxRecords
    .mockReset()
    .mockImplementation(async (maxRecords: number) => ({ enabled: true, maxRecords }));

  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      ...window.electron,
      globalEnv: { get: vi.fn().mockResolvedValue({}), set: vi.fn() },
      project: {
        ...window.electron?.project,
        getSettings: vi.fn(async () => ({ ...settingsFile })),
        saveSettings,
        onSwitch: vi.fn(() => () => {}),
      },
      system: { ...window.electron?.system, openInEditor: vi.fn() },
      helpAssistant: { getSettings: vi.fn().mockResolvedValue({ daintreeControl: false }) },
      mcpServer: {
        ...mcp,
        listActiveClients: vi.fn().mockResolvedValue([]),
        getConfigSnippet: vi.fn().mockResolvedValue(""),
        getLogRecords: vi.fn().mockResolvedValue([]),
        getAuditConfig: vi.fn().mockResolvedValue({ enabled: true, maxRecords: 500 }),
        getAuditStats: vi.fn().mockResolvedValue({
          auth401Count: 0,
          anomalySignals: [],
          anomalySuppressed: true,
          anomalyRecordFloor: 50,
        }),
        getTurnOutcomeRecords: vi.fn().mockResolvedValue([]),
        onRuntimeStateChanged: vi.fn().mockReturnValue(vi.fn()),
        listActiveBearers: vi.fn().mockResolvedValue([]),
        listHelpSessionBearers: vi.fn().mockResolvedValue([]),
      },
    },
  });
});

afterEach(() => {
  useProjectStore.setState({ currentProject: null, projects: [] });
});

function pressEscape() {
  return act(async () => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  });
}

async function hideWindow() {
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  try {
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
  } finally {
    hidden.mockRestore();
  }
}

async function openOnIntegrations() {
  const onClose = vi.fn();
  render(<SettingsDialog isOpen onClose={onClose} defaultTab="integrations" />);
  await screen.findByText(/^Saved:/);
  const osRadio = await screen.findByRole("radio", { name: /Use OS default/i });
  await waitFor(() => expect((osRadio as HTMLInputElement).disabled).toBe(false));
  return onClose;
}

async function openOnMcp() {
  const onClose = vi.fn();
  render(<SettingsDialog isOpen onClose={onClose} defaultTab="mcp" />);
  const port = await screen.findByLabelText<HTMLInputElement>(
    "MCP server port",
    {},
    { timeout: 5_000 }
  );
  await waitFor(() => expect(port.value).toBe("9020"));
  const recordsKept = screen.getByLabelText<HTMLInputElement>("Records kept");
  await waitFor(() => expect(recordsKept.disabled).toBe(false));
  return onClose;
}

function chooseEditor(id: string) {
  fireEvent.change(screen.getByLabelText("Editor"), { target: { value: id } });
}

function chooseCustomViewer(command: string) {
  fireEvent.click(screen.getByRole("radio", { name: /Custom command/i }));
  fireEvent.change(screen.getByRole("textbox", { name: "Command" }), {
    target: { value: command },
  });
}

describe("SettingsDialog closed over an Integrations draft", () => {
  it("saves a pending editor draft for the project, never as the machine default", async () => {
    const onClose = await openOnIntegrations();
    chooseEditor("zed");

    await pressEscape();

    expect(editor.setConfig).toHaveBeenCalledTimes(1);
    expect(editor.setConfig.mock.calls[0]![0]).toMatchObject({
      editor: { id: "zed" },
      projectId: "proj-1",
    });
    expect(editor.setDefault).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("saves a pending image viewer draft for the project", async () => {
    const onClose = await openOnIntegrations();
    chooseCustomViewer("gimp");

    await pressEscape();

    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(settingsFile.preferredImageViewer).toEqual({ mode: "custom", customCommand: "gimp" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps both drafts when the editor and the image viewer are pending together", async () => {
    const onClose = await openOnIntegrations();
    chooseEditor("zed");
    chooseCustomViewer("gimp");

    await pressEscape();

    expect(settingsFile.preferredEditor).toMatchObject({ id: "zed" });
    expect(settingsFile.preferredImageViewer).toEqual({ mode: "custom", customCommand: "gimp" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when the page was only visited", async () => {
    settingsFile = { runCommands: [] };
    editor.getConfig.mockResolvedValue({
      preferredEditor: null,
      defaultEditor: { id: "zed" },
      discoveredEditors: [{ id: "zed", available: true, executablePath: "/usr/bin/zed" }],
    });
    const onClose = vi.fn();
    render(<SettingsDialog isOpen onClose={onClose} defaultTab="integrations" />);
    await screen.findByText(/^Using default:/);
    await screen.findByText(/^Not saved yet — images open/);

    await pressEscape();

    expect(editor.setConfig).not.toHaveBeenCalled();
    expect(saveSettings).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open on the empty command a custom editor needs", async () => {
    const onClose = await openOnIntegrations();
    chooseEditor("custom");

    await pressEscape();

    expect(onClose).not.toHaveBeenCalled();
    expect(editor.setConfig).not.toHaveBeenCalled();
    expect(screen.getByText("Enter the command that opens your editor")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Command" }));
  });

  it("stays open on the empty command a custom image viewer needs", async () => {
    const onClose = await openOnIntegrations();
    chooseCustomViewer("");

    await pressEscape();

    expect(onClose).not.toHaveBeenCalled();
    expect(saveSettings).not.toHaveBeenCalled();
    expect(screen.getByText("Enter the command that opens images")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Command" }));
  });

  it("stays open with the error when the editor save fails", async () => {
    editor.setConfig.mockRejectedValue(new Error("Read-only file system"));
    const onClose = await openOnIntegrations();
    chooseEditor("zed");

    await pressEscape();

    expect(onClose).not.toHaveBeenCalled();
    expect(await screen.findByText(/Read-only file system/)).toBeTruthy();
  });

  it("stays open with the error when the image viewer save fails", async () => {
    saveSettings.mockRejectedValue(new Error("Read-only file system"));
    const onClose = await openOnIntegrations();
    chooseCustomViewer("gimp");

    await pressEscape();

    expect(onClose).not.toHaveBeenCalled();
    expect(await screen.findByText(/Read-only file system/)).toBeTruthy();
  });
});

describe("SettingsDialog holding a close on an Integrations draft", () => {
  it("comes back to the page and its field from another tab", async () => {
    const onClose = await openOnIntegrations();
    chooseEditor("custom");
    const command = screen.getByRole("textbox", { name: "Command" });
    await act(async () => {
      fireEvent.click(document.getElementById("settings-tab-general")!);
    });
    expect(document.getElementById("settings-panel-integrations")!.classList).toContain("hidden");

    await pressEscape();

    expect(onClose).not.toHaveBeenCalled();
    expect(document.getElementById("settings-panel-integrations")!.classList).not.toContain(
      "hidden"
    );
    expect(document.activeElement).toBe(command);
  });

  it("closes once the draft is discarded, having written nothing", async () => {
    editor.setConfig.mockRejectedValue(new Error("Read-only file system"));
    const onClose = await openOnIntegrations();
    chooseEditor("zed");
    await pressEscape();
    expect(onClose).not.toHaveBeenCalled();
    editor.setConfig.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await pressEscape();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(editor.setConfig).not.toHaveBeenCalled();
  });

  it("saves the draft on a hide without closing or moving anything, as other pages do", async () => {
    const onClose = await openOnIntegrations();
    chooseEditor("zed");

    await hideWindow();

    expect(editor.setConfig).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("SettingsDialog hidden over an MCP draft", () => {
  it("applies nothing until the close", async () => {
    const onClose = await openOnMcp();
    fireEvent.change(screen.getByLabelText("MCP server port"), { target: { value: "9021" } });
    fireEvent.change(screen.getByLabelText("Records kept"), { target: { value: "50" } });

    await hideWindow();

    expect(mcp.setPort).not.toHaveBeenCalled();
    expect(mcp.setAuditMaxRecords).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    await pressEscape();

    expect(mcp.setPort).toHaveBeenCalledWith(9021);
    expect(mcp.setAuditMaxRecords).toHaveBeenCalledWith(50);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("SettingsDialog closed over an MCP draft", () => {
  it("applies a pending port and cap", async () => {
    const onClose = await openOnMcp();
    fireEvent.change(screen.getByLabelText("MCP server port"), { target: { value: "9021" } });
    fireEvent.change(screen.getByLabelText("Records kept"), { target: { value: "800" } });

    await pressEscape();

    expect(mcp.setPort).toHaveBeenCalledWith(9021);
    expect(mcp.setAuditMaxRecords).toHaveBeenCalledWith(800);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open on an out-of-range port and still applies a valid cap", async () => {
    const onClose = await openOnMcp();
    fireEvent.change(screen.getByLabelText("MCP server port"), { target: { value: "80" } });
    fireEvent.change(screen.getByLabelText("Records kept"), { target: { value: "800" } });

    await pressEscape();

    expect(onClose).not.toHaveBeenCalled();
    expect(mcp.setPort).not.toHaveBeenCalled();
    expect(mcp.setAuditMaxRecords).toHaveBeenCalledWith(800);
    expect(screen.getByText("Enter a port between 1024 and 65535")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("MCP server port"));
  });

  it("stays open on a cap out of range, on its field", async () => {
    const onClose = await openOnMcp();
    fireEvent.change(screen.getByLabelText("Records kept"), { target: { value: "1" } });

    await pressEscape();

    expect(onClose).not.toHaveBeenCalled();
    expect(mcp.setAuditMaxRecords).not.toHaveBeenCalled();
    expect(screen.getByText(/^Enter a number between/)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("Records kept"));
  });

  it("stays open with the error when applying the port fails", async () => {
    mcp.setPort.mockRejectedValue(new Error("Read-only file system"));
    const onClose = await openOnMcp();
    fireEvent.change(screen.getByLabelText("MCP server port"), { target: { value: "9021" } });

    await pressEscape();

    expect(onClose).not.toHaveBeenCalled();
    expect(await screen.findByText(/Read-only file system/)).toBeTruthy();
  });

  it("closes without applying anything when the page was only visited", async () => {
    const onClose = await openOnMcp();

    await pressEscape();

    expect(mcp.setPort).not.toHaveBeenCalled();
    expect(mcp.setAuditMaxRecords).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
