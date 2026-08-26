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

/** The unambiguous parent: started with the terminal and still live. */
const rootThread = {
  id: "root",
  createdAt: codexTerminal.spawnedAt / 1000 + 1,
  recencyAt: codexTerminal.spawnedAt / 1000 + 60,
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
  const spawnedAt = spawnedAtMs / 1000;

  it("uses an exact session id without consulting the thread list", () => {
    const selection = selectParentThread([{ id: "other", recencyAt: spawnedAt }], {
      spawnedAtMs,
      agentSessionId: "known-thread",
    });
    expect(selection).toEqual({ parentThreadId: "known-thread", matchedBy: "session-id" });
  });

  it("ignores threads that are themselves subagents", () => {
    const selection = selectParentThread(
      [
        { id: "child", parentThreadId: "root", createdAt: spawnedAt, recencyAt: spawnedAt + 100 },
        { id: "root", parentThreadId: null, createdAt: spawnedAt, recencyAt: spawnedAt + 100 },
      ],
      { spawnedAtMs }
    );
    expect(selection.parentThreadId).toBe("root");
  });

  it("picks the session that started with this terminal, not the newest one", () => {
    // The regression this guards: terminal A launches, then two hours later a
    // second Codex session starts in the same folder and becomes the most
    // recently active. Ranking by recency would hand A the other session.
    const selection = selectParentThread(
      [
        {
          id: "other-terminal",
          createdAt: spawnedAt + 2 * 60 * 60,
          recencyAt: spawnedAt + 2 * 60 * 60,
        },
        { id: "mine", createdAt: spawnedAt + 2, recencyAt: spawnedAt + 30 * 60 },
      ],
      { spawnedAtMs }
    );
    expect(selection.parentThreadId).toBe("mine");
    expect(selection).toMatchObject({ matchedBy: "spawn-time" });
  });

  it("refuses to choose between two sessions that started together", () => {
    const selection = selectParentThread(
      [
        { id: "a", createdAt: spawnedAt + 1, recencyAt: spawnedAt + 60 },
        { id: "b", createdAt: spawnedAt + 3, recencyAt: spawnedAt + 60 },
      ],
      { spawnedAtMs }
    );
    // Guessing here is indistinguishable from being right, so it doesn't guess.
    expect(selection).toEqual({ parentThreadId: null, reason: "ambiguous-session" });
  });

  it("drops a session that had already gone quiet before the terminal launched", () => {
    const selection = selectParentThread(
      [
        { id: "abandoned", createdAt: spawnedAt - 10, recencyAt: spawnedAt - 6 * 60 * 60 },
        { id: "mine", createdAt: spawnedAt + 120, recencyAt: spawnedAt + 600 },
      ],
      { spawnedAtMs }
    );
    // `abandoned` starts closer to launch, but nothing has touched it since —
    // whatever this terminal is running, it isn't that.
    expect(selection.parentThreadId).toBe("mine");
  });

  it("keeps a lone live session even when it started long before the terminal", () => {
    // A hand-typed `codex resume` carries an old createdAt and no session id.
    const selection = selectParentThread(
      [{ id: "resumed", createdAt: spawnedAt - 3 * 24 * 60 * 60, recencyAt: spawnedAt + 60 }],
      { spawnedAtMs }
    );
    expect(selection.parentThreadId).toBe("resumed");
  });

  it("will not pick between roots when the terminal's launch time is unknown", () => {
    const threads = [
      { id: "a", createdAt: 10, recencyAt: 10 },
      { id: "b", createdAt: 20, recencyAt: 20 },
    ];
    expect(selectParentThread(threads, {})).toEqual({
      parentThreadId: null,
      reason: "ambiguous-session",
    });
    expect(selectParentThread([threads[0]!], {}).parentThreadId).toBe("a");
  });

  it("returns no parent when the cwd has no root threads", () => {
    expect(selectParentThread([], { spawnedAtMs })).toEqual({
      parentThreadId: null,
      reason: "no-session",
    });
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

  it("truncates a message that would otherwise flood IPC, keeping its start", () => {
    const text = `START${"x".repeat(20_000)}`;
    const turn = toSubagentTurn({ id: "turn-2", items: [{ type: "agentMessage", text }] });
    const kept = turn?.messages[0]?.text ?? "";
    expect(kept.length).toBeLessThan(text.length);
    expect(text.startsWith(kept)).toBe(true);
  });

  it("drops a turn that carried no readable message", () => {
    const turn = toSubagentTurn({ id: "turn-3", items: [{ type: "reasoning", content: [] }] });
    expect(turn?.messages).toEqual([]);
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
        return { data: [rootThread] };
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
        return { data: [rootThread] };
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
      matchedBy: "spawn-time",
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

  it("reports ambiguity instead of showing another session's children", async () => {
    getTerminalAsync.mockResolvedValue(codexTerminal);
    const methods: string[] = [];
    scriptSession((method, params) => {
      methods.push(method);
      if (method === "thread/list" && params.cwd) {
        return {
          data: [rootThread, { ...rootThread, id: "rival", createdAt: rootThread.createdAt + 2 }],
        };
      }
      return { data: [] };
    });

    await expect(listCodexSubagents("t1")).resolves.toEqual({
      status: "unavailable",
      reason: "ambiguous-session",
    });
    // Nothing is listed for an unresolved parent, so nothing can be shown.
    expect(methods.filter((method) => method === "thread/list")).toHaveLength(1);
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
  it("refuses to read anything while the parent is ambiguous", async () => {
    getTerminalAsync.mockResolvedValue(codexTerminal);
    const methods: string[] = [];
    scriptSession((method, params) => {
      methods.push(method);
      if (method === "thread/list" && params.cwd) {
        return {
          data: [rootThread, { ...rootThread, id: "rival", createdAt: rootThread.createdAt + 2 }],
        };
      }
      return { data: [] };
    });

    // Even a genuine child id must not resolve: ownership is unproven.
    await expect(readCodexSubagentTranscript("t1", "some-child")).resolves.toEqual({
      status: "unavailable",
      reason: "ambiguous-session",
    });
    expect(methods).not.toContain("thread/turns/list");
  });

  it("falls back to spawn-time matching when a recorded session id names no thread here", async () => {
    // `agentSessionId` is generic launch metadata — a pane launched as another
    // agent, or reused for a fresh session, carries an id that isn't ours.
    getTerminalAsync.mockResolvedValue({ ...codexTerminal, agentSessionId: "stale-or-foreign" });
    const methods: string[] = [];
    scriptSession((method, params) => {
      methods.push(method);
      if (method === "thread/read") return { thread: { id: params.threadId, cwd: "/elsewhere" } };
      if (method === "thread/list" && params.cwd) return { data: [rootThread] };
      if (method === "thread/list") return { data: [{ id: "mine" }] };
      if (method === "thread/turns/list") {
        return { data: [{ id: "t", items: [{ type: "agentMessage", text: "done" }] }] };
      }
      return {};
    });

    const result = await readCodexSubagentTranscript("t1", "mine");

    expect(result).toMatchObject({ status: "ok" });
    // The cwd query ran, which only happens when the recorded id was rejected.
    expect(methods).toContain("thread/read");
    expect(methods.filter((method) => method === "thread/list")).toHaveLength(2);
  });

  it("refuses a thread that is not a child of this terminal's session", async () => {
    getTerminalAsync.mockResolvedValue(codexTerminal);
    const methods: string[] = [];
    scriptSession((method, params) => {
      methods.push(method);
      if (method === "thread/list" && params.cwd) {
        return { data: [rootThread] };
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
        return { data: [rootThread] };
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
