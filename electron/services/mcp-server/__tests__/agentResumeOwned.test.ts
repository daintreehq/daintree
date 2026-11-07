import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { AgentResumeOwnedResultSchema } from "../../../../shared/types/agentSessionSchemas.js";
import type {
  AgentSessionPaneRequest,
  AgentSessionPaneResult,
} from "../../viewless/viewlessAgentResume.js";

const resume = vi.hoisted(() =>
  vi.fn<(request: AgentSessionPaneRequest) => Promise<AgentSessionPaneResult>>()
);
const describeWorkspace = vi.hoisted(() => vi.fn());

vi.mock("../../viewless/index.js", () => ({
  resumeAgentSessionAsPaneLive: resume,
  describeViewlessWorkspace: describeWorkspace,
}));

import { handleAgentResumeOwned } from "../agentResumeOwned.js";

const ARGS = { worktreeId: "wt-1", agentId: "claude", sessionId: "sess-1" };
const WORKSPACE = { kind: "project", workspaceId: "project-1", workspacePath: "/repo" };
const LAUNCHED: AgentSessionPaneResult = {
  status: "launched",
  projectId: "project-1",
  worktreeId: "wt-1",
  terminalId: "terminal-1",
  cwd: "/repo",
  savedInLayout: true,
};

const run = (authorize?: () => void, projectId: string | null = "project-1", args: unknown = ARGS) =>
  handleAgentResumeOwned(args, projectId, new AbortController().signal, authorize);

/** The helper as the launching call sees it: asked, then answered. */
function launches(result: AgentSessionPaneResult = LAUNCHED) {
  resume.mockImplementation(async (request) => {
    const denied = request.authorizeSpawn?.();
    return denied ? { status: "refused", reason: "not-authorized", message: denied } : result;
  });
}

beforeEach(() => {
  resume.mockReset();
  describeWorkspace.mockReset();
  describeWorkspace.mockResolvedValue(WORKSPACE);
});

describe("agent.resumeOwned in main (#16341)", () => {
  it("reopens in the session's own project, whatever the arguments say", async () => {
    launches();

    await run(undefined, "project-1", { ...ARGS, projectId: "project-2" });

    expect(resume.mock.calls[0]![0]).toMatchObject({ ...ARGS, projectId: "project-1" });
  });

  it("answers `launched` with the workspace the ledger records it under", async () => {
    launches();

    const { result, dispatchedWorkspace } = await run();

    expect(result.result).toMatchObject({
      status: "launched",
      terminalId: "terminal-1",
      savedInLayout: true,
    });
    expect(dispatchedWorkspace).toEqual(WORKSPACE);
  });

  it("keeps a running pane `launched` when its workspace can't be described", async () => {
    launches();
    describeWorkspace.mockRejectedValue(new Error("store gone"));

    const answer = await run();

    expect(answer.result.result.status).toBe("launched");
    expect(answer).not.toHaveProperty("dispatchedWorkspace");
  });

  it("reads a launch it only joined as `existing`, so the ledger leaves it alone", async () => {
    // A joiner is handed the launcher's result without being asked.
    resume.mockResolvedValue(LAUNCHED);

    const { result, dispatchedWorkspace } = await run();

    expect(result.result).toMatchObject({ status: "existing", terminalId: "terminal-1" });
    expect(dispatchedWorkspace).toBeUndefined();
  });

  it("passes a live pane through as `existing`", async () => {
    launches({
      status: "existing",
      projectId: "project-1",
      worktreeId: "wt-1",
      terminalId: "terminal-9",
    });

    const { result } = await run();

    expect(result.result).toMatchObject({ status: "existing", terminalId: "terminal-9" });
  });

  it("passes a refusal through with its reason", async () => {
    launches({ status: "refused", reason: "worktree-gone", message: "It's gone." });

    const { result } = await run();

    expect(result.result).toMatchObject({
      status: "refused",
      reason: "worktree-gone",
      message: "It's gone.",
      terminalId: null,
    });
  });

  it("rethrows what `authorize` threw rather than answering with its text", async () => {
    launches();
    const refused = new Error("studio-02 has control of this project.");

    await expect(
      run(() => {
        throw refused;
      })
    ).rejects.toBe(refused);
  });

  it("refuses a session bound to no project before touching the journal", async () => {
    const { result } = await run(undefined, null);

    expect(result.result).toMatchObject({ status: "refused", reason: "unknown-project" });
    expect(resume).not.toHaveBeenCalled();
  });

  it.each([{}, { ...ARGS, sessionId: "" }, { ...ARGS, worktreeId: 7 }, null])(
    "refuses malformed arguments %j as invalid params",
    async (args) => {
      await expect(run(undefined, "project-1", args)).rejects.toBeInstanceOf(McpError);
      expect(resume).not.toHaveBeenCalled();
    }
  );

  it.each<[string, AgentSessionPaneResult]>([
    ["launched", LAUNCHED],
    ["refused", { status: "refused", reason: "panel-limit", message: "Full." }],
    [
      "existing",
      { status: "existing", projectId: "project-1", worktreeId: "wt-1", terminalId: "terminal-1" },
    ],
  ])("answers `%s` with every field the advertised schema requires", async (_name, helper) => {
    launches(helper);

    const { result } = await run();

    expect(AgentResumeOwnedResultSchema.parse(result.result)).toEqual(result.result);
  });
});
