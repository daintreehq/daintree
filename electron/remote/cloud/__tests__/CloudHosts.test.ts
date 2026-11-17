import { describe, expect, it, vi } from "vitest";
import { CloudHosts } from "../CloudHosts.js";
import type { CloudAccountService } from "../CloudAccountService.js";
import type { CloudHostLifecycle } from "../CloudHostLifecycle.js";
import type { CloudHostStore } from "../CloudHostStore.js";

function setup() {
  const create = vi.fn(async () => ({ hostId: "feature-login" }));
  const cloud = new CloudHosts({
    accounts: { providerInfos: () => [], summaries: () => [] } as unknown as CloudAccountService,
    store: { onChange: () => () => {} } as unknown as CloudHostStore,
    emit: () => {},
    now: () => 42_000,
  });
  cloud.attachLifecycle({ create, statuses: () => [] } as unknown as CloudHostLifecycle);
  return { cloud, create };
}

describe("CloudHosts.createHostForWorktree", () => {
  const machine = {
    accountId: "ca_1",
    name: "feature-login",
    machineType: "s",
    lifetimeHours: null,
  };

  it("marks the machine for the worktree on this device and holds the worktree on its host", async () => {
    const { cloud, create } = setup();
    const result = await cloud.createHostForWorktree(
      machine,
      {
        projectId: "proj-1",
        worktreeId: "/Users/me/app-worktrees/feature-login",
        worktreeName: " feature/login ",
        projectName: "forged",
        hostId: "studio",
        hostName: "Studio",
      },
      "app"
    );
    expect(result).toEqual({ hostId: "feature-login", requestedAt: 42_000 });
    expect(create).toHaveBeenCalledWith(
      machine,
      {
        hostId: null,
        projectId: "proj-1",
        worktreeId: "/Users/me/app-worktrees/feature-login",
        projectName: "app",
        worktreeName: "feature/login",
        hostName: null,
      },
      {
        projectId: "proj-1",
        worktreeId: "/Users/me/app-worktrees/feature-login",
        worktreePath: "/Users/me/app-worktrees/feature-login",
        label: "feature/login",
        requestedAt: 42_000,
        createdMachine: true,
      }
    );
  });

  it("hands a worktree missing its identity to the lifecycle's own refusal, as empty text", async () => {
    const { cloud, create } = setup();
    await cloud.createHostForWorktree(machine, { projectId: 7 }, "app");
    expect(create).toHaveBeenCalledWith(
      machine,
      expect.objectContaining({ projectId: "", worktreeId: "", worktreeName: "" }),
      expect.objectContaining({ projectId: "", worktreeId: "", label: "" })
    );
  });
});
