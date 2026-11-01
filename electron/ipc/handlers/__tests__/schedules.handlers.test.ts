import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IpcContext } from "../../types.js";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));
const withheldMock = vi.hoisted(() =>
  vi.fn<(webContentsId: number, channel: string, args: unknown[]) => boolean>(() => false)
);
const projectStoreMock = vi.hoisted(() => ({
  getProjectById: vi.fn<(id: string) => { id: string; path: string } | null>(() => null),
  schedules: null as unknown,
}));
const viewsMock = vi.hoisted(() => ({
  getRegisteredProjectViews: vi.fn<
    () => Array<{ webContents: { id: number; send: ReturnType<typeof vi.fn> }; projectId: string }>
  >(() => []),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock, app: { getPath: () => os.tmpdir() } }));
vi.mock("../../utils.js", async (importActual) => ({
  ...(await importActual<object>()),
  isWithheldFromView: withheldMock,
}));
vi.mock("../../../services/ProjectStore.js", () => ({ projectStore: projectStoreMock }));
vi.mock("../../../window/webContentsRegistry.js", () => viewsMock);

import { CHANNELS } from "../../channels.js";
import { registerSchedulesHandlers, schedulesNamespace } from "../schedules.js";
import { ScheduleStore } from "../../../services/ScheduleStore.js";
import { encodeSchedulesFile } from "../../../services/schedulesCodec.js";
import { createSchedule } from "../../../../shared/utils/scheduledRuns.js";
import { toHostScopedKey } from "../../../../shared/types/remoteHosts.js";
import type {
  ScheduleCreateInput,
  ScheduleCreateOutcome,
  ScheduleRemoveOutcome,
  ScheduleSetEnabledOutcome,
  ScheduleUpdateOutcome,
  ScheduleUpdatePatch,
  SchedulesSnapshot,
} from "../../../../shared/types/ipc/schedules.js";

const PROJECT = "a".repeat(64);
const OTHER = "b".repeat(64);
const PROMPT = "Read the failing tests and fix them. SECRET-MARKER";

type ListHandler = (ctx: IpcContext) => Promise<SchedulesSnapshot | null>;
type CreateHandler = (
  ctx: IpcContext,
  input: ScheduleCreateInput
) => Promise<ScheduleCreateOutcome>;
type UpdateHandler = (
  ctx: IpcContext,
  scheduleId: string,
  expectedUpdatedAt: number,
  patch: ScheduleUpdatePatch
) => Promise<ScheduleUpdateOutcome>;
type SetEnabledHandler = (
  ctx: IpcContext,
  scheduleId: string,
  enabled: boolean
) => Promise<ScheduleSetEnabledOutcome>;
type RemoveHandler = (ctx: IpcContext, scheduleId: string) => Promise<ScheduleRemoveOutcome>;

const list = schedulesNamespace.ops.list.handler as unknown as ListHandler;
const create = schedulesNamespace.ops.create.handler as unknown as CreateHandler;
const update = schedulesNamespace.ops.update.handler as unknown as UpdateHandler;
const setEnabled = schedulesNamespace.ops.setEnabled.handler as unknown as SetEnabledHandler;
const remove = schedulesNamespace.ops.remove.handler as unknown as RemoveHandler;

const input: ScheduleCreateInput = {
  name: "Fix tests",
  launch: { agentId: "claude", prompt: PROMPT },
  timeZone: "UTC",
};

function ctx(
  projectId: string | null,
  endpoint: "local-view" | "remote-view" = "local-view"
): IpcContext {
  return {
    projectId,
    endpoint: { kind: endpoint },
    client: { kind: "local" },
  } as unknown as IpcContext;
}

function view(id: number, projectId: string) {
  return { webContents: { id, send: vi.fn() }, projectId };
}

let root: string;
let repo: string;
let rows: Set<string>;

beforeEach(() => {
  vi.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-schedules-ipc-"));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-schedules-repo-"));
  rows = new Set([PROJECT, OTHER]);
  projectStoreMock.getProjectById.mockImplementation((id) =>
    rows.has(id) ? { id, path: repo } : null
  );
  projectStoreMock.schedules = new ScheduleStore(root, (id) => rows.has(id));
  viewsMock.getRegisteredProjectViews.mockReturnValue([]);
  withheldMock.mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

async function created(): Promise<Extract<ScheduleCreateOutcome, { status: "saved" }>> {
  const outcome = await create(ctx(PROJECT), input);
  if (outcome.status !== "saved") throw new Error(`expected saved, got ${outcome.status}`);
  return outcome;
}

