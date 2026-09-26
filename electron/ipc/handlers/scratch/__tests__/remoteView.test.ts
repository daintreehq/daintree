import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs/promises";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
  app: {
    getPath: vi.fn().mockReturnValue(os.tmpdir()),
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

const scratchStoreMock = vi.hoisted(() => ({
  getAllScratches: vi.fn(() => []),
  getCurrentScratch: vi.fn<() => unknown>(() => null),
  getScratchById: vi.fn<(id: string) => unknown>(),
  createScratch: vi.fn(),
  updateScratch: vi.fn<(id: string, updates: Record<string, unknown>) => unknown>(),
  removeScratch: vi.fn(),
  setCurrentScratch: vi.fn(),
}));
vi.mock("../../../../services/ScratchStore.js", () => ({ scratchStore: scratchStoreMock }));

const projectStoreMock = vi.hoisted(() => ({
  clearCurrentProject: vi.fn(),
  getCurrentProjectId: vi.fn(() => null),
}));
vi.mock("../../../../services/ProjectStore.js", () => ({ projectStore: projectStoreMock }));

const addProjectByPathMock = vi.hoisted(() => vi.fn());
vi.mock("../../projectCrud/crud.js", () => ({ addProjectByPath: addProjectByPathMock }));

const gitInitMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../../../utils/hardenedGit.js", () => ({
  createHardenedGit: vi.fn(async () => ({ init: gitInitMock })),
}));

const scheduleOpenWindowsSaveMock = vi.hoisted(() => vi.fn());
vi.mock("../../../../window/openWindowsTracker.js", () => ({
  scheduleOpenWindowsSave: scheduleOpenWindowsSaveMock,
}));
const refreshProjectMenuStateMock = vi.hoisted(() => vi.fn());
vi.mock("../../../../projectMenuState.js", () => ({
  refreshProjectMenuState: refreshProjectMenuStateMock,
}));

const broadcastMock = vi.hoisted(() => ({ broadcastToRenderer: vi.fn() }));
vi.mock("../../../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../utils.js")>();
  return { ...actual, broadcastToRenderer: broadcastMock.broadcastToRenderer };
});

import { dialog } from "electron";
import { CHANNELS } from "../../../channels.js";
import { _resetIpcDispatcherForTesting, getIpcDispatcher } from "../../../dispatcher.js";
import { wrapError, wrapSuccess } from "../../../../../shared/utils/ipcErrorSerialization.js";
import type { HandlerDependencies } from "../../../types.js";
import { registerScratchHandlers } from "../index.js";

const SCRATCH_ID = "11111111-1111-4111-8111-111111111111";

let tmp: string;
let scratchDir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "scratch-remote-")));
  scratchDir = path.join(tmp, "scratches", SCRATCH_ID);
  await fs.mkdir(scratchDir, { recursive: true });
  await fs.writeFile(path.join(scratchDir, "notes.md"), "hello");
  scratchStoreMock.getScratchById.mockImplementation((id) =>
    id === SCRATCH_ID ? { id, name: "Try", path: scratchDir, lastOpened: 1 } : null
  );
  scratchStoreMock.updateScratch.mockImplementation((id, updates) => ({
    id,
    name: "Try",
    path: scratchDir,
    ...updates,
  }));
});

afterEach(async () => {
  _resetIpcDispatcherForTesting();
  await fs.rm(tmp, { recursive: true, force: true });
});

/** A call as it arrives from a view on a remote Shell bound to `projectId`. */
async function invokeOverLink(channel: string, args: unknown[], projectId: string | null) {
  _resetIpcDispatcherForTesting();
  const dispatcher = getIpcDispatcher();
  dispatcher.setInvokeEnveloper(async (_channel, _args, call) => {
    try {
      return wrapSuccess(await call());
    } catch (error) {
      return wrapError(error);
    }
  });
  const releases = [CHANNELS.SCRATCH_SWITCH, CHANNELS.SCRATCH_SAVE_AS_PROJECT].map((c) =>
    dispatcher.allowHybridOverLink(c)
  );
  const pvm = { switchTo: vi.fn(), setPendingFocusIntent: vi.fn() };
  const ptyClient = { onProjectSwitch: vi.fn() };
  const deps = {
    projectViewManager: pvm,
    ptyClient,
    mainWindow: { id: 1 },
  } as unknown as HandlerDependencies;
  const cleanup = registerScratchHandlers(deps);
  const endpoint = {
    endpointId: "s1:view-1",
    clientId: "client-1",
    projectId,
    kind: "remote-view" as const,
    handle: -7,
    send: vi.fn(),
    request: vi.fn(),
    onClose: vi.fn(() => ({ dispose: () => undefined })),
    isClosed: () => false,
  };
  const envelope = await dispatcher.invokeForEndpoint(
    { endpoint, client: { clientId: "client-1", kind: "remote" } as never },
    channel,
    args
  );
  for (const release of releases) release();
  cleanup();
  return { envelope, pvm, ptyClient };
}

