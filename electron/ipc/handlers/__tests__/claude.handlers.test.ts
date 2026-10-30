import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcContext } from "../../types.js";

const replyCopyMock = vi.hoisted(() => ({
  findClaudeReplySpan: vi.fn(async (): Promise<string | null> => "**the reply**"),
}));

vi.mock("../../../services/claude/ClaudeReplyCopy.js", () => replyCopyMock);

import { claudeNamespace } from "../claude.js";

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

  it("answers a local view with the span the host found, under a deadline", async () => {
    const result = await find(ctx("local", "local-view"), {
      terminalId: "t-1",
      selection: "the reply",
    });

    expect(result).toBe("**the reply**");
    const [terminalId, selection, signal] = replyCopyMock.findClaudeReplySpan.mock
      .calls[0] as unknown as [string, string, AbortSignal];
    expect([terminalId, selection]).toEqual(["t-1", "the reply"]);
    expect(signal).toBeInstanceOf(AbortSignal);
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
