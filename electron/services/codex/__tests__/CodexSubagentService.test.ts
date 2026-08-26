import { beforeEach, describe, expect, it, vi } from "vitest";

const getTerminalAsync = vi.hoisted(() => vi.fn());
const runSession = vi.hoisted(() => vi.fn());

vi.mock("../../PtyClient.js", () => ({
  getPtyClient: () => ({ getTerminalAsync }),
}));

vi.mock("../CodexAppServerClient.js", async () => {
  const actual = await vi.importActual<typeof import("../CodexAppServerClient.js")>(
    "../CodexAppServerClient.js"
  );
  return { ...actual, runCodexAppServerSession: runSession };
});

vi.mock("fs/promises", () => ({
  realpath: vi.fn(async (input: string) =>
    input.startsWith("/tmp/") ? input.replace("/tmp/", "/private/tmp/") : input
  ),
}));

import { CodexAppServerError } from "../CodexAppServerClient.js";
import {
  listCodexSubagents,
  readCodexSubagentTranscript,
  selectParentThread,
  toSubagent,
  toSubagentStatus,
  toSubagentTurn,
} from "../CodexSubagentService.js";

/** Params the service sends; every field is optional so a script can probe any. */
type QueryParams = Record<string, unknown>;
type Call = (method: string, params?: QueryParams) => Promise<unknown>;

/** Drive the mocked session with a scripted responder keyed by method. */
function scriptSession(responder: (method: string, params: QueryParams) => unknown) {
  runSession.mockImplementation(async (run: (call: Call) => Promise<unknown>) =>
    run(async (method: string, params: QueryParams = {}) => responder(method, params))
  );
}

const codexTerminal = {
  cwd: "/repo",
  launchAgentId: "codex",
  spawnedAt: 1_700_000_000_000,
};

beforeEach(() => {
  getTerminalAsync.mockReset();
  runSession.mockReset();
});

describe("toSubagentStatus", () => {
  it("keeps the active flags that say why a child is blocked", () => {
    expect(toSubagentStatus({ type: "active", activeFlags: ["waitingOnApproval"] })).toEqual({
      type: "active",
      activeFlags: ["waitingOnApproval"],
    });
  });

  it("drops flags the protocol did not define rather than passing them through", () => {
    expect(
      toSubagentStatus({ type: "active", activeFlags: ["waitingOnUserInput", "bogus"] })
    ).toEqual({ type: "active", activeFlags: ["waitingOnUserInput"] });
  });

  it("degrades an unknown or malformed status to notLoaded instead of throwing", () => {
    expect(toSubagentStatus({ type: "somethingNew" })).toEqual({ type: "notLoaded" });
    expect(toSubagentStatus(null)).toEqual({ type: "notLoaded" });
  });
});

describe("toSubagent", () => {
  it("converts the protocol's Unix seconds to milliseconds", () => {
    const subagent = toSubagent({ id: "t", createdAt: 1_730_831_111, updatedAt: 1_730_831_222 });
    expect(subagent?.createdAt).toBe(1_730_831_111_000);
    expect(subagent?.updatedAt).toBe(1_730_831_222_000);
  });

  it("treats a null canAcceptDirectInput as not accepting input", () => {
    // null is what the protocol reports for the unloaded threads this feature
    // always sees, so an `=== false` check would read it as input-capable.
    expect(toSubagent({ id: "t", canAcceptDirectInput: null })?.acceptsDirectInput).toBe(false);
    expect(toSubagent({ id: "t", canAcceptDirectInput: false })?.acceptsDirectInput).toBe(false);
    expect(toSubagent({ id: "t", canAcceptDirectInput: true })?.acceptsDirectInput).toBe(true);
  });

  it("drops a thread with no id rather than emitting an unaddressable row", () => {
    expect(toSubagent({ preview: "orphan" })).toBeNull();
  });
});

