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
  listCodexSessionsForCwd,
  readCodexSubagentTranscript,
  resolveCodexResumeLatestSession,
  selectParentThread,
  selectResumeLatestThread,
  toSubagent,
  toSubagentStatus,
  toSubagentMessages,
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
  it("names the reason a child is blocked rather than just that it is", () => {
    expect(toSubagentStatus({ type: "active", activeFlags: ["waitingOnApproval"] })).toEqual({
      type: "blocked",
      reason: "approval",
    });
    expect(toSubagentStatus({ type: "active", activeFlags: ["waitingOnUserInput"] })).toEqual({
      type: "blocked",
      reason: "input",
    });
  });

  it("reports the approval when a child is held on both, since typing cannot clear it", () => {
    expect(
      toSubagentStatus({
        type: "active",
        activeFlags: ["waitingOnUserInput", "waitingOnApproval"],
      })
    ).toEqual({ type: "blocked", reason: "approval" });
  });

  it("ignores flags the protocol did not define rather than passing them through", () => {
    expect(toSubagentStatus({ type: "active", activeFlags: ["bogus"] })).toEqual({
      type: "working",
    });
  });

  it("separates a thread the protocol declined to load from one it described strangely", () => {
    expect(toSubagentStatus({ type: "notLoaded" })).toEqual({
      type: "unknown",
      reason: "not-loaded",
    });
    expect(toSubagentStatus({ type: "somethingNew" })).toEqual({
      type: "unknown",
      reason: "unrecognized",
    });
    expect(toSubagentStatus(null)).toEqual({ type: "unknown", reason: "unrecognized" });
  });
});

