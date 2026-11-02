import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionFileResult } from "../../../../shared/types/agentSessionFile.js";
import type { IpcContext } from "../../types.js";

const OBSERVED: AgentSessionFileResult = {
  status: "observed",
  agentId: "claude",
  sessionId: "1ad2578c-b710-4302-90c1-b222c4c29aa2",
  path: "/Users/x/.claude/projects/-repo/1ad2578c-b710-4302-90c1-b222c4c29aa2.jsonl",
  observedBy: "recorded-session-id",
};

const serviceMock = vi.hoisted(() => ({
  locateAgentSessionFile: vi.fn(
    async (
      _terminalId: string,
      _senderWorkspaceId: string | null
    ): Promise<AgentSessionFileResult> => ({ status: "unknown", reason: "not-observed" })
  ),
}));

vi.mock("../../../services/AgentSessionFileService.js", () => serviceMock);

import { terminalSessionFileNamespace } from "../terminalSessionFile.js";

function ctx(
  client: "local" | "remote",
  endpoint: "local-view" | "remote-view",
  identity: { projectId?: string | null; senderUrl?: string } = { projectId: "project-a" }
): IpcContext {
  const event =
    identity.senderUrl === undefined
      ? undefined
      : { sender: { getURL: () => identity.senderUrl as string } };
  return {
    client: { kind: client },
    endpoint: { kind: endpoint },
    projectId: identity.projectId ?? null,
    event,
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

  it("answers with what the lookup found for the sender's own project", async () => {
    serviceMock.locateAgentSessionFile.mockResolvedValueOnce(OBSERVED);

    await expect(get(ctx("local", "local-view"), { terminalId: "t-1" })).resolves.toEqual(OBSERVED);
    expect(serviceMock.locateAgentSessionFile).toHaveBeenCalledWith("t-1", "project-a");
  });

  it("takes the project from the view's URL before the view is bound", async () => {
    await get(ctx("local", "local-view", { senderUrl: "app://daintree/?projectId=project-b" }), {
      terminalId: "t-1",
    });
    expect(serviceMock.locateAgentSessionFile).toHaveBeenLastCalledWith("t-1", "project-b");

    // A bound view's own project wins over a stale query string.
    await get(
      ctx("local", "local-view", {
        projectId: "project-a",
        senderUrl: "app://daintree/?projectId=project-b",
      }),
      { terminalId: "t-1" }
    );
    expect(serviceMock.locateAgentSessionFile).toHaveBeenLastCalledWith("t-1", "project-a");

    await get(ctx("local", "local-view", {}), { terminalId: "t-1" });
    expect(serviceMock.locateAgentSessionFile).toHaveBeenLastCalledWith("t-1", null);
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
