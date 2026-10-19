import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalArgsHash } from "../../../services/mcp-server/sessionDedup.js";
import {
  HostCallRuntime,
  type ObservedHost,
  type OpenRun,
  type RelayApprovalQuestion,
} from "../HostCallRuntime.js";
import type { McpCallAnswer, RelayApproveAnswer, RelayApprovePayload } from "../linkMethods.js";

const RUN_A: OpenRun = {
  projectId: "proj-1",
  slot: 0,
  sessionId: "a",
  terminalId: "t-a",
  launchGeneration: 1,
};

const HOST: ObservedHost = {
  hostId: "studio",
  name: "studio-01",
  connection: { status: "disconnected" },
  lastSeenAt: null,
  summary: null,
};

const DONE: McpCallAnswer = {
  status: "done",
  result: { isError: false, structured: {}, text: null },
};

function ask(overrides: Partial<RelayApprovePayload> = {}): RelayApprovePayload {
  const actionId = overrides.actionId ?? "worktree.delete";
  const args = overrides.args ?? { worktreeId: "/wt/feature" };
  return {
    approvalId: "approval-1",
    helpSessionId: "a",
    callId: "call-unset",
    projectId: "proj-2",
    actionId,
    args,
    argsHash: canonicalArgsHash(actionId, args),
    lines: ["No uncommitted changes."],
    ...overrides,
  };
}

