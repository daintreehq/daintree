import { beforeEach, describe, expect, it, vi } from "vitest";

const registryMock = vi.hoisted(() => ({
  getWebContentsForProject: vi.fn((_projectId: string): unknown[] => []),
}));

vi.mock("../../window/webContentsRegistry.js", () => ({
  getWebContentsForProject: registryMock.getWebContentsForProject,
}));

import { locateTerminal } from "../terminalLocation.js";

function clientReturning(record: unknown) {
  return { getTerminalAsync: vi.fn().mockResolvedValue(record) };
}

describe("locateTerminal (#13120)", () => {
  beforeEach(() => {
    registryMock.getWebContentsForProject.mockReset();
    registryMock.getWebContentsForProject.mockReturnValue([]);
  });

  it("reports a running terminal's project and a resident view", async () => {
    registryMock.getWebContentsForProject.mockReturnValue([{ id: 1 }]);
    const client = clientReturning({ id: "t1", projectId: "proj-b", hasPty: true });

    await expect(locateTerminal(client as never, "t1")).resolves.toEqual({
      found: true,
      projectId: "proj-b",
      viewResident: true,
    });
    expect(client.getTerminalAsync).toHaveBeenCalledWith("t1");
    expect(registryMock.getWebContentsForProject).toHaveBeenCalledWith("proj-b");
  });

  it("reports viewResident false when the owning view was evicted", async () => {
    const client = clientReturning({ id: "t1", projectId: "proj-b", hasPty: true });

    await expect(locateTerminal(client as never, "t1")).resolves.toEqual({
      found: true,
      projectId: "proj-b",
      viewResident: false,
    });
  });

  it("counts a trashed terminal that is still running", async () => {
    const client = clientReturning({
      id: "t1",
      projectId: "proj-b",
      hasPty: true,
      isTrashed: true,
    });

    await expect(locateTerminal(client as never, "t1")).resolves.toMatchObject({ found: true });
  });

  it.each([
    ["no host record", null],
    ["an exited process", { id: "t1", projectId: "proj-b", hasPty: false }],
    ["an unreported liveness", { id: "t1", projectId: "proj-b" }],
    ["no attributed project", { id: "t1", hasPty: true }],
    ["an empty project id", { id: "t1", projectId: "", hasPty: true }],
  ])("misses for %s", async (_label, record) => {
    const client = clientReturning(record);

    await expect(locateTerminal(client as never, "t1")).resolves.toEqual({ found: false });
    expect(registryMock.getWebContentsForProject).not.toHaveBeenCalled();
  });
});
