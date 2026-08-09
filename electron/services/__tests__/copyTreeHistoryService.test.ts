import { beforeEach, describe, expect, it, vi } from "vitest";

const projectStoreMock = vi.hoisted(() => ({
  appendCopyTreeRun: vi.fn<(projectId: string, input: unknown) => Promise<unknown[]>>(),
}));

const registryMock = vi.hoisted(() => ({
  getWebContentsForProject: vi.fn<(projectId: string) => unknown[]>(() => []),
}));

vi.mock("../ProjectStore.js", () => ({ projectStore: projectStoreMock }));
vi.mock("../../window/webContentsRegistry.js", () => registryMock);

import { CHANNELS } from "../../ipc/channels.js";
import { recordCopyTreeRun } from "../copyTreeHistoryService.js";
import type { CopyTreeHistoryAppendInput } from "../../../shared/types/ipc/copyTreeHistory.js";

const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);

const INPUT: CopyTreeHistoryAppendInput = {
  options: { modified: true },
  source: "toolbar",
  worktreeId: "wt-1",
  stats: { fileCount: 3 },
};

function view() {
  return { send: vi.fn() };
}

describe("recordCopyTreeRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectStoreMock.appendCopyTreeRun.mockResolvedValue([{ id: "r1" }]);
    registryMock.getWebContentsForProject.mockReturnValue([]);
  });

  it("appends against the project it was given", async () => {
    await recordCopyTreeRun(PROJECT_A, INPUT);
    expect(projectStoreMock.appendCopyTreeRun).toHaveBeenCalledWith(PROJECT_A, INPUT);
  });

  it("does nothing at all without a project", async () => {
    await recordCopyTreeRun(null, INPUT);
    expect(projectStoreMock.appendCopyTreeRun).not.toHaveBeenCalled();
    expect(registryMock.getWebContentsForProject).not.toHaveBeenCalled();
  });

  it("pushes the committed snapshot to every view bound to that project", async () => {
    const first = view();
    const second = view();
    registryMock.getWebContentsForProject.mockReturnValue([first, second]);
    projectStoreMock.appendCopyTreeRun.mockResolvedValue([{ id: "r1" }, { id: "r2" }]);

    await recordCopyTreeRun(PROJECT_A, INPUT);

    for (const wc of [first, second]) {
      expect(wc.send).toHaveBeenCalledWith(CHANNELS.EVENTS_PUSH, {
        name: "copy-tree-history:update",
        payload: { projectId: PROJECT_A, records: [{ id: "r1" }, { id: "r2" }] },
      });
    }
  });

  it("only ever asks for the owning project's views", async () => {
    // The leak this guards against: a global broadcast would hand project A's
    // paths and options to a window showing project B (#11125's failure mode).
    const viewA = view();
    registryMock.getWebContentsForProject.mockImplementation((projectId) =>
      projectId === PROJECT_A ? [viewA] : []
    );

    await recordCopyTreeRun(PROJECT_A, INPUT);

    expect(registryMock.getWebContentsForProject).toHaveBeenCalledTimes(1);
    expect(registryMock.getWebContentsForProject).toHaveBeenCalledWith(PROJECT_A);
    expect(registryMock.getWebContentsForProject).not.toHaveBeenCalledWith(PROJECT_B);
    expect(viewA.send).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when no view is bound to the project", async () => {
    registryMock.getWebContentsForProject.mockReturnValue([]);
    await expect(recordCopyTreeRun(PROJECT_A, INPUT)).resolves.toBeUndefined();
  });

  it("does not let one dead view stop the others from receiving the snapshot", async () => {
    const dead = {
      send: vi.fn(() => {
        throw new Error("destroyed");
      }),
    };
    const alive = view();
    registryMock.getWebContentsForProject.mockReturnValue([dead, alive]);

    await expect(recordCopyTreeRun(PROJECT_A, INPUT)).resolves.toBeUndefined();
    expect(alive.send).toHaveBeenCalledTimes(1);
  });

  it("swallows an append failure — the copy already happened", async () => {
    projectStoreMock.appendCopyTreeRun.mockRejectedValue(new Error("quarantine failed"));
    const bound = view();
    registryMock.getWebContentsForProject.mockReturnValue([bound]);

    await expect(recordCopyTreeRun(PROJECT_A, INPUT)).resolves.toBeUndefined();
    // Nothing committed, so nothing is pushed.
    expect(bound.send).not.toHaveBeenCalled();
  });
});
