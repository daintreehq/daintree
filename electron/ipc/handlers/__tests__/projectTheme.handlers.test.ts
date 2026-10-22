import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));

// `buildIpcContext` resolves the sender's project through the registry.
const registryMock = vi.hoisted(() => ({
  getProjectForWebContents: vi.fn<(id: number) => string | null>(() => null),
  getWindowForWebContents: vi.fn<() => { id: number } | null>(() => null),
}));

const broadcastMock = vi.hoisted(() => vi.fn());
const repaintMock = vi.hoisted(() => vi.fn());

const storeState = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));

const projectStoreMock = vi.hoisted(() => ({
  getProjectById: vi.fn<(id: string) => { path: string } | undefined>(() => undefined),
  readInRepoProjectIdentity: vi.fn<(path: string) => Promise<{ theme?: string; found: boolean }>>(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
}));
vi.mock("../../../window/webContentsRegistry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../window/webContentsRegistry.js")>();
  return { ...actual, ...registryMock };
});
vi.mock("../../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils.js")>();
  return { ...actual, broadcastToProjectRenderers: broadcastMock };
});
vi.mock("../../../window/projectThemeChrome.js", () => ({ repaintAllWindowThemes: repaintMock }));
vi.mock("../../../store.js", () => ({
  store: {
    get: vi.fn((key: string) => storeState.data[key]),
    set: vi.fn((key: string, value: unknown) => {
      const [root, field] = key.split(".") as [string, string | undefined];
      if (field === undefined) {
        storeState.data[root] = value;
        return;
      }
      storeState.data[root] = { ...(storeState.data[root] as object), [field]: value };
    }),
  },
}));
vi.mock("../../../services/ProjectStore.js", () => ({ projectStore: projectStoreMock }));

import { CHANNELS } from "../../channels.js";
import { registerProjectThemeHandlers } from "../projectTheme.js";
import type { ProjectThemeSnapshot } from "../../../../shared/types/ipc/projectTheme.js";

const PROJECT_A = "a".repeat(64);
const SUGGESTED = "bondi";

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = ipcHandlers.get(channel);
  if (!fn) throw new Error(`${channel} not registered`);
  const event = {
    sender: { id: 7 },
    senderFrame: { routingId: 1 },
  } as unknown as Electron.IpcMainInvokeEvent;
  return (fn as Handler)(event, ...args);
}

let cleanup: (() => void) | null = null;

