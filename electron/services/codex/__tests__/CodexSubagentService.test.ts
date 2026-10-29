import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPtyClientRef } from "../../../window/serviceRefs.js";
import type { PtyClient } from "../../PtyClient.js";

const getTerminalAsync = vi.hoisted(() => vi.fn());
const runSession = vi.hoisted(() => vi.fn());

beforeEach(() => {
  setPtyClientRef({ getTerminalAsync } as unknown as PtyClient);
});

afterEach(() => {
  setPtyClientRef(null);
});

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
import { createHash } from "crypto";
import {
  listCodexSubagents,
  listCodexSessionsForCwd,
  listCodexThreadsCreatedSince,
  matchCodexRestoreSessions,
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

  it("refuses a pane whose Codex has exited back to the shell, without spawning anything", async () => {
    getTerminalAsync.mockResolvedValue({ ...codexTerminal, agentState: "exited" });
    await expect(listCodexSubagents("t1")).resolves.toEqual({
      status: "unavailable",
      reason: "provider-mismatch",
    });
    await expect(readCodexSubagentTranscript("t1", "child")).resolves.toMatchObject({
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

  it("reports terminal-unknown before the pty client exists, without building one", async () => {
    setPtyClientRef(null);
    await expect(listCodexSubagents("ghost")).resolves.toEqual({
      status: "unavailable",
      reason: "terminal-unknown",
    });
    expect(getTerminalAsync).not.toHaveBeenCalled();
    expect(runSession).not.toHaveBeenCalled();
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

  it("asks for the page size it was given and says when older threads were left off", async () => {
    let listParams: QueryParams = {};
    scriptSession((method, params) => {
      if (method === "thread/list") {
        listParams = params;
        return { data: [{ id: "root", sessionId: "root", recencyAt: 5 }], nextCursor: "page-2" };
      }
      return {};
    });

    const result = await listCodexSessionsForCwd("/repo", undefined, 50);

    expect(listParams.limit).toBe(50);
    expect(result).toEqual({
      status: "ok",
      sessions: [{ id: "root", preview: "", updatedAt: 5_000 }],
      more: true,
    });
  });

  it("calls the page whole when the server says it reached the end", async () => {
    scriptSession((method) =>
      method === "thread/list"
        ? {
            data: [
              { id: "a", sessionId: "a", recencyAt: 2 },
              { id: "b", sessionId: "b", recencyAt: 1 },
            ],
            nextCursor: null,
          }
        : {}
    );

    await expect(listCodexSessionsForCwd("/repo", undefined, 2)).resolves.toEqual({
      status: "ok",
      sessions: [
        { id: "a", preview: "", updatedAt: 2_000 },
        { id: "b", preview: "", updatedAt: 1_000 },
      ],
    });
  });

  it("reads a full page from a server that sends no cursor as possibly cut", async () => {
    scriptSession((method) =>
      method === "thread/list"
        ? {
            data: [
              { id: "a", sessionId: "a", recencyAt: 2 },
              { id: "b", sessionId: "b", recencyAt: 1 },
            ],
          }
        : {}
    );

    await expect(listCodexSessionsForCwd("/repo", undefined, 2)).resolves.toMatchObject({
      more: true,
    });
  });

  it("reports unavailable rather than throwing when Codex cannot be reached", async () => {
    runSession.mockRejectedValue(new CodexAppServerError("cli-missing", "no codex"));

    await expect(listCodexSessionsForCwd("/repo")).resolves.toMatchObject({
      status: "unavailable",
      reason: "cli-missing",
    });
  });
});

// issue #15269 — naming held same-folder panes' conversations by launch prompt.
describe("matchCodexRestoreSessions", () => {
  const AT = 1_800_000_000_000;
  const AT_S = AT / 1000;
  const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
  const pane = (key: string, text: string, resolve = true) => ({
    key,
    promptHash: hash(text),
    at: AT,
    resolve,
  });
  const row = (id: string, preview: string, createdAt = AT_S + 3, extra: QueryParams = {}) => ({
    id,
    sessionId: id,
    preview,
    source: "cli",
    createdAt,
    recencyAt: createdAt,
    ...extra,
  });

  /** Answers each `thread/list` from `pages` by cursor, and records every request. */
  function scriptPages(
    pages: Record<string, { data: unknown[]; nextCursor?: string | null }>,
    recency: unknown[] = []
  ): QueryParams[] {
    const requests: QueryParams[] = [];
    scriptSession((method, params) => {
      if (method !== "thread/list") return {};
      requests.push(params);
      if (params.sortKey === "recency_at") return { data: recency, nextCursor: null };
      const page = pages[(params.cursor as string | undefined) ?? "first"] ?? { data: [] };
      // Filters by source the way the server does: absent means interactive only.
      const kinds = (params.sourceKinds as string[] | undefined) ?? ["cli", "vscode"];
      return {
        ...page,
        data: page.data.filter((thread) =>
          kinds.includes((thread as { source?: string }).source ?? "cli")
        ),
      };
    });
    return requests;
  }

  it("names each pane's thread from the folder's threads, newest first by creation", async () => {
    const requests = scriptPages({
      first: { data: [row("t-b", "Task B"), row("t-a", "Task A")], nextCursor: null },
    });

    const result = await matchCodexRestoreSessions({
      scopes: [{ cwd: "/repo", panes: [pane("a", "Task A"), pane("b", "Task B")] }],
      exclude: [],
    });

    expect(result).toEqual({
      matches: [
        { key: "a", sessionId: "t-a" },
        { key: "b", sessionId: "t-b" },
      ],
    });
    expect(requests[0]).toMatchObject({
      cwd: ["/repo"],
      sortKey: "created_at",
      sortDirection: "desc",
      useStateDbOnly: true,
    });
    // A pane launched with `codex exec` has a thread too, and it has to count.
    expect(requests[0]?.sourceKinds).toEqual(expect.arrayContaining(["cli", "exec"]));
    expect(requests[0]).not.toHaveProperty("archived");
  });

  it("follows the cursor and stops at the first thread older than every launch", async () => {
    const requests = scriptPages({
      first: { data: [row("t-new", "Later work", AT_S + 900)], nextCursor: "page-2" },
      "page-2": {
        data: [row("t-a", "Task A"), row("t-old", "Task A", AT_S - 3_600)],
        nextCursor: "page-3",
      },
    });

    const result = await matchCodexRestoreSessions({
      scopes: [{ cwd: "/repo", panes: [pane("a", "Task A")] }],
      exclude: [],
    });

    expect(result.matches).toEqual([{ key: "a", sessionId: "t-a" }]);
    expect(requests.map((request) => request.cursor)).toEqual([undefined, "page-2"]);
  });

  it("answers nothing when the history can't be read to the earliest launch", async () => {
    // The first page holds the answer, but every page after it stays inside
    // the launch window, so the cap ends the walk before the cut-off can prove
    // nothing older shares the prompt.
    scriptSession((method, params) => {
      if (method !== "thread/list") return {};
      const page = Number((params.cursor as string | undefined) ?? 0);
      return {
        data: [page === 0 ? row("t-a", "Task A") : row(`t-${page}`, "Other", AT_S + 2)],
        nextCursor: String(page + 1),
      };
    });

    const result = await matchCodexRestoreSessions({
      scopes: [{ cwd: "/repo", panes: [pane("a", "Task A")] }],
      exclude: [],
    });

    expect(result.matches).toEqual([]);
  });

  it("answers nothing when rows arrive out of creation order", async () => {
    scriptPages({
      first: {
        data: [row("t-a", "Task A"), row("t-later", "Other", AT_S + 60)],
        nextCursor: null,
      },
    });

    const result = await matchCodexRestoreSessions({
      scopes: [{ cwd: "/repo", panes: [pane("a", "Task A")] }],
      exclude: [],
    });

    expect(result.matches).toEqual([]);
  });

  it.each([
    ["a full page", 50],
    ["a short page", 2],
  ])("answers nothing when %s doesn't say whether more follow", async (_label, length) => {
    scriptPages({
      first: {
        data: Array.from({ length }, (_, i) => row(`t-${i}`, `Task ${i}`, AT_S + 100 - i)),
      },
    });

    const result = await matchCodexRestoreSessions({
      scopes: [{ cwd: "/repo", panes: [pane("a", "Task 1")] }],
      exclude: [],
    });

    expect(result.matches).toEqual([]);
  });

  it("answers nothing when a row past the cut-off is out of order", async () => {
    scriptPages({
      first: {
        data: [row("t-a", "Task A"), row("t-old", "Old", AT_S - 3_600), row("t-b", "Other")],
        nextCursor: null,
      },
    });

    const result = await matchCodexRestoreSessions({
      scopes: [{ cwd: "/repo", panes: [pane("a", "Task A")] }],
      exclude: [],
    });

    expect(result.matches).toEqual([]);
  });

  it.each([
    ["a root with no id", { id: undefined, sessionId: undefined }],
    ["a root with no first message", { preview: undefined }],
    ["a root whose first message isn't text", { preview: [] }],
  ])("answers nothing when it reads %s", async (_label, broken) => {
    scriptPages({
      first: { data: [row("t-a", "Task A"), row("t-x", "x", AT_S + 2, broken)], nextCursor: null },
    });

    const result = await matchCodexRestoreSessions({
      scopes: [{ cwd: "/repo", panes: [pane("a", "Task A")] }],
      exclude: [],
    });

    expect(result.matches).toEqual([]);
  });

  it.each([
    [
      "creation times",
      [row("t-x", "Task A", AT_S + 900), row("t-y", "Task A"), row("t-x", "Task A")],
    ],
    ["first messages", [row("t-y", "Task A"), row("t-x", "Other"), row("t-x", "Task A")]],
  ])("answers nothing when one thread is listed twice with different %s", async (_label, data) => {
    scriptPages({ first: { data, nextCursor: null } });

    const result = await matchCodexRestoreSessions({
      scopes: [{ cwd: "/repo", panes: [pane("a", "Task A")] }],
      exclude: [],
    });

    expect(result.matches).toEqual([]);
  });

  it.each(["vscode", "exec", "appServer", "unknown"])(
    "counts a %s thread as a rival to a cli one",
    async (source) => {
      scriptPages({
        first: {
          data: [row("t-rival", "Task A", AT_S + 4, { source }), row("t-a", "Task A")],
          nextCursor: null,
        },
      });

      const result = await matchCodexRestoreSessions({
        scopes: [{ cwd: "/repo", panes: [pane("a", "Task A")] }],
        exclude: [],
      });

      expect(result.matches).toEqual([]);
    }
  );

  /** `--last`'s read, newest first; t-b is the top unless a row says otherwise. */
  function scriptLatest(recency: unknown[], nextCursor: string | null) {
    scriptSession((method, params) => {
      if (method !== "thread/list") return {};
      if (params.sortKey === "recency_at") return { data: recency, nextCursor };
      return { data: [row("t-b", "Task B", AT_S + 4), row("t-a", "Task A")], nextCursor: null };
    });
  }
  const top = row("t-b", "Task B", AT_S + 3, { recencyAt: AT_S + 50 });

  it.each([
    ["a root below the top", [top, row("t-old", "Old", AT_S - 900, { recencyAt: AT_S - 900 })]],
    [
      "a child below the top",
      [top, row("t-kid", "Kid", AT_S + 3, { recencyAt: AT_S + 10, parentThreadId: "t-b" })],
    ],
  ])("settles `--last` mid-listing once it reaches %s", async (_label, recency) => {
    scriptLatest(recency, "more");

    const result = await matchCodexRestoreSessions({
      scopes: [
        { cwd: "/repo", reserveLatest: true, panes: [pane("a", "Task A"), pane("b", "Task B")] },
      ],
      exclude: [],
    });

    expect(result.matches).toEqual([{ key: "a", sessionId: "t-a" }]);
  });

  it.each([
    ["a malformed row", [top, null, row("t-old", "Old", AT_S - 900, { recencyAt: AT_S - 900 })]],
    [
      "a row with no recency",
      [top, row("t-x", "X", AT_S, { recencyAt: null }), row("t-old", "Old", AT_S - 900)],
    ],
    [
      "a child with no recency",
      [
        top,
        row("t-kid", "Kid", AT_S, { recencyAt: null, parentThreadId: "t-b" }),
        row("t-old", "Old", AT_S - 900),
      ],
    ],
    ["only children", [row("t-kid", "Kid", AT_S + 3, { parentThreadId: "t-b" })]],
    ["an empty page", []],
  ])("answers nothing when the `--last` read holds %s with more to come", async (_l, recency) => {
    scriptLatest(recency, "more");

    const result = await matchCodexRestoreSessions({
      scopes: [{ cwd: "/repo", reserveLatest: true, panes: [pane("a", "Task A")] }],
      exclude: [],
    });

    expect(result.matches).toEqual([]);
  });

  it("counts a `codex exec` thread as a rival but never hands it out", async () => {
    scriptPages({
      first: {
        data: [
          row("t-exec", "Task A", AT_S + 4, { source: "exec" }),
          row("t-a", "Task A"),
          row("t-only-exec", "Task B", AT_S + 2, { source: "exec" }),
        ],
        nextCursor: null,
      },
    });

    const result = await matchCodexRestoreSessions({
      scopes: [{ cwd: "/repo", panes: [pane("a", "Task A"), pane("b", "Task B")] }],
      exclude: [],
    });

    expect(result.matches).toEqual([]);
  });

  it("matches only root threads", async () => {
    scriptPages({
      first: {
        data: [row("t-child", "Task A", AT_S + 4, { parentThreadId: "t-a" }), row("t-a", "Task A")],
        nextCursor: null,
      },
    });

    const result = await matchCodexRestoreSessions({
      scopes: [{ cwd: "/repo", panes: [pane("a", "Task A")] }],
      exclude: [],
    });

    expect(result.matches).toEqual([{ key: "a", sessionId: "t-a" }]);
  });

  it("answers nothing when the tie for `--last` may run on past the page", async () => {
    scriptSession((method, params) => {
      if (method !== "thread/list") return {};
      if (params.sortKey === "recency_at") {
        // Only the top of a tie that the next page may continue: t-a could be in it.
        return {
          data: [row("t-b", "Task B", AT_S + 3, { recencyAt: AT_S + 50 })],
          nextCursor: "more",
        };
      }
      return { data: [row("t-b", "Task B", AT_S + 4), row("t-a", "Task A")], nextCursor: null };
    });

    const result = await matchCodexRestoreSessions({
      scopes: [
        { cwd: "/repo", reserveLatest: true, panes: [pane("a", "Task A"), pane("b", "Task B")] },
      ],
      exclude: [],
    });

    expect(result.matches).toEqual([]);
  });

  it("keeps the thread a sibling's `--last` would open for that sibling", async () => {
    scriptPages(
      { first: { data: [row("t-b", "Task B"), row("t-a", "Task A")], nextCursor: null } },
      [row("t-b", "Task B", AT_S + 3, { recencyAt: AT_S + 50 }), row("t-a", "Task A")]
    );

    const result = await matchCodexRestoreSessions({
      scopes: [
        {
          cwd: "/repo",
          reserveLatest: true,
          panes: [pane("a", "Task A"), pane("b", "Task B")],
        },
      ],
      exclude: [],
    });

    expect(result.matches).toEqual([{ key: "a", sessionId: "t-a" }]);
  });

  it("never names a thread another pane already holds", async () => {
    scriptPages({ first: { data: [row("t-a", "Task A")], nextCursor: null } });

    const result = await matchCodexRestoreSessions({
      scopes: [{ cwd: "/repo", panes: [pane("a", "Task A")] }],
      exclude: ["t-a"],
    });

    expect(result.matches).toEqual([]);
  });

  it("never names a thread whose id isn't safe to put on a command line", async () => {
    scriptPages({ first: { data: [row("t a;rm", "Task A")], nextCursor: null } });

    const result = await matchCodexRestoreSessions({
      scopes: [{ cwd: "/repo", panes: [pane("a", "Task A")] }],
      exclude: [],
    });

    expect(result.matches).toEqual([]);
  });

  it("asks each profile under its own CODEX_HOME, on the restore budget", async () => {
    scriptPages({ first: { data: [row("t-a", "Task A")], nextCursor: null } });

    await matchCodexRestoreSessions({
      scopes: [
        { cwd: "/repo", panes: [pane("a", "Task A")] },
        { cwd: "/repo", codexHome: "/profiles/work", panes: [pane("b", "Task B")] },
      ],
      exclude: [],
    });

    const options = runSession.mock.calls.map(
      (call) => call[1] as { codexHome?: string; timeoutMs?: number }
    );
    expect(options.map((option) => option.codexHome)).toEqual([undefined, "/profiles/work"]);
    expect(options.every((option) => option.timeoutMs === 2_000)).toBe(true);
  });

  it("answers nothing, rather than throwing, when Codex can't be reached", async () => {
    runSession.mockRejectedValue(new CodexAppServerError("timeout", "slow"));

    await expect(
      matchCodexRestoreSessions({
        scopes: [{ cwd: "/repo", panes: [pane("a", "Task A")] }],
        exclude: [],
      })
    ).resolves.toEqual({ matches: [] });
  });

  it("answers nothing for a request that names one pane twice", async () => {
    scriptPages({ first: { data: [row("t-a", "Task A")], nextCursor: null } });

    const result = await matchCodexRestoreSessions({
      scopes: [
        { cwd: "/repo", panes: [pane("a", "Task A")] },
        { cwd: "/other", panes: [pane("a", "Task A")] },
      ],
      exclude: [],
    });

    expect(result.matches).toEqual([]);
    expect(runSession).not.toHaveBeenCalled();
  });
});

describe("listCodexThreadsCreatedSince (#15268)", () => {
  it("reads the folder's root threads created in the window, newest first", async () => {
    const calls: QueryParams[] = [];
    scriptSession((method, params) => {
      if (method !== "thread/list") return {};
      calls.push(params);
      return {
        data: [
          { id: "new", preview: "triage #2", createdAt: 120 },
          { id: "child", parentThreadId: "new", preview: "sub", createdAt: 115 },
          { id: "root", sessionId: "root-session", preview: "triage #1", createdAt: 110 },
          { id: "old", preview: "triage #0", createdAt: 90 },
        ],
        nextCursor: "more",
      };
    });

    await expect(listCodexThreadsCreatedSince(["/tmp/repo"], 100)).resolves.toEqual([
      { sessionId: "new", preview: "triage #2", createdAt: 120 },
      { sessionId: "root-session", preview: "triage #1", createdAt: 110 },
    ]);
    // Passing the window ends the walk even though the server has more.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      cwd: ["/tmp/repo", "/private/tmp/repo"],
      sortKey: "created_at",
      sortDirection: "desc",
      useStateDbOnly: true,
    });
    expect(calls[0]).not.toHaveProperty("sourceKinds");
    expect(calls[0]).not.toHaveProperty("archived");
    expect(calls[0]).not.toHaveProperty("searchTerm");
  });

  it("follows the cursor until the window is covered", async () => {
    const cursors: unknown[] = [];
    scriptSession((method, params) => {
      if (method !== "thread/list") return {};
      cursors.push(params.cursor);
      return params.cursor === undefined
        ? { data: [{ id: "a", preview: "a", createdAt: 130 }], nextCursor: "page-2" }
        : { data: [{ id: "b", preview: "b", createdAt: 120 }], nextCursor: null };
    });

    const threads = await listCodexThreadsCreatedSince(["/repo"], 100);

    expect(threads?.map((thread) => thread.sessionId)).toEqual(["a", "b"]);
    expect(cursors).toEqual([undefined, "page-2"]);
  });

  it("answers null when the window outruns the page budget", async () => {
    let page = 0;
    scriptSession((method) => {
      if (method !== "thread/list") return {};
      page += 1;
      return { data: [{ id: `t${page}`, createdAt: 200 - page }], nextCursor: `c${page}` };
    });

    // A thread left unread could be the rival that makes a match ambiguous.
    await expect(listCodexThreadsCreatedSince(["/repo"], 100)).resolves.toBeNull();
    expect(page).toBe(4);
  });

  it("asks for every spelling of the folder its panes use", async () => {
    let cwd: unknown;
    scriptSession((method, params) => {
      if (method === "thread/list") cwd = params.cwd;
      return { data: [], nextCursor: null };
    });

    await listCodexThreadsCreatedSince(["/tmp/repo", "/private/tmp/repo", "/repo"], 100);

    expect(cwd).toEqual(["/tmp/repo", "/private/tmp/repo", "/repo"]);
  });

  it("answers null when a later page comes back malformed", async () => {
    scriptSession((method, params) => {
      if (method !== "thread/list") return {};
      return params.cursor === undefined
        ? { data: [{ id: "a", createdAt: 150 }], nextCursor: "page-2" }
        : { nextCursor: null };
    });

    // Page one alone would read as the whole window and hide a rival.
    await expect(listCodexThreadsCreatedSince(["/repo"], 100)).resolves.toBeNull();
  });

  it("answers null for an undated row or a failed session", async () => {
    scriptSession((method) =>
      method === "thread/list" ? { data: [{ id: "x", preview: "x" }], nextCursor: null } : {}
    );
    await expect(listCodexThreadsCreatedSince(["/repo"], 100)).resolves.toBeNull();

    runSession.mockRejectedValueOnce(new CodexAppServerError("cli-missing", "no codex"));
    await expect(listCodexThreadsCreatedSince(["/repo"], 100)).resolves.toBeNull();
  });

  it("skips an id that could not be handed to `codex resume`", async () => {
    scriptSession((method) =>
      method === "thread/list"
        ? {
            data: [
              { id: "ok-id", createdAt: 150 },
              { id: "bad id; rm -rf", createdAt: 140 },
            ],
            nextCursor: null,
          }
        : {}
    );

    const threads = await listCodexThreadsCreatedSince(["/repo"], 100);
    expect(threads?.map((thread) => thread.sessionId)).toEqual(["ok-id"]);
  });

  it("runs against the pane's own profile", async () => {
    scriptSession(() => ({ data: [], nextCursor: null }));

    await listCodexThreadsCreatedSince(["/repo"], 100, "/profiles/work");

    expect(runSession).toHaveBeenLastCalledWith(
      expect.any(Function),
      expect.objectContaining({ codexHome: "/profiles/work" })
    );
  });
});