describe("selectParentThread", () => {
  const spawnedAtMs = 1_700_000_000_000;
  const spawnedAtSeconds = spawnedAtMs / 1000;

  it("uses an exact session id without consulting the thread list", () => {
    const selection = selectParentThread([{ id: "other", recencyAt: spawnedAtSeconds }], {
      spawnedAtMs,
      agentSessionId: "known-thread",
    });
    expect(selection).toEqual({
      parentThreadId: "known-thread",
      matchedBy: "session-id",
      candidates: [],
    });
  });

  it("ignores threads that are themselves subagents", () => {
    const selection = selectParentThread(
      [
        { id: "child", parentThreadId: "root", recencyAt: spawnedAtSeconds + 100 },
        { id: "root", parentThreadId: null, recencyAt: spawnedAtSeconds },
      ],
      { spawnedAtMs }
    );
    expect(selection.parentThreadId).toBe("root");
  });

  it("picks the most recently active root and reports no ambiguity when it stands alone", () => {
    const selection = selectParentThread(
      [
        { id: "stale", recencyAt: spawnedAtSeconds - 10 * 60 * 60 },
        { id: "live", recencyAt: spawnedAtSeconds + 60 },
      ],
      { spawnedAtMs }
    );
    expect(selection.parentThreadId).toBe("live");
    expect(selection.matchedBy).toBe("cwd-recency");
    // `stale` predates the terminal by more than the window, so it is not a rival.
    expect(selection.candidates).toEqual([]);
  });

  it("reports every plausible root when recency cannot separate them", () => {
    const selection = selectParentThread(
      [
        {
          id: "a",
          recencyAt: spawnedAtSeconds + 120,
          preview: "first",
          createdAt: spawnedAtSeconds,
        },
        {
          id: "b",
          recencyAt: spawnedAtSeconds + 60,
          preview: "second",
          createdAt: spawnedAtSeconds,
        },
      ],
      { spawnedAtMs }
    );
    expect(selection.parentThreadId).toBe("a");
    expect(selection.candidates.map((candidate) => candidate.threadId)).toEqual(["a", "b"]);
  });

  it("falls back to updatedAt then createdAt when recencyAt is absent", () => {
    const selection = selectParentThread(
      [
        { id: "older", createdAt: spawnedAtSeconds, recencyAt: null },
        { id: "newer", updatedAt: spawnedAtSeconds + 5000, recencyAt: null },
      ],
      { spawnedAtMs }
    );
    expect(selection.parentThreadId).toBe("newer");
  });

  it("returns no parent when the cwd has no root threads", () => {
    expect(selectParentThread([], { spawnedAtMs }).parentThreadId).toBeNull();
  });
});

describe("toSubagentTurn", () => {
  it("keeps user and agent messages and drops reasoning items", () => {
    const turn = toSubagentTurn({
      id: "turn-1",
      status: "completed",
      startedAt: 1_700_000_000,
      completedAt: 1_700_000_007,
      items: [
        { type: "userMessage", content: [{ type: "text", text: "review the diff" }] },
        { type: "reasoning", summary: [], content: [] },
        { type: "agentMessage", text: "Looks fine" },
      ],
    });

    expect(turn?.messages).toEqual([
      { role: "user", text: "review the diff" },
      { role: "agent", text: "Looks fine" },
    ]);
    expect(turn?.startedAt).toBe(1_700_000_000_000);
    expect(turn?.completedAt).toBe(1_700_000_007_000);
  });

  it("truncates a message that would otherwise flood IPC", () => {
    const turn = toSubagentTurn({
      id: "turn-2",
      items: [{ type: "agentMessage", text: "x".repeat(9000) }],
    });
    expect(turn?.messages[0].text.length).toBe(4000);
  });
});

