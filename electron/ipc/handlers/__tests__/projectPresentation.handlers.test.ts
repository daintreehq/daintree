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

const storeMock = vi.hoisted(() => {
  const data = new Map<string, unknown>();
  return {
    data,
    get: vi.fn((key: string) => data.get(key)),
    set: vi.fn((key: string, value: unknown) => {
      data.set(key, value);
    }),
  };
});

const projectStoreMock = vi.hoisted(() => ({
  getProjectById: vi.fn<(id: string) => { path: string } | undefined>(() => undefined),
}));

const readSuggestionMock = vi.hoisted(() => vi.fn<(root: unknown) => Promise<unknown>>());

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
vi.mock("../../../store.js", () => ({ store: storeMock }));
vi.mock("../../../services/ProjectStore.js", () => ({ projectStore: projectStoreMock }));
vi.mock("../../../services/projectPresentation/repoSuggestion.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../services/projectPresentation/repoSuggestion.js")
    >();
  return { ...actual, readPresentationSuggestion: readSuggestionMock };
});

import { CHANNELS } from "../../channels.js";
import { registerProjectPresentationHandlers } from "../projectPresentation.js";
import { hashPresentationLevels } from "../../../services/projectPresentation/repoSuggestion.js";
import type { ProjectPresentationSnapshot } from "../../../../shared/types/ipc/projectPresentation.js";

const PROJECT_A = "a".repeat(64);

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

const HIDDEN = { forgeStats: "hidden" } as const;

let cleanup: (() => void) | null = null;

beforeEach(() => {
  ipcHandlers.clear();
  vi.clearAllMocks();
  storeMock.data.clear();
  registryMock.getProjectForWebContents.mockReturnValue(PROJECT_A);
  projectStoreMock.getProjectById.mockReturnValue({ path: "/repo" });
  readSuggestionMock.mockResolvedValue({ levels: HIDDEN, hash: hashPresentationLevels(HIDDEN) });
  cleanup = registerProjectPresentationHandlers();
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe("project-presentation:get", () => {
  it("answers for the sender's own project, with the repository's suggestion", async () => {
    const snapshot = (await invoke("project-presentation:get")) as ProjectPresentationSnapshot;

    expect(readSuggestionMock).toHaveBeenCalledWith("/repo");
    expect(snapshot).toEqual({
      projectId: PROJECT_A,
      levels: {},
      suggestion: { levels: HIDDEN, hash: hashPresentationLevels(HIDDEN) },
      suggestionAnswer: null,
      revision: 0,
    });
  });

  it("answers null for a sender not bound to a project yet, rather than an empty profile", async () => {
    registryMock.getProjectForWebContents.mockReturnValue(null);
    await expect(invoke("project-presentation:get")).resolves.toBeNull();
    expect(readSuggestionMock).not.toHaveBeenCalled();
  });
});

describe("project-presentation:set-level", () => {
  it("records the level and tells every view of the project", async () => {
    const snapshot = (await invoke(
      "project-presentation:set-level",
      "forgeStats",
      "demoted"
    )) as ProjectPresentationSnapshot;

    expect(snapshot.levels).toEqual({ forgeStats: "demoted" });
    expect(snapshot.revision).toBe(1);
    expect(broadcastMock).toHaveBeenCalledWith(
      PROJECT_A,
      CHANNELS.PROJECT_PRESENTATION_CHANGED,
      snapshot
    );
  });

  it("never publishes an older profile after a newer one when two writes interleave", async () => {
    const reads: Array<(value: unknown) => void> = [];
    readSuggestionMock.mockImplementation(() => new Promise((resolve) => reads.push(resolve)));

    const first = invoke("project-presentation:set-level", "forgeStats", "demoted");
    const second = invoke("project-presentation:set-level", "forgeStats", "hidden");
    // The second write's file read finishes first.
    reads[1]!(null);
    await second;
    reads[0]!(null);
    await first;

    const published = broadcastMock.mock.calls.map(
      ([, , snapshot]) => snapshot as ProjectPresentationSnapshot
    );
    expect(published.map((s) => [s.revision, s.levels.forgeStats])).toEqual([
      [2, "hidden"],
      [2, "hidden"],
    ]);
  });

  it("refuses a feature outside the vocabulary and a level the feature does not offer", async () => {
    await expect(
      invoke("project-presentation:set-level", "agentState", "hidden")
    ).rejects.toThrow();
    await expect(invoke("project-presentation:set-level", "forgeStats", "gone")).rejects.toThrow();
    expect(storeMock.set).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it("refuses a sender with no project", async () => {
    registryMock.getProjectForWebContents.mockReturnValue(null);
    await expect(
      invoke("project-presentation:set-level", "forgeStats", "hidden")
    ).rejects.toThrow();
    expect(storeMock.set).not.toHaveBeenCalled();
  });
});

describe("project-presentation:answer-suggestion", () => {
  it("accepts what the file suggests now and copies it into the profile", async () => {
    const snapshot = (await invoke(
      "project-presentation:answer-suggestion",
      hashPresentationLevels(HIDDEN),
      "accepted"
    )) as ProjectPresentationSnapshot;

    expect(snapshot.levels).toEqual(HIDDEN);
    expect(snapshot.suggestionAnswer).toMatchObject({
      hash: hashPresentationLevels(HIDDEN),
      answer: "accepted",
    });
    expect(broadcastMock).toHaveBeenCalledOnce();
  });

  it("refuses an answer about a suggestion the file has since changed", async () => {
    const demoted = { forgeStats: "demoted" } as const;
    await expect(
      invoke("project-presentation:answer-suggestion", hashPresentationLevels(demoted), "accepted")
    ).rejects.toThrow();
    expect(storeMock.set).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});
