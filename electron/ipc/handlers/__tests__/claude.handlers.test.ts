import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcContext } from "../../types.js";
import type { AgentContextUsageResult } from "../../../../shared/types/ipc/agentContextUsage.js";

const replyCopyMock = vi.hoisted(() => ({
  findClaudeReplySpan: vi.fn(
    async (_terminalId: string, _selection: string, _signal: AbortSignal): Promise<string | null> =>
      "**the reply**"
  ),
}));

vi.mock("../../../services/claude/ClaudeReplyCopy.js", () => replyCopyMock);

const usageMock = vi.hoisted(() => ({
  readClaudeUsageAccounts: vi.fn(async () => [
    { key: "k1", kind: "default", accountNames: [], readings: [] },
  ]),
}));

vi.mock("../../../services/claude/ClaudeUsageService.js", () => usageMock);

const contextUsageMock = vi.hoisted(() => ({
  readClaudePaneContextUsage: vi.fn(
    async (_terminalId: string, _signal: AbortSignal): Promise<AgentContextUsageResult> => ({
      status: "ok",
      provider: "claude",
      contextTokens: 126_717,
      recordedAt: 1_700_000_000_000,
    })
  ),
}));

vi.mock("../../../services/claude/ClaudeContextUsage.js", () => contextUsageMock);

import { claudeNamespace } from "../claude.js";
import { REPLY_SPAN_HOST_TIMEOUT_MS } from "../../../../shared/config/replySpanLimits.js";

function ctx(client: "local" | "remote", endpoint: "local-view" | "remote-view"): IpcContext {
  return {
    client: { kind: client },
    endpoint: { kind: endpoint },
  } as unknown as IpcContext;
}

type FindHandler = (
  context: IpcContext,
  payload: { terminalId: string; selection: string }
) => Promise<string | null>;

const find = claudeNamespace.ops.findReplySpan.handler as unknown as FindHandler;

describe("claude.findReplySpan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers a local view with the span the host found", async () => {
    const result = await find(ctx("local", "local-view"), {
      terminalId: "t-1",
      selection: "the reply",
    });

    expect(result).toBe("**the reply**");
    expect(replyCopyMock.findClaudeReplySpan).toHaveBeenCalledWith(
      "t-1",
      "the reply",
      expect.any(AbortSignal)
    );
  });

  it("gives up with null, quietly, once the host's deadline passes mid-read", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    replyCopyMock.findClaudeReplySpan.mockImplementationOnce(
      (_terminalId, _selection, signal: AbortSignal) =>
        new Promise<string | null>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason))
        )
    );

    const pending = find(ctx("local", "local-view"), { terminalId: "t-1", selection: "x" });
    await vi.waitFor(() => expect(replyCopyMock.findClaudeReplySpan).toHaveBeenCalled());
    deadline.abort(new DOMException("timed out", "TimeoutError"));

    await expect(pending).resolves.toBeNull();
    expect(timeout).toHaveBeenCalledWith(REPLY_SPAN_HOST_TIMEOUT_MS);
    expect(error).not.toHaveBeenCalled();
  });

  it.each([
    ["a remote Shell", ctx("remote", "remote-view")],
    ["a remote view of a local client", ctx("local", "remote-view")],
    ["a remote client on a local endpoint", ctx("remote", "local-view")],
  ])("reads no transcript for %s", async (_label, context) => {
    const result = await find(context, { terminalId: "t-1", selection: "the reply" });

    expect(result).toBeNull();
    expect(replyCopyMock.findClaudeReplySpan).not.toHaveBeenCalled();
  });

  it("answers null for a failed read and logs nothing of it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    replyCopyMock.findClaudeReplySpan.mockRejectedValueOnce(
      new Error("EACCES: /Users/x/.claude/projects/secret.jsonl")
    );

    const result = await find(ctx("local", "local-view"), {
      terminalId: "t-1",
      selection: "the reply",
    });

    expect(result).toBeNull();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("refuses a selection past the bound at the boundary", () => {
    const schema = claudeNamespace.ops.findReplySpan.schema;

    expect(schema.safeParse({ terminalId: "t-1", selection: "x" }).success).toBe(true);
    expect(schema.safeParse({ terminalId: "t-1", selection: "" }).success).toBe(false);
    expect(
      schema.safeParse({ terminalId: "t-1", selection: "x".repeat(256 * 1024 + 1) }).success
    ).toBe(false);
  });
});

describe("claude.readUsage (#16370)", () => {
  it("answers with the readings main grouped by login, taking nothing from the caller", async () => {
    const read = claudeNamespace.ops.readUsage.handler as unknown as () => Promise<unknown>;

    await expect(read()).resolves.toEqual([
      { key: "k1", kind: "default", accountNames: [], readings: [] },
    ]);
    expect(usageMock.readClaudeUsageAccounts).toHaveBeenCalledWith();
  });
});

type ContextUsageHandler = (payload: { terminalId: string }) => Promise<AgentContextUsageResult>;

const readContextUsage = claudeNamespace.ops.readContextUsage
  .handler as unknown as ContextUsageHandler;

describe("claude.readContextUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers with the host's reading for the named terminal", async () => {
    const result = await readContextUsage({ terminalId: "t-1" });

    expect(result).toEqual({
      status: "ok",
      provider: "claude",
      contextTokens: 126_717,
      recordedAt: 1_700_000_000_000,
    });
    expect(contextUsageMock.readClaudePaneContextUsage).toHaveBeenCalledWith(
      "t-1",
      expect.any(AbortSignal)
    );
  });

  it("answers store-unreadable once the host's deadline passes mid-read", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    contextUsageMock.readClaudePaneContextUsage.mockImplementationOnce(
      (_terminalId, signal: AbortSignal) =>
        new Promise<AgentContextUsageResult>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason))
        )
    );

    const pending = readContextUsage({ terminalId: "t-1" });
    await vi.waitFor(() => expect(contextUsageMock.readClaudePaneContextUsage).toHaveBeenCalled());
    deadline.abort(new DOMException("timed out", "TimeoutError"));

    await expect(pending).resolves.toEqual({ status: "unavailable", reason: "store-unreadable" });
  });

  it("answers store-unreadable for a failed read and logs nothing of it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    contextUsageMock.readClaudePaneContextUsage.mockRejectedValueOnce(
      new Error("EACCES: /Users/x/.claude/projects/secret.jsonl")
    );

    const result = await readContextUsage({ terminalId: "t-1" });

    expect(result).toEqual({ status: "unavailable", reason: "store-unreadable" });
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("takes a terminal id and nothing that could name a file", () => {
    const schema = claudeNamespace.ops.readContextUsage.schema;

    expect(schema.safeParse({ terminalId: "t-1" }).success).toBe(true);
    expect(schema.safeParse({ terminalId: "" }).success).toBe(false);
    expect(schema.safeParse({ terminalId: "x".repeat(129) }).success).toBe(false);
  });
});
