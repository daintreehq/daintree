import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcContext } from "../../types.js";

const mocks = vi.hoisted(() => ({
  createHostForWorktree: vi.fn(async () => ({ hostId: "feature-login", requestedAt: 1_000 })),
  createHost: vi.fn(async () => ({ hostId: "build" })),
  getProjectById: vi.fn((id: string) => (id === "proj-1" ? { id, name: "app" } : null)),
  hostForSender: vi.fn((_id: number): string | null => null),
  requireProjectWorktree: vi.fn(async (_projectId: unknown, _path: unknown) => {}),
}));

vi.mock("../../../remote/runtime.js", () => ({
  getRemoteService: () => null,
  requireRemoteService: () => ({
    createHostForWorktree: mocks.createHostForWorktree,
    createHost: mocks.createHost,
  }),
}));
vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: { getProjectById: mocks.getProjectById },
}));
vi.mock("../../dispatcher.js", () => ({
  getIpcDispatcher: () => ({ hostForSender: mocks.hostForSender }),
}));
vi.mock("../../../services/projectAcrossHosts/defaults.js", () => ({
  getProjectAcrossHostsService: () => ({ requireProjectWorktree: mocks.requireProjectWorktree }),
}));

import { cloudHostsNamespace } from "../cloudHosts.js";

type ForWorktree = (context: IpcContext, payload: unknown) => Promise<unknown>;
const forWorktree = cloudHostsNamespace.ops.createHostForWorktree.handler as unknown as ForWorktree;

function ctx(overrides: Partial<Record<keyof IpcContext, unknown>> = {}): IpcContext {
  return {
    event: {},
    webContentsId: 7,
    projectId: "proj-1",
    client: { kind: "local" },
    endpoint: { kind: "local-view" },
    ...overrides,
  } as unknown as IpcContext;
}

const MACHINE = { accountId: "ca_1", name: "feature-login", machineType: "s", lifetimeHours: null };
const WORKTREE = {
  projectId: "proj-1",
  worktreeId: "/Users/me/app-worktrees/feature-login",
  worktreeName: "feature/login",
};

describe("cloudHosts createHostForWorktree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hostForSender.mockReturnValue(null);
    mocks.requireProjectWorktree.mockResolvedValue(undefined);
  });

  it("marks the machine with main's own project name, never the asker's", async () => {
    const result = await forWorktree(ctx(), {
      machine: MACHINE,
      worktree: { ...WORKTREE, projectName: "forged" },
    });
    expect(result).toEqual({ hostId: "feature-login", requestedAt: 1_000 });
    expect(mocks.createHostForWorktree).toHaveBeenCalledWith(
      MACHINE,
      { ...WORKTREE, projectName: "forged" },
      "app"
    );
  });

  const refusals: [string, () => void, Partial<Record<keyof IpcContext, unknown>>][] = [
    ["a window bound to another host", () => mocks.hostForSender.mockReturnValue("studio"), {}],
    ["a remote client", () => {}, { client: { kind: "remote" } }],
    ["a remote view", () => {}, { endpoint: { kind: "remote-view" } }],
    ["no sender at all", () => {}, { event: null }],
  ];
  it.each(refusals)("refuses %s", async (_label, arrange, overrides) => {
    arrange();
    await expect(
      forWorktree(ctx(overrides), { machine: MACHINE, worktree: WORKTREE })
    ).rejects.toThrow(/window on this machine/);
    expect(mocks.createHostForWorktree).not.toHaveBeenCalled();
  });

  it("refuses a worktree outside the asking window's project", async () => {
    await expect(
      forWorktree(ctx({ projectId: "proj-2" }), { machine: MACHINE, worktree: WORKTREE })
    ).rejects.toThrow(/this window's project/);
    expect(mocks.createHostForWorktree).not.toHaveBeenCalled();
  });

  it("refuses a project this machine doesn't know", async () => {
    await expect(
      forWorktree(ctx({ projectId: "proj-9" }), {
        machine: MACHINE,
        worktree: { ...WORKTREE, projectId: "proj-9" },
      })
    ).rejects.toThrow(/isn't open on this machine/);
    expect(mocks.createHostForWorktree).not.toHaveBeenCalled();
  });

  it("refuses a worktree named by anything but an absolute path", async () => {
    await expect(
      forWorktree(ctx(), {
        machine: MACHINE,
        worktree: { ...WORKTREE, worktreeId: "app-worktrees/feature-login" },
      })
    ).rejects.toThrow(/missing its path/);
    expect(mocks.createHostForWorktree).not.toHaveBeenCalled();
  });

  it("refuses a path git doesn't list as one of the project's working trees", async () => {
    mocks.requireProjectWorktree.mockRejectedValueOnce(new Error("not a working tree"));
    await expect(
      forWorktree(ctx(), {
        machine: MACHINE,
        worktree: { ...WORKTREE, worktreeId: "/Users/me/other-repo" },
      })
    ).rejects.toThrow(/one of this project's working trees/);
    expect(mocks.requireProjectWorktree).toHaveBeenCalledWith("proj-1", "/Users/me/other-repo");
    expect(mocks.createHostForWorktree).not.toHaveBeenCalled();
  });

  it("leaves Settings' create unmarked, whatever its payload carries", async () => {
    const create = cloudHostsNamespace.ops.createHost.handler as unknown as (
      payload: unknown
    ) => Promise<unknown>;
    await create({ ...MACHINE, worktree: WORKTREE });
    expect(mocks.createHost).toHaveBeenCalledWith({ ...MACHINE, worktree: WORKTREE });
    expect(mocks.createHostForWorktree).not.toHaveBeenCalled();
  });
});
