import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));

const projectStoreMock = vi.hoisted(() => ({
  getProjectSettings: vi.fn(),
  saveProjectSettings: vi.fn(),
}));

const discoverMock = vi.hoisted(() =>
  vi.fn<() => Array<{ id: string; name: string; available: boolean }>>(() => [])
);

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));
vi.mock("../../../services/ProjectStore.js", () => ({ projectStore: projectStoreMock }));
vi.mock("../../../services/EditorService.js", () => ({ discover: discoverMock }));

import { registerEditorConfigHandlers } from "../editorConfig.js";
import { CHANNELS } from "../../channels.js";
import type { HandlerDependencies } from "../../types.js";

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

function getHandler(channel: string): Handler {
  const fn = ipcHandlers.get(channel);
  if (!fn) throw new Error(`handler not registered: ${channel}`);
  return fn as Handler;
}

function fakeEvent(): Electron.IpcMainInvokeEvent {
  return { sender: {} as Electron.WebContents } as Electron.IpcMainInvokeEvent;
}

describe("editorConfig IPC adversarial", () => {
  let cleanup: () => void;

  beforeEach(() => {
    ipcHandlers.clear();
    vi.clearAllMocks();
    projectStoreMock.getProjectSettings.mockResolvedValue({});
    projectStoreMock.saveProjectSettings.mockResolvedValue(undefined);
    cleanup = registerEditorConfigHandlers({} as HandlerDependencies);
  });

  afterEach(() => {
    cleanup();
  });

  it("setConfig strips customCommand/customTemplate when id is not 'custom'", async () => {
    await getHandler(CHANNELS.EDITOR_SET_CONFIG)(fakeEvent(), {
      projectId: "p1",
      editor: {
        id: "vscode",
        customCommand: "leftover",
        customTemplate: "{file}",
      },
    });

    const saved = projectStoreMock.saveProjectSettings.mock.calls[0][1] as {
      preferredEditor: { id: string; customCommand?: string; customTemplate?: string };
    };
    expect(saved.preferredEditor.id).toBe("vscode");
    expect(saved.preferredEditor.customCommand).toBeUndefined();
    expect(saved.preferredEditor.customTemplate).toBeUndefined();
  });

  it("setConfig rejects custom editor with whitespace-only customCommand", async () => {
    await expect(
      getHandler(CHANNELS.EDITOR_SET_CONFIG)(fakeEvent(), {
        projectId: "p1",
        editor: { id: "custom", customCommand: "   ", customTemplate: "{file}" },
      })
    ).rejects.toThrow(/customCommand/);
    expect(projectStoreMock.saveProjectSettings).not.toHaveBeenCalled();
  });

  it("setConfig rejects custom editor with empty-string customCommand", async () => {
    await expect(
      getHandler(CHANNELS.EDITOR_SET_CONFIG)(fakeEvent(), {
        projectId: "p1",
        editor: { id: "custom", customCommand: "", customTemplate: "{file}" },
      })
    ).rejects.toThrow(/customCommand/);
  });

  it("setConfig rejects unknown editor id", async () => {
    await expect(
      getHandler(CHANNELS.EDITOR_SET_CONFIG)(fakeEvent(), {
        projectId: "p1",
        editor: { id: "not-an-editor" },
      })
    ).rejects.toThrow(/Invalid editor id/);
  });

  it("setConfig rejects customCommand > 512 chars", async () => {
    await expect(
      getHandler(CHANNELS.EDITOR_SET_CONFIG)(fakeEvent(), {
        projectId: "p1",
        editor: { id: "custom", customCommand: "x".repeat(513), customTemplate: "{file}" },
      })
    ).rejects.toThrow(/customCommand/);
  });

  it("setConfig rejects when projectId is missing", async () => {
    await expect(
      getHandler(CHANNELS.EDITOR_SET_CONFIG)(fakeEvent(), {
        editor: { id: "vscode" },
      })
    ).rejects.toThrow(/projectId/);
  });

  it("setConfig rejects when projectId is not a string", async () => {
    await expect(
      getHandler(CHANNELS.EDITOR_SET_CONFIG)(fakeEvent(), {
        editor: { id: "vscode" },
        projectId: 42,
      })
    ).rejects.toThrow(/projectId/);
  });

  it("getConfig returns { preferredEditor: null, discoveredEditors } when settings read throws", async () => {
    projectStoreMock.getProjectSettings.mockRejectedValue(new Error("store down"));
    discoverMock.mockReturnValue([{ id: "vscode", name: "VS Code", available: true }]);

    const result = (await getHandler(CHANNELS.EDITOR_GET_CONFIG)(fakeEvent(), "p1")) as {
      preferredEditor: unknown;
      discoveredEditors: Array<{ id: string }>;
    };

    expect(result.preferredEditor).toBeNull();
    expect(result.discoveredEditors).toHaveLength(1);
  });

  it("getConfig returns null preferredEditor when projectId is missing or not a string", async () => {
    discoverMock.mockReturnValue([]);

    const noProject = (await getHandler(CHANNELS.EDITOR_GET_CONFIG)(fakeEvent())) as {
      preferredEditor: unknown;
    };
    const wrongType = (await getHandler(CHANNELS.EDITOR_GET_CONFIG)(fakeEvent(), 42)) as {
      preferredEditor: unknown;
    };

    expect(noProject.preferredEditor).toBeNull();
    expect(wrongType.preferredEditor).toBeNull();
    expect(projectStoreMock.getProjectSettings).not.toHaveBeenCalled();
  });

  it("cleanup removes all three handlers", () => {
    expect(ipcHandlers.size).toBe(3);
    cleanup();
    expect(ipcHandlers.size).toBe(0);
  });
});