beforeEach(() => {
  ipcHandlers.clear();
  vi.clearAllMocks();
  storeState.data = { appTheme: { colorSchemeId: "daintree" } };
  registryMock.getProjectForWebContents.mockReturnValue(PROJECT_A);
  projectStoreMock.getProjectById.mockReturnValue({ path: "/repo" });
  projectStoreMock.readInRepoProjectIdentity.mockResolvedValue({ found: true, theme: SUGGESTED });
  cleanup = registerProjectThemeHandlers();
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe("project-theme:get", () => {
  it("answers for the sender's own project, with the repository's suggestion", async () => {
    const snapshot = (await invoke("project-theme:get")) as ProjectThemeSnapshot;
    expect(projectStoreMock.readInRepoProjectIdentity).toHaveBeenCalledWith("/repo");
    expect(snapshot).toEqual({ projectId: PROJECT_A, choice: null, suggestedSchemeId: SUGGESTED });
  });

  it("answers null for a sender not bound to a project yet", async () => {
    registryMock.getProjectForWebContents.mockReturnValue(null);
    await expect(invoke("project-theme:get")).resolves.toBeNull();
  });

  it("treats an unreadable project.json as no suggestion", async () => {
    projectStoreMock.readInRepoProjectIdentity.mockRejectedValue(new Error("EACCES"));
    const snapshot = (await invoke("project-theme:get")) as ProjectThemeSnapshot;
    expect(snapshot.suggestedSchemeId).toBeNull();
  });
});

describe("project-theme:set-theme", () => {
  it("stores the sender project's theme, tells its views and repaints", async () => {
    const snapshot = (await invoke("project-theme:set-theme", "bondi")) as ProjectThemeSnapshot;
    expect(snapshot.choice).toEqual({ colorSchemeId: "bondi" });
    expect(broadcastMock).toHaveBeenCalledWith(PROJECT_A, CHANNELS.PROJECT_THEME_CHANGED, {
      projectId: PROJECT_A,
      choice: { colorSchemeId: "bondi" },
    });
    expect(repaintMock).toHaveBeenCalled();
    // The global selection is the user's default and stays put.
    expect((storeState.data.appTheme as Record<string, unknown>).colorSchemeId).toBe("daintree");
  });

  it("follows the global theme again with null", async () => {
    await invoke("project-theme:set-theme", "bondi");
    const snapshot = (await invoke("project-theme:set-theme", null)) as ProjectThemeSnapshot;
    expect(snapshot.choice).toBeNull();
  });

  it("refuses a sender with no project", async () => {
    registryMock.getProjectForWebContents.mockReturnValue(null);
    await expect(invoke("project-theme:set-theme", "bondi")).rejects.toThrow();
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it("refuses a theme that doesn't exist", async () => {
    await expect(invoke("project-theme:set-theme", "no-such-theme")).rejects.toThrow();
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});

describe("project-theme:answer-suggestion", () => {
  it("accepting applies the suggestion and remembers the answer", async () => {
    const snapshot = (await invoke(
      "project-theme:answer-suggestion",
      SUGGESTED,
      "accepted"
    )) as ProjectThemeSnapshot;
    expect(snapshot.choice).toEqual({
      colorSchemeId: SUGGESTED,
      suggestionAnswer: { schemeId: SUGGESTED, answer: "accepted" },
    });
    expect(broadcastMock).toHaveBeenCalledTimes(1);
  });

  it("declining changes nothing but the answer", async () => {
    const snapshot = (await invoke(
      "project-theme:answer-suggestion",
      SUGGESTED,
      "declined"
    )) as ProjectThemeSnapshot;
    expect(snapshot.choice).toEqual({
      suggestionAnswer: { schemeId: SUGGESTED, answer: "declined" },
    });
  });

  it("refuses an answer about a theme the repository no longer suggests", async () => {
    projectStoreMock.readInRepoProjectIdentity.mockResolvedValue({ found: true, theme: "daintree" });
    await expect(
      invoke("project-theme:answer-suggestion", SUGGESTED, "accepted")
    ).rejects.toThrow();
    expect(storeState.data.appTheme).toEqual({ colorSchemeId: "daintree" });
  });

  it("refuses an answer that is neither accept nor decline", async () => {
    await expect(invoke("project-theme:answer-suggestion", SUGGESTED, "maybe")).rejects.toThrow();
  });
});

describe("a remote view (host-scoped key)", () => {
  it("stores the choice under the bare project id and reaches the remote view's own key", async () => {
    registryMock.getProjectForWebContents.mockReturnValue(`host-1:${PROJECT_A}`);
    const snapshot = (await invoke("project-theme:set-theme", "bondi")) as ProjectThemeSnapshot;

    expect(snapshot.projectId).toBe(PROJECT_A);
    const change = { projectId: PROJECT_A, choice: { colorSchemeId: "bondi" } };
    expect(broadcastMock).toHaveBeenCalledWith(PROJECT_A, CHANNELS.PROJECT_THEME_CHANGED, change);
    expect(broadcastMock).toHaveBeenCalledWith(
      `host-1:${PROJECT_A}`,
      CHANNELS.PROJECT_THEME_CHANGED,
      change
    );
  });

  it("offers no suggestion: the repository lives on the host, not here", async () => {
    registryMock.getProjectForWebContents.mockReturnValue(`host-1:${PROJECT_A}`);
    const snapshot = (await invoke("project-theme:get")) as ProjectThemeSnapshot;
    expect(snapshot.suggestedSchemeId).toBeNull();
    expect(projectStoreMock.readInRepoProjectIdentity).not.toHaveBeenCalled();
  });
});

describe("project-theme:reset-suggestion", () => {
  it("forgets the answer and keeps the theme", async () => {
    await invoke("project-theme:answer-suggestion", SUGGESTED, "accepted");
    const snapshot = (await invoke("project-theme:reset-suggestion")) as ProjectThemeSnapshot;
    expect(snapshot.choice).toEqual({ colorSchemeId: SUGGESTED });
  });
});