describe("toSubagent", () => {
  it("converts the protocol's Unix seconds to milliseconds", () => {
    const subagent = toSubagent({ id: "t", createdAt: 1_730_831_111, updatedAt: 1_730_831_222 });
    expect(subagent?.createdAt).toBe(1_730_831_111_000);
    expect(subagent?.updatedAt).toBe(1_730_831_222_000);
  });

  it("maps the nickname into the shared label so one row renderer serves both agents", () => {
    const subagent = toSubagent({ id: "t", agentNickname: "Meitner", agentRole: "reviewer" });
    expect(subagent?.label).toBe("Meitner");
    expect(subagent?.role).toBe("reviewer");
  });

  it("reports no model or depth rather than inventing values the protocol never sent", () => {
    const subagent = toSubagent({ id: "t", agentNickname: "Meitner" });
    expect(subagent?.model).toBeNull();
    expect(subagent?.depth).toBeNull();
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
    // A subagent is never a parent, so one root remains and it is answerable.
    expect(selection.parentThreadId).toBe("root");
  });

  it("refuses to choose whenever two sessions were live in this folder", () => {
    // The regression this guards: any ranking — by recency, or by closeness to
    // launch — picks one of these, and the wrong list is indistinguishable
    // from the right one.
    const selection = selectParentThread(
      [
        { id: "mine", createdAt: spawnedAt + 2, recencyAt: spawnedAt + 30 * 60 },
        {
          id: "other-terminal",
          createdAt: spawnedAt + 2 * 60 * 60,
          recencyAt: spawnedAt + 2 * 60 * 60,
        },
      ],
      { spawnedAtMs }
    );
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
    // Yesterday's session in the same folder must not make today's ambiguous.
    expect(selection).toEqual({ parentThreadId: "mine", matchedBy: "spawn-time" });
  });

  it("keeps a lone live session even when it started long before the terminal", () => {
    // A hand-typed `codex resume` carries an old createdAt and no session id;
    // its liveness is what identifies it.
    const selection = selectParentThread(
      [{ id: "resumed", createdAt: spawnedAt - 3 * 24 * 60 * 60, recencyAt: spawnedAt + 60 }],
      { spawnedAtMs }
    );
    expect(selection.parentThreadId).toBe("resumed");
  });

  it("falls back to updatedAt then createdAt when recencyAt is absent", () => {
    const quiet = selectParentThread(
      [{ id: "stale", recencyAt: null, updatedAt: spawnedAt - 60 * 60 }],
      { spawnedAtMs }
    );
    expect(quiet.parentThreadId).toBeNull();

    const live = selectParentThread([{ id: "live", recencyAt: null, updatedAt: spawnedAt + 60 }], {
      spawnedAtMs,
    });
    expect(live.parentThreadId).toBe("live");
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

describe("toSubagentMessages", () => {
  it("keeps the task and the reply and drops the reasoning between them", () => {
    const messages = toSubagentMessages({
      id: "turn-1",
      items: [
        { type: "userMessage", content: [{ type: "text", text: "review the diff" }] },
        { type: "reasoning", summary: [], content: [] },
        { type: "agentMessage", text: "Looks fine" },
      ],
    });

    expect(messages).toEqual([
      { role: "task", text: "review the diff" },
      { role: "reply", text: "Looks fine" },
    ]);
  });

  it("truncates a message that would otherwise flood IPC, keeping its start", () => {
    const text = `START${"x".repeat(20_000)}`;
    const kept =
      toSubagentMessages({ id: "turn-2", items: [{ type: "agentMessage", text }] })[0]?.text ?? "";
    expect(kept.length).toBeLessThan(text.length);
    // Without this the assertion below is vacuous: every string starts with "".
    expect(kept.startsWith("START")).toBe(true);
    expect(text.startsWith(kept)).toBe(true);
  });

  it("has nothing to show for a turn that carried no readable message", () => {
    expect(
      toSubagentMessages({ id: "turn-3", items: [{ type: "reasoning", content: [] }] })
    ).toEqual([]);
  });
});

describe("listCodexSubagents", () => {
  it("refuses a terminal that is not running Codex", async () => {
    getTerminalAsync.mockResolvedValue({ cwd: "/repo", launchAgentId: "claude" });
    await expect(listCodexSubagents("t1")).resolves.toEqual({
      status: "unavailable",
      reason: "provider-mismatch",
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

    expect(result).toMatchObject({ status: "ok", provider: "codex", parentId: "root" });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.subagents.map((s) => s.id)).toEqual(["newer", "older"]);
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
        return { data: [rootThread, { ...rootThread, id: "rival" }] };
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
        return { data: [rootThread, { ...rootThread, id: "rival" }] };
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

  it("rejects a recorded session id whose thread went quiet before this launch", async () => {
    // A pane whose agent exited and was reused carries the previous session's
    // id — right folder, wrong session.
    getTerminalAsync.mockResolvedValue({ ...codexTerminal, agentSessionId: "previous-session" });
    const methods: string[] = [];
    scriptSession((method, params) => {
      methods.push(method);
      if (method === "thread/read") {
        return {
          thread: {
            id: params.threadId,
            cwd: "/repo",
            recencyAt: codexTerminal.spawnedAt / 1000 - 60 * 60,
          },
        };
      }
      if (method === "thread/list" && params.cwd) return { data: [rootThread] };
      if (method === "thread/list") return { data: [{ id: "mine" }] };
      if (method === "thread/turns/list") {
        return { data: [{ id: "t", items: [{ type: "agentMessage", text: "done" }] }] };
      }
      return {};
    });

    const result = await readCodexSubagentTranscript("t1", "mine");

    // The recorded id was in the right folder, so only liveness rules it out;
    // resolution then falls through to the folder's live root.
    expect(result).toMatchObject({ status: "ok" });
    expect(methods.filter((method) => method === "thread/list")).toHaveLength(2);
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

    expect(result).toEqual({ status: "unavailable", reason: "subagent-not-found" });
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

    expect(result).toMatchObject({ status: "ok", subagentId: "mine" });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.messages).toEqual([{ role: "reply", text: "done" }]);
    expect(turnParams.itemsView).toBe("summary");
    expect(turnParams.sortDirection).toBe("desc");
  });
});

describe("selectResumeLatestThread", () => {
  it("picks the most recent root, which is what `codex resume --last` opens", () => {
    expect(
      selectResumeLatestThread([
        { id: "older", sessionId: "older", recencyAt: 100 },
        { id: "newest", sessionId: "newest", recencyAt: 300 },
        { id: "middle", sessionId: "middle", recencyAt: 200 },
      ])
    ).toEqual({ sessionId: "newest" });
  });

  it("returns the session id, not the thread id, when the protocol distinguishes them", () => {
    expect(
      selectResumeLatestThread([{ id: "thread-abc", sessionId: "session-xyz", recencyAt: 10 }])
    ).toEqual({ sessionId: "session-xyz" });
  });

  it("falls back to the thread id when a server omits sessionId", () => {
    expect(selectResumeLatestThread([{ id: "thread-abc", recencyAt: 10 }])).toEqual({
      sessionId: "thread-abc",
    });
  });

  it("ignores subagent threads, which `--last` never opens", () => {
    expect(
      selectResumeLatestThread([
        { id: "child", sessionId: "root", parentThreadId: "root", recencyAt: 900 },
        { id: "root", sessionId: "root", recencyAt: 100 },
      ])
    ).toEqual({ sessionId: "root" });
  });

  it("refuses a tie at the top rather than guessing Codex's own tie-break", () => {
    expect(
      selectResumeLatestThread([
        { id: "a", sessionId: "a", recencyAt: 500 },
        { id: "b", sessionId: "b", recencyAt: 500 },
      ])
    ).toEqual({ sessionId: null });
  });

  it("is not made ambiguous by a tie below the winner", () => {
    expect(
      selectResumeLatestThread([
        { id: "winner", sessionId: "winner", recencyAt: 900 },
        { id: "a", sessionId: "a", recencyAt: 500 },
        { id: "b", sessionId: "b", recencyAt: 500 },
      ])
    ).toEqual({ sessionId: "winner" });
  });

  it("does not read a repeated row as a rival to itself", () => {
    expect(
      selectResumeLatestThread([
        { id: "same", sessionId: "same", recencyAt: 500 },
        { id: "same", sessionId: "same", recencyAt: 500 },
      ])
    ).toEqual({ sessionId: "same" });
  });

  it("ranks on updatedAt then createdAt when recencyAt is absent", () => {
    expect(
      selectResumeLatestThread([
        { id: "created-only", sessionId: "created-only", createdAt: 800 },
        { id: "updated", sessionId: "updated", updatedAt: 900 },
      ])
    ).toEqual({ sessionId: "updated" });
  });

  it("reports nothing for an empty or unusable page", () => {
    expect(selectResumeLatestThread([])).toEqual({ sessionId: null });
    expect(selectResumeLatestThread([{ recencyAt: 5 }, { id: 42 }])).toEqual({ sessionId: null });
  });

  it("drops an id that could not be spliced into a shell command safely", () => {
    expect(
      selectResumeLatestThread([{ id: "a; rm -rf /", sessionId: "a; rm -rf /", recencyAt: 900 }])
    ).toEqual({ sessionId: null });
  });
});

describe("resolveCodexResumeLatestSession", () => {
  it("queries the folder the way `--last` selects, and answers with the session id", async () => {
    let listParams: QueryParams = {};
    scriptSession((method, params) => {
      if (method === "thread/list") {
        listParams = params;
        return { data: [{ id: "root", sessionId: "root", recencyAt: 10 }] };
      }
      return {};
    });

    await expect(resolveCodexResumeLatestSession("/repo")).resolves.toBe("root");

    expect(listParams.cwd).toEqual(["/repo"]);
    expect(listParams.sortKey).toBe("recency_at");
    expect(listParams.sortDirection).toBe("desc");
    expect(listParams.useStateDbOnly).toBe(true);
    // `sourceKinds` omitted means the server's interactive-only default, which
    // is exactly what `--last` uses without `--include-non-interactive`. Naming
    // the kinds would change the filter rather than restate it.
    expect(listParams).not.toHaveProperty("sourceKinds");
    expect(listParams).not.toHaveProperty("archived");
  });

  it("asks under both spellings of a symlinked path, since the cwd filter is exact", async () => {
    let listParams: QueryParams = {};
    scriptSession((method, params) => {
      if (method === "thread/list") {
        listParams = params;
        return { data: [] };
      }
      return {};
    });

    await resolveCodexResumeLatestSession("/tmp/repo");

    expect(listParams.cwd).toEqual(["/tmp/repo", "/private/tmp/repo"]);
  });

  it("answers null when the folder has no session, so restore keeps plain --last", async () => {
    scriptSession(() => ({ data: [] }));
    await expect(resolveCodexResumeLatestSession("/repo")).resolves.toBeNull();
  });

  it("answers null rather than throwing when Codex cannot be reached", async () => {
    runSession.mockRejectedValue(new CodexAppServerError("cli-missing", "no codex"));
    await expect(resolveCodexResumeLatestSession("/repo")).resolves.toBeNull();
  });
});

describe("resolveCodexResumeLatestSession budget", () => {
  it("runs on a restore-sized budget rather than the transport default", async () => {
    // Restore blocks on this before it can launch the pane, so it has to give
    // up long before the transport's 15s whole-session default would.
    scriptSession(() => ({ data: [] }));

    await resolveCodexResumeLatestSession("/repo");

    const options = runSession.mock.calls[0]?.[1] as { timeoutMs?: number } | undefined;
    expect(options?.timeoutMs).toBe(2_000);
  });
});

// issue #12182 — "Find session" on the lost-session banner.
describe("listCodexSessionsForCwd", () => {
  it("queries the folder's root threads and maps them for the picker", async () => {
    let listParams: QueryParams = {};
    scriptSession((method, params) => {
      if (method === "thread/list") {
        listParams = params;
        return {
          data: [
            { id: "root-1", sessionId: "root-1", preview: "fix the flaky test", recencyAt: 20 },
            { id: "root-2", preview: "add the banner", updatedAt: 10 },
          ],
        };
      }
      return {};
    });

    const result = await listCodexSessionsForCwd("/repo");

    expect(result).toEqual({
      status: "ok",
      sessions: [
        { id: "root-1", preview: "fix the flaky test", updatedAt: 20_000 },
        { id: "root-2", preview: "add the banner", updatedAt: 10_000 },
      ],
    });
    expect(listParams.cwd).toEqual(["/repo"]);
    expect(listParams.sortKey).toBe("recency_at");
    expect(listParams.sortDirection).toBe("desc");
    expect(listParams.useStateDbOnly).toBe(true);
    // Same non-archived, interactive-only default the resume-latest lookup
    // and picker share — naming either would broaden the filter, not restate it.
    expect(listParams).not.toHaveProperty("sourceKinds");
    expect(listParams).not.toHaveProperty("archived");
  });

  it("excludes subagent threads — a picker only offers root conversations", async () => {
    scriptSession((method) => {
      if (method === "thread/list") {
        return {
          data: [
            { id: "root", sessionId: "root", recencyAt: 5 },
            { id: "child", parentThreadId: "root", recencyAt: 6 },
          ],
        };
      }
      return {};
    });

    const result = await listCodexSessionsForCwd("/repo");

    expect(result).toEqual({
      status: "ok",
      sessions: [{ id: "root", preview: "", updatedAt: 5_000 }],
    });
  });

  it("orders sessions most-recently-active first", async () => {
    scriptSession((method) => {
      if (method === "thread/list") {
        return {
          data: [
            { id: "older", sessionId: "older", recencyAt: 1 },
            { id: "newer", sessionId: "newer", recencyAt: 99 },
          ],
        };
      }
      return {};
    });

    const result = await listCodexSessionsForCwd("/repo");

    expect(result.status).toBe("ok");
    expect(result.status === "ok" ? result.sessions.map((s) => s.id) : []).toEqual([
      "newer",
      "older",
    ]);
  });

  it("drops a thread with no usable id rather than throwing", async () => {
    scriptSession((method) => {
      if (method === "thread/list") {
        return { data: [{ preview: "no id at all", recencyAt: 1 }] };
      }
      return {};
    });

    await expect(listCodexSessionsForCwd("/repo")).resolves.toEqual({ status: "ok", sessions: [] });
  });

  it("drops a thread whose id doesn't match the session-id shape", async () => {
    // The id reaches buildResumeCommand and is interpolated into a shell
    // command the instant it's picked — never trust it unvalidated off the wire.
    scriptSession((method) => {
      if (method === "thread/list") {
        return {
          data: [
            { id: "ok-thread", sessionId: "ok-thread", recencyAt: 5 },
            { id: "bad; rm -rf /", sessionId: "bad; rm -rf /", recencyAt: 6 },
          ],
        };
      }
      return {};
    });

    const result = await listCodexSessionsForCwd("/repo");

    expect(result).toEqual({
      status: "ok",
      sessions: [{ id: "ok-thread", preview: "", updatedAt: 5_000 }],
    });
  });

  it("asks under both spellings of a symlinked path, since the cwd filter is exact", async () => {
    let listParams: QueryParams = {};
    scriptSession((method, params) => {
      if (method === "thread/list") {
        listParams = params;
        return { data: [] };
      }
      return {};
    });

    await listCodexSessionsForCwd("/tmp/repo");

    expect(listParams.cwd).toEqual(["/tmp/repo", "/private/tmp/repo"]);
  });

  it("forwards codexHome to the session so the query runs against the pane's own profile", async () => {
    scriptSession(() => ({ data: [] }));

    await listCodexSessionsForCwd("/repo", "/pane/.codex");

    const options = runSession.mock.calls[0]?.[1] as { codexHome?: string } | undefined;
    expect(options?.codexHome).toBe("/pane/.codex");
  });

  it("reports unavailable rather than throwing when Codex cannot be reached", async () => {
    runSession.mockRejectedValue(new CodexAppServerError("cli-missing", "no codex"));

    await expect(listCodexSessionsForCwd("/repo")).resolves.toMatchObject({
      status: "unavailable",
      reason: "cli-missing",
    });
  });
});