describe("schedules handlers", () => {
  describe("the sender's project", () => {
    it("lists nothing yet for a view not bound to a project", async () => {
      expect(await list(ctx(null))).toBeNull();
      await expect(create(ctx(null), input)).rejects.toMatchObject({ code: "VALIDATION" });
    });

    it("only ever reads and writes the project the sender shows", async () => {
      const { schedule } = await created();

      expect((await list(ctx(PROJECT)))!.schedules).toEqual([schedule]);
      expect((await list(ctx(OTHER)))!.schedules).toEqual([]);
      expect((await remove(ctx(OTHER), schedule.id)).snapshot.schedules).toEqual([]);
      expect((await list(ctx(PROJECT)))!.schedules).toEqual([schedule]);
    });

    it("refuses a project on a remote host and a view attached over a link", async () => {
      const remoteKey = toHostScopedKey("studio", PROJECT);

      await expect(list(ctx(remoteKey))).rejects.toMatchObject({ code: "UNSUPPORTED" });
      await expect(create(ctx(remoteKey), input)).rejects.toMatchObject({ code: "UNSUPPORTED" });
      await expect(list(ctx(PROJECT, "remote-view"))).rejects.toMatchObject({
        code: "UNSUPPORTED",
      });
    });

    it("refuses a scratch, which has no schedules", async () => {
      const scratch = "6f1c1f3e-6c8a-4a39-9a43-1d8f2b9d3c11";
      rows.add(scratch);

      await expect(list(ctx(scratch))).rejects.toMatchObject({ code: "UNSUPPORTED" });
      await expect(create(ctx(scratch), input)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    });

    it("refuses a project that is no longer registered", async () => {
      rows.delete(PROJECT);

      await expect(list(ctx(PROJECT))).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(create(ctx(PROJECT), input)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  it("creates, edits, disables, enables and deletes a schedule", async () => {
    const { schedule } = await created();
    expect(schedule.projectId).toBe(PROJECT);
    expect(schedule.launch.prompt).toBe(PROMPT);

    const edited = await update(ctx(PROJECT), schedule.id, schedule.updatedAt, {
      name: "Fix the tests",
      cadence: { cron: "30 6 * * MON-FRI", timeZone: "UTC" },
    });
    if (edited.status !== "saved") throw new Error(edited.status);
    expect(edited.schedule).toMatchObject({
      name: "Fix the tests",
      cadence: { cron: "30 6 * * MON-FRI", timeZone: "UTC" },
    });

    const off = await setEnabled(ctx(PROJECT), schedule.id, false);
    if (off.status !== "saved") throw new Error(off.status);
    expect(off.schedule.enabled).toBe(false);
    const on = await setEnabled(ctx(PROJECT), schedule.id, true);
    if (on.status !== "saved") throw new Error(on.status);
    expect(on.schedule.enabled).toBe(true);

    expect((await remove(ctx(PROJECT), schedule.id)).snapshot.schedules).toEqual([]);
    expect((await list(ctx(PROJECT)))!.schedules).toEqual([]);
  });

  it("refuses a bad cadence with its reason, naming the cron field", async () => {
    const outcome = await create(ctx(PROJECT), { ...input, cron: "75 * * * *" });

    expect(outcome).toEqual({
      status: "invalid",
      issues: [{ path: "cadence.cron", cronField: "minute", message: expect.any(String) }],
    });
    expect((await list(ctx(PROJECT)))!.schedules).toEqual([]);

    const { schedule } = await created();
    const edit = await update(ctx(PROJECT), schedule.id, schedule.updatedAt, {
      cadence: { cron: "0 9 * * *", timeZone: "+05:00" },
    });
    expect(edit).toEqual({
      status: "invalid",
      issues: [{ path: "cadence.timeZone", cronField: null, message: expect.any(String) }],
    });
  });

  it("answers an edit made from an older version with the newer one", async () => {
    const { schedule } = await created();
    const first = await update(ctx(PROJECT), schedule.id, schedule.updatedAt, { name: "First" });

    const second = await update(ctx(PROJECT), schedule.id, schedule.updatedAt, { name: "Second" });

    expect(first.status).toBe("saved");
    expect(second).toMatchObject({ status: "conflict", schedule: { name: "First" } });
  });

  it("refuses a malformed request without echoing it", async () => {
    const { schedule } = await created();
    const attempts: Array<Promise<unknown>> = [
      create(ctx(PROJECT), { ...input, id: "forged", projectId: OTHER } as never),
      create(ctx(PROJECT), { name: 7, launch: { agentId: "claude", prompt: PROMPT } } as never),
      update(ctx(PROJECT), schedule.id, schedule.updatedAt, { projectId: OTHER } as never),
      update(ctx(PROJECT), schedule.id, schedule.updatedAt, { enabled: false } as never),
      update(ctx(PROJECT), schedule.id, -1, { name: "x" }),
      update(ctx(PROJECT), "", schedule.updatedAt, { name: "x" }),
      setEnabled(ctx(PROJECT), schedule.id, "yes" as never),
      remove(ctx(PROJECT), 42 as never),
    ];

    for (const attempt of attempts) {
      const error = await attempt.then(
        () => null,
        (reason: unknown) => reason
      );
      expect(error).toMatchObject({ code: "VALIDATION" });
      expect(String((error as Error).message)).not.toContain("SECRET-MARKER");
    }
    expect((await list(ctx(PROJECT)))!.schedules).toEqual([schedule]);
  });

  it("never reads a schedule-like file in the project's .daintree directory", async () => {
    const planted = createSchedule(
      {
        id: "planted",
        projectId: PROJECT,
        name: "From the repository",
        launch: { agentId: "claude", prompt: "rm -rf" },
        policies: { runWhenClosed: true },
      },
      Date.now()
    );
    fs.mkdirSync(path.join(repo, ".daintree"), { recursive: true });
    for (const name of ["schedules.json", "schedules"]) {
      fs.writeFileSync(path.join(repo, ".daintree", name), encodeSchedulesFile([planted]));
    }
    const readFile = vi.spyOn(fs.promises, "readFile");

    expect((await list(ctx(PROJECT)))!.schedules).toEqual([]);
    const { snapshot } = await created();

    expect(snapshot.schedules.map((schedule) => schedule.id)).not.toContain("planted");
    const read = readFile.mock.calls.map(([file]) => String(file));
    expect(read).toContain(path.join(root, PROJECT, "schedules.json"));
    expect(read.some((file) => file.startsWith(repo))).toBe(false);
  });

  describe("registration", () => {
    let dispose: (() => void) | null = null;

    afterEach(() => {
      dispose?.();
      dispose = null;
    });

    it("registers every op and tells every local view of the project about each change", async () => {
      const own = view(1, PROJECT);
      const cached = view(2, PROJECT);
      const withheld = view(3, PROJECT);
      const otherProject = view(4, OTHER);
      const remote = view(5, toHostScopedKey("studio", PROJECT));
      viewsMock.getRegisteredProjectViews.mockReturnValue([
        own,
        cached,
        withheld,
        otherProject,
        remote,
      ]);
      withheldMock.mockImplementation((id) => id === 3);
      dispose = registerSchedulesHandlers();

      const registered = ipcMainMock.handle.mock.calls.map(([channel]) => channel);
      expect(registered.sort()).toEqual([...schedulesNamespace.channels()].sort());

      const { snapshot } = await created();

      for (const target of [own, cached]) {
        expect(target.webContents.send).toHaveBeenCalledWith(CHANNELS.SCHEDULES_CHANGED, snapshot);
      }
      for (const target of [withheld, otherProject, remote]) {
        expect(target.webContents.send).not.toHaveBeenCalled();
      }
    });

    it("stops telling views once disposed", async () => {
      const own = view(1, PROJECT);
      viewsMock.getRegisteredProjectViews.mockReturnValue([own]);
      dispose = registerSchedulesHandlers();
      dispose();
      dispose = null;

      await created();

      expect(own.webContents.send).not.toHaveBeenCalled();
      expect(ipcMainMock.removeHandler).toHaveBeenCalledTimes(schedulesNamespace.channels().length);
    });

    it("keeps telling the remaining views when one fails mid-send", async () => {
      const closing = view(1, PROJECT);
      closing.webContents.send.mockImplementation(() => {
        throw new Error("destroyed");
      });
      const own = view(2, PROJECT);
      viewsMock.getRegisteredProjectViews.mockReturnValue([closing, own]);
      dispose = registerSchedulesHandlers();

      const outcome = await create(ctx(PROJECT), input);

      expect(outcome.status).toBe("saved");
      expect(own.webContents.send).toHaveBeenCalledTimes(1);
    });
  });
});