describe("scratch handlers for a view on a remote Shell", () => {
  it("switch marks the scratch opened and leaves this machine's windows and pointers alone", async () => {
    const { envelope, pvm, ptyClient } = await invokeOverLink(
      CHANNELS.SCRATCH_SWITCH,
      [SCRATCH_ID, { focusIntent: { intent: "focus-panel", panelId: "t1" } }],
      "p-left"
    );

    expect(envelope).toMatchObject({ ok: true, data: { id: SCRATCH_ID, path: scratchDir } });
    expect(scratchStoreMock.updateScratch).toHaveBeenCalledWith(SCRATCH_ID, {
      lastOpened: expect.any(Number),
    });
    expect(pvm.switchTo).not.toHaveBeenCalled();
    expect(pvm.setPendingFocusIntent).not.toHaveBeenCalled();
    expect(scratchStoreMock.setCurrentScratch).not.toHaveBeenCalled();
    expect(projectStoreMock.clearCurrentProject).not.toHaveBeenCalled();
    expect(ptyClient.onProjectSwitch).not.toHaveBeenCalled();
    expect(scheduleOpenWindowsSaveMock).not.toHaveBeenCalled();
    expect(broadcastMock.broadcastToRenderer).toHaveBeenCalledWith(
      CHANNELS.SCRATCH_UPDATED,
      expect.objectContaining({ id: SCRATCH_ID, lastOpened: expect.any(Number) })
    );
    expect(broadcastMock.broadcastToRenderer).not.toHaveBeenCalledWith(
      CHANNELS.SCRATCH_ON_SWITCH,
      expect.anything()
    );
  });

  it("switch refuses a scratch this host doesn't have", async () => {
    const { envelope } = await invokeOverLink(CHANNELS.SCRATCH_SWITCH, ["nope"], null);
    expect(envelope).toMatchObject({ ok: false });
    expect(scratchStoreMock.updateScratch).not.toHaveBeenCalled();
  });

  it("get-current answers the view's own scratch, not this machine's pointer", async () => {
    scratchStoreMock.getCurrentScratch.mockReturnValue({ id: "someone-elses" });
    const onScratch = await invokeOverLink(CHANNELS.SCRATCH_GET_CURRENT, [], SCRATCH_ID);
    expect(onScratch.envelope).toMatchObject({ ok: true, data: { id: SCRATCH_ID } });
    const onProject = await invokeOverLink(CHANNELS.SCRATCH_GET_CURRENT, [], "p1");
    expect(onProject.envelope).toEqual(wrapSuccess(null));
    expect(scratchStoreMock.getCurrentScratch).not.toHaveBeenCalled();
  });

  it("save-as-project copies into the folder the Shell chose and registers it, with no dialog here", async () => {
    const destination = path.join(tmp, "work", "Try");
    addProjectByPathMock.mockResolvedValue({ id: "p9", name: "Try", path: destination });

    const { envelope } = await invokeOverLink(
      CHANNELS.SCRATCH_SAVE_AS_PROJECT,
      [SCRATCH_ID, destination],
      SCRATCH_ID
    );

    expect(envelope).toMatchObject({
      ok: true,
      data: { status: "saved", project: { id: "p9" }, destinationPath: destination },
    });
    expect(dialog.showOpenDialog).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(destination, "notes.md"), "utf8")).resolves.toBe("hello");
    expect(gitInitMock).toHaveBeenCalled();
    expect(addProjectByPathMock).toHaveBeenCalledWith(destination);
  });

  it("save-as-project refuses without a destination rather than opening a dialog on this machine", async () => {
    const { envelope } = await invokeOverLink(
      CHANNELS.SCRATCH_SAVE_AS_PROJECT,
      [SCRATCH_ID],
      SCRATCH_ID
    );
    expect(envelope).toMatchObject({ ok: false });
    expect(dialog.showOpenDialog).not.toHaveBeenCalled();
    expect(addProjectByPathMock).not.toHaveBeenCalled();
  });

  it("save-as-project keeps the host's own guards: never inside the scratch", async () => {
    const { envelope } = await invokeOverLink(
      CHANNELS.SCRATCH_SAVE_AS_PROJECT,
      [SCRATCH_ID, path.join(scratchDir, "nested")],
      SCRATCH_ID
    );
    expect(envelope).toMatchObject({ ok: false });
    expect(addProjectByPathMock).not.toHaveBeenCalled();
  });
});