describe("HostCallRuntime answering a host's approval ask (#13501)", () => {
  let runs: Map<string, OpenRun>;
  let control: Set<string>;
  let asked: RelayApprovalQuestion[];
  let decision: "approved" | "rejected" | "timeout" | null;
  let runtime: HostCallRuntime;
  let duringCall: ((runtime: HostCallRuntime, callId: string) => Promise<unknown>) | undefined;
  let answers: RelayApproveAnswer[];

  beforeEach(() => {
    runs = new Map([["a", RUN_A]]);
    control = new Set(["studio"]);
    asked = [];
    decision = "approved";
    answers = [];
    duringCall = undefined;
    const lanes = new Map<string, { projectId: string; slot: number }>([
      ["a", { projectId: "proj-1", slot: 0 }],
    ]);
    let ids = 0;
    runtime = new HostCallRuntime({
      getSessionLane: (id) => lanes.get(id) ?? null,
      callerRun: (id) => runs.get(id) ?? null,
      client: () =>
        ({
          relayCall: vi.fn(async (_hostId: string, payload: { callId: string }) => {
            if (duringCall) {
              answers.push((await duringCall(runtime, payload.callId)) as RelayApproveAnswer);
            }
            return DONE;
          }),
        }) as never,
      hosts: () => [HOST],
      inLocalView: () => true,
      controlEnabled: (hostId) => control.has(hostId),
      askApproval: async (question) => {
        asked.push(question);
        return decision;
      },
      newId: () => `00000000-0000-4000-8000-00000000000${++ids}`,
    });
  });

  const deleteCallWith = (callId: string) =>
    runtime.call(
      "a",
      {
        hostId: "studio",
        projectId: "proj-2",
        tool: "worktree.delete",
        args: { worktreeId: "/wt/feature" },
        callId,
      },
      { tier: "full" }
    );

  const deleteCall = (
    tool = "worktree.delete",
    args: Record<string, unknown> = { worktreeId: "/wt/feature" }
  ) => runtime.call("a", { hostId: "studio", projectId: "proj-2", tool, args }, { tier: "full" });

  it("asks the person about exactly the call in flight, and echoes the ask in its answer", async () => {
    duringCall = (r, callId) => r.receiveApproval("studio", ask({ callId }));

    await deleteCall();

    expect(asked).toEqual([
      {
        hostId: "studio",
        helpSessionId: "a",
        actionId: "worktree.delete",
        args: { worktreeId: "/wt/feature" },
        lines: ["No uncommitted changes."],
      },
    ]);
    expect(answers).toEqual([
      { approvalId: "approval-1", argsHash: ask().argsHash, decision: "approved" },
    ]);
  });

  it("asks about an owned delete as the plain delete the host runs on the same id", async () => {
    duringCall = (r, callId) => r.receiveApproval("studio", ask({ callId }));

    await deleteCall("worktree.deleteOwned");

    expect(answers[0]?.decision).toBe("approved");
  });

  it("asks once per call: a second ask about the same call is refused", async () => {
    duringCall = async (r, callId) => {
      await r.receiveApproval("studio", ask({ callId }));
      return r.receiveApproval("studio", ask({ callId, approvalId: "approval-2" }));
    };

    await deleteCall();

    expect(asked).toHaveLength(1);
    expect(answers).toEqual([
      { approvalId: "approval-2", argsHash: ask().argsHash, decision: "refused" },
    ]);
  });

  it("refuses an ask that isn't about a call of its own in flight, without asking anyone", async () => {
    const mismatches = (callId: string): RelayApprovePayload[] => [
      ask({ callId: "someone-elses-call" }),
      ask({ callId, helpSessionId: "b" }),
      ask({ callId, projectId: "proj-9" }),
      ask({ callId, args: { worktreeId: "/wt/other" } }),
      ask({ callId, args: { worktreeId: "/wt/feature", force: true } }),
      ask({ callId, argsHash: "0".repeat(64) }),
      ask({ callId, actionId: "terminal.close", args: { terminalId: "t-1" } }),
    ];
    duringCall = async (r, callId) => {
      for (const payload of mismatches(callId)) {
        answers.push(await r.receiveApproval("studio", payload));
      }
      return r.receiveApproval("elsewhere", ask({ callId }));
    };

    await deleteCall();

    expect(asked).toEqual([]);
    expect(answers.map((answer) => answer.decision)).toEqual(new Array(8).fill("refused"));
  });

  it("keeps the ask good when the same call is resent while the person decides", async () => {
    let resent: Promise<unknown> | undefined;
    let resending = false;
    duringCall = async (r, callId) => {
      // The resend's own send arrives here too, possibly before it returns.
      if (resending) return { decision: "skipped" };
      resending = true;
      resent = deleteCallWith(callId);
      return r.receiveApproval("studio", ask({ callId }));
    };

    await deleteCall();
    await resent;

    expect(answers.find((answer) => answer.approvalId === "approval-1")?.decision).toBe("approved");
  });

  it("refuses once the call has settled", async () => {
    const settled = await deleteCall();
    if (!settled.ok) throw new Error("refused");

    const late = await runtime.receiveApproval("studio", ask({ callId: settled.value.callId! }));

    expect(late.decision).toBe("refused");
    expect(asked).toEqual([]);
  });

  it("refuses with the person's control switch off, or once the run that asked is replaced", async () => {
    duringCall = async (r, callId) => {
      control.delete("studio");
      const off = await r.receiveApproval("studio", ask({ callId }));
      control.add("studio");
      runs.set("a", { ...RUN_A, launchGeneration: 2 });
      answers.push(off);
      return r.receiveApproval("studio", ask({ callId, approvalId: "approval-2" }));
    };

    await deleteCall();

    expect(answers.map((answer) => answer.decision)).toEqual(["refused", "refused"]);
    expect(asked).toEqual([]);
  });

  it("withdraws an approval the person gave after the call's run was replaced", async () => {
    duringCall = async (r, callId) => {
      const pending = r.receiveApproval("studio", ask({ callId }));
      runs.set("a", { ...RUN_A, launchGeneration: 2 });
      return pending;
    };

    await deleteCall();

    expect(asked).toHaveLength(1);
    expect(answers[0]?.decision).toBe("refused");
  });

  it("passes a decline or a missed dialog through, and refuses when no window could ask", async () => {
    const decisions: Array<typeof decision> = ["rejected", "timeout", null];
    for (const next of decisions) {
      decision = next;
      duringCall = (r, callId) => r.receiveApproval("studio", ask({ callId }));
      answers = [];
      await deleteCall();
      expect(answers[0]?.decision).toBe(next ?? "refused");
    }
  });
});