describe("listCodexSubagents", () => {
  it("refuses a terminal that is not running Codex", async () => {
    getTerminalAsync.mockResolvedValue({ cwd: "/repo", launchAgentId: "claude" });
    await expect(listCodexSubagents("t1")).resolves.toEqual({
      status: "unavailable",
      reason: "not-codex",
    });
    expect(runSession).not.toHaveBeenCalled();
  });

  it("reports terminal-unknown for an id the pty host has never heard of", async () => {
    getTerminalAsync.mockResolvedValue(null);
    await expect(listCodexSubagents("ghost")).resolves.toEqual({
      status: "unavailable",
      reason: "terminal-unknown",
    });
  });

  it("queries both the recorded cwd and its realpath so a symlinked worktree matches", async () => {
    getTerminalAsync.mockResolvedValue({ ...codexTerminal, cwd: "/tmp/wt" });
    const seen: Array<{ method: string; params: QueryParams }> = [];
    scriptSession((method, params) => {
      seen.push({ method, params });
      if (method === "thread/list" && params.cwd) {
        return { data: [{ id: "root", recencyAt: codexTerminal.spawnedAt / 1000 }] };
      }
      return { data: [] };
    });

    await listCodexSubagents("t1");

    expect(seen[0]?.params.cwd).toEqual(["/tmp/wt", "/private/tmp/wt"]);
  });

  it("returns the parent's children newest-first, without an explicit sourceKinds filter", async () => {
    getTerminalAsync.mockResolvedValue(codexTerminal);
    let childParams: QueryParams = {};
    scriptSession((method, params) => {
      if (method === "thread/list" && params.cwd) {
        return { data: [{ id: "root", recencyAt: codexTerminal.spawnedAt / 1000 }] };
      }
      if (method === "thread/list") {
        childParams = params;
        return {
          data: [
            { id: "older", agentNickname: "Kant", updatedAt: 100 },
            { id: "newer", agentNickname: "Meitner", updatedAt: 200 },
          ],
        };
      }
      return {};
    });

    const result = await listCodexSubagents("t1");

    expect(result).toMatchObject({
      status: "ok",
      parentThreadId: "root",
      matchedBy: "cwd-recency",
    });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.subagents.map((s) => s.threadId)).toEqual(["newer", "older"]);
    expect(childParams.parentThreadId).toBe("root");
    // An explicit sourceKinds list would fall back to the interactive-only
    // default and return no subagents at all.
    expect(childParams.sourceKinds).toBeUndefined();
  });

  it("reports no-session when nothing in the cwd could be the parent", async () => {
    getTerminalAsync.mockResolvedValue(codexTerminal);
    scriptSession(() => ({ data: [] }));
    await expect(listCodexSubagents("t1")).resolves.toEqual({
      status: "unavailable",
      reason: "no-session",
    });
  });

  it("carries the transport's reason through instead of flattening every failure", async () => {
    getTerminalAsync.mockResolvedValue(codexTerminal);
    runSession.mockRejectedValue(new CodexAppServerError("cli-missing", "Codex CLI not found"));
    await expect(listCodexSubagents("t1")).resolves.toMatchObject({
      status: "unavailable",
      reason: "cli-missing",
    });
  });
});

describe("readCodexSubagentTranscript", () => {
  it("refuses a thread that is not a child of this terminal's session", async () => {
    getTerminalAsync.mockResolvedValue(codexTerminal);
    const methods: string[] = [];
    scriptSession((method, params) => {
      methods.push(method);
      if (method === "thread/list" && params.cwd) {
        return { data: [{ id: "root", recencyAt: codexTerminal.spawnedAt / 1000 }] };
      }
      if (method === "thread/list") return { data: [{ id: "mine" }] };
      return { data: [] };
    });

    const result = await readCodexSubagentTranscript("t1", "someone-elses-thread");

    expect(result).toEqual({ status: "unavailable", reason: "no-session" });
    // The membership check must run before any read of the requested thread.
    expect(methods).not.toContain("thread/turns/list");
  });

  it("reads a verified child with the non-deprecated summary turn view", async () => {
    getTerminalAsync.mockResolvedValue(codexTerminal);
    let turnParams: QueryParams = {};
    scriptSession((method, params) => {
      if (method === "thread/list" && params.cwd) {
        return { data: [{ id: "root", recencyAt: codexTerminal.spawnedAt / 1000 }] };
      }
      if (method === "thread/list") return { data: [{ id: "mine" }] };
      if (method === "thread/turns/list") {
        turnParams = params;
        return { data: [{ id: "turn-1", items: [{ type: "agentMessage", text: "done" }] }] };
      }
      return {};
    });

    const result = await readCodexSubagentTranscript("t1", "mine");

    expect(result).toMatchObject({ status: "ok", threadId: "mine" });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.turns[0].messages).toEqual([{ role: "agent", text: "done" }]);
    expect(turnParams.itemsView).toBe("summary");
    expect(turnParams.sortDirection).toBe("desc");
  });
});
