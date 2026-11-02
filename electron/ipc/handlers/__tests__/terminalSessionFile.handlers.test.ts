import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionFileResult } from "../../../../shared/types/agentSessionFile.js";
import type { IpcContext } from "../../types.js";

const serviceMock = vi.hoisted(() => ({
  locateAgentSessionFile: vi.fn(
    async (_terminalId: string, _senderWorkspaceId: string | null): Promise<AgentSessionFileResult> => ({
      status: "unknown",
      reason: "not-observed",
    })
  ),
}));

vi.mock("../../../services/AgentSessionFileService.js", () => serviceMock);

import { terminalSessionFileNamespace } from "../terminalSessionFile.js";

function ctx(
  client: "local" | "remote",
  endpoint: "local-view" | "remote-view",
  projectId: string | null = "project-a"
): IpcContext {
  return {
    client: { kind: client },
    endpoint: { kind: endpoint },
    projectId,
  } as unknown as IpcContext;
}

type GetHandler = (
  context: IpcContext,
  payload: { terminalId: string }
) => Promise<AgentSessionFileResult>;

const get = terminalSessionFileNamespace.ops.get.handler as unknown as GetHandler;

describe("terminalSessionFile.get", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("looks the terminal up for the sender's own project", async () => {
    await expect(get(ctx("local", "local-view"), { terminalId: "t-1" })).resolves.toEqual({
      status: "unknown",
      reason: "not-observed",
    });
    expect(serviceMock.locateAgentSessionFile).toHaveBeenCalledWith("t-1", "project-a");
  });

  it.each([
    ["a remote Shell", ctx("remote", "remote-view")],
    ["a remote view of a local client", ctx("local", "remote-view")],
    ["a remote client on a local endpoint", ctx("remote", "local-view")],
  ])("looks nothing up for %s", async (_label, context) => {
    await expect(get(context, { terminalId: "t-1" })).resolves.toEqual({
      status: "unknown",
      reason: "remote-pane",
    });
    expect(serviceMock.locateAgentSessionFile).not.toHaveBeenCalled();
  });
});
