// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionDispatchResult, ActionId } from "@shared/types/actions";
import type { PluginSendToAgentRefusalReason, PluginSendToAgentResult } from "@shared/types/plugin";

const { draftAgentContext, getDraftRefusal, reportDraftNotAdded } = vi.hoisted(() => ({
  draftAgentContext: vi.fn((terminalId: string): PluginSendToAgentResult => ({
    status: "drafted",
    terminalId,
  })),
  getDraftRefusal: vi.fn((_terminalId: string): PluginSendToAgentRefusalReason | null => null),
  reportDraftNotAdded: vi.fn(),
}));
vi.mock("../agentDraft", () => ({ draftAgentContext, getDraftRefusal, reportDraftNotAdded }));
// The default dispatcher is never used here; keep the real service out.
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));
vi.mock("@/utils/logger", () => ({ logWarn: vi.fn() }));

const { branchNameForHandoff, launchAgentForHandoff } = await import("../launchForHandoff");

type Handler = (args: unknown) => ActionDispatchResult;

function depsWith(handlers: Partial<Record<string, Handler | Handler[]>>) {
  const calls: { actionId: ActionId; args: unknown }[] = [];
  const sleep = vi.fn(async (_ms: number) => {});
  return {
    calls,
    sleep,
    deps: {
      sleep,
      dispatcher: {
        dispatch: vi.fn(async (actionId: ActionId, args: unknown) => {
          const round = calls.filter((call) => call.actionId === actionId).length;
          calls.push({ actionId, args });
          const entry = handlers[actionId];
          const handler = Array.isArray(entry) ? (entry[round] ?? entry[entry.length - 1]) : entry;
          return handler
            ? handler(args)
            : { ok: false as const, error: { code: "NOT_FOUND" as const, message: actionId } };
        }),
      },
    },
  };
}

const created: Handler = () => ({
  ok: true,
  result: { worktreeId: "wt-new", effectiveBranch: "fix-login" },
});
const ready: Handler = () => ({ ok: true, result: { setupState: "ready", timedOut: false } });
const stillRunning: Handler = () => ({
  ok: true,
  result: { setupState: "running", timedOut: true },
});
const launchOk: Handler = () => ({
  ok: true,
  result: { launched: true, terminalId: "new-term", location: "grid" },
});

const content = { text: "Card body", title: "Fix login", sourceLabel: "Kanban" };
const NEW_WORKTREE = { kind: "new-worktree", branchName: "fix-login" } as const;

beforeEach(() => {
  vi.clearAllMocks();
  getDraftRefusal.mockReturnValue(null);
});

describe("launchAgentForHandoff", () => {
  it("creates the worktree, waits for setup, launches without a prompt, then drafts", async () => {
    const { calls, deps } = depsWith({
      "worktree.createWithRecipe": created,
      "worktree.waitUntilReady": ready,
      "agent.launch": launchOk,
    });

    const result = await launchAgentForHandoff("claude", NEW_WORKTREE, content, deps);

    expect(calls.map((call) => call.actionId)).toEqual([
      "worktree.createWithRecipe",
      "worktree.waitUntilReady",
      "agent.launch",
    ]);
    expect(calls[0]!.args).toEqual({ source: { kind: "newBranch", branchName: "fix-login" } });
    expect(calls[1]!.args).toEqual({ worktreeId: "wt-new" });
    // A launch prompt is submitted as the agent's first turn — the handoff
    // must never ride it.
    expect(calls[2]!.args).toEqual({ agentId: "claude", location: "grid", worktreeId: "wt-new" });
    expect(calls[2]!.args).not.toHaveProperty("prompt");
    // Through the ordinary gate — no bypass for a fresh pane.
    expect(draftAgentContext).toHaveBeenCalledWith("new-term", content);
    expect(result).toEqual({ status: "drafted", terminalId: "new-term" });
  });

  it("keeps waiting while setup is still running, then launches once it is ready", async () => {
    const { calls, deps } = depsWith({
      "worktree.createWithRecipe": created,
      "worktree.waitUntilReady": [stillRunning, stillRunning, ready],
      "agent.launch": launchOk,
    });
    const result = await launchAgentForHandoff("claude", NEW_WORKTREE, content, deps);
    expect(calls.filter((call) => call.actionId === "worktree.waitUntilReady")).toHaveLength(3);
    expect(result.status).toBe("drafted");
  });

  it.each<[string, Handler | Handler[], string]>([
    [
      "setup failed",
      () => ({ ok: true, result: { setupState: "failed", timedOut: false } }),
      "its setup failed",
    ],
    [
      "setup needs approval",
      () => ({ ok: true, result: { setupState: "needs-approval", timedOut: false } }),
      "needs your approval",
    ],
    ["setup never settles", stillRunning, "is still running"],
    [
      "the readiness check fails",
      () => ({ ok: false, error: { code: "EXECUTION_ERROR", message: "x" } }),
      "couldn't be checked",
    ],
  ])(
    "stops before launching when %s, and reports the worktree it made",
    async (_name, wait, why) => {
      const { calls, deps } = depsWith({
        "worktree.createWithRecipe": created,
        "worktree.waitUntilReady": wait,
        "agent.launch": launchOk,
      });
      const result = await launchAgentForHandoff("claude", NEW_WORKTREE, content, deps);

      expect(result).toEqual({ status: "refused", reason: "launch-failed", worktreeId: "wt-new" });
      expect(calls.some((call) => call.actionId === "agent.launch")).toBe(false);
      expect(draftAgentContext).not.toHaveBeenCalled();
      expect(reportDraftNotAdded).toHaveBeenCalledWith(expect.stringContaining("fix-login"));
      expect(reportDraftNotAdded).toHaveBeenCalledWith(expect.stringContaining(why));
    }
  );

  it("launches when the host no longer tracks the worktree's setup", async () => {
    const { deps } = depsWith({
      "worktree.createWithRecipe": created,
      "worktree.waitUntilReady": () => ({
        ok: true,
        result: { setupState: "unknown", timedOut: false },
      }),
      "agent.launch": launchOk,
    });
    await expect(launchAgentForHandoff("claude", NEW_WORKTREE, content, deps)).resolves.toEqual({
      status: "drafted",
      terminalId: "new-term",
    });
  });

  it("waits for the new pane to reach the store before drafting", async () => {
    getDraftRefusal
      .mockReturnValueOnce("unknown-terminal")
      .mockReturnValueOnce("unknown-terminal")
      .mockReturnValue(null);
    const { deps, sleep } = depsWith({ "agent.launch": launchOk });
    await launchAgentForHandoff("claude", { kind: "existing-worktree" }, content, deps);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(draftAgentContext).toHaveBeenCalledWith("new-term", content);
  });

  it("carries the new worktree on a draft refused after launch", async () => {
    draftAgentContext.mockReturnValueOnce({ status: "refused", reason: "input-locked" });
    const { deps } = depsWith({
      "worktree.createWithRecipe": created,
      "worktree.waitUntilReady": ready,
      "agent.launch": launchOk,
    });
    await expect(launchAgentForHandoff("claude", NEW_WORKTREE, content, deps)).resolves.toEqual({
      status: "refused",
      reason: "input-locked",
      worktreeId: "wt-new",
    });
  });

  it("launches into an existing worktree without creating one", async () => {
    const { calls, deps } = depsWith({ "agent.launch": launchOk });
    await launchAgentForHandoff(
      "codex",
      { kind: "existing-worktree", worktreeId: "wt-feat" },
      content,
      deps
    );
    expect(calls).toEqual([
      {
        actionId: "agent.launch",
        args: { agentId: "codex", location: "grid", worktreeId: "wt-feat" },
      },
    ]);
  });

  it("refuses as launch-failed when worktree creation fails, naming no worktree", async () => {
    const { deps } = depsWith({});
    await expect(launchAgentForHandoff("claude", NEW_WORKTREE, content, deps)).resolves.toEqual({
      status: "refused",
      reason: "launch-failed",
    });
    expect(draftAgentContext).not.toHaveBeenCalled();
  });

  it("refuses as launch-failed when the agent does not start, naming the worktree", async () => {
    const { deps } = depsWith({
      "worktree.createWithRecipe": created,
      "worktree.waitUntilReady": ready,
      "agent.launch": () => ({
        ok: true,
        result: { launched: false, terminalId: null, spawnStatus: "missing-cli" },
      }),
    });
    await expect(launchAgentForHandoff("claude", NEW_WORKTREE, content, deps)).resolves.toEqual({
      status: "refused",
      reason: "launch-failed",
      worktreeId: "wt-new",
    });
    expect(draftAgentContext).not.toHaveBeenCalled();
  });

  it("resolves rather than rejects when a dispatch throws", async () => {
    const dispatcher = { dispatch: vi.fn(async () => Promise.reject(new Error("boom"))) };
    await expect(
      launchAgentForHandoff("claude", { kind: "existing-worktree" }, content, { dispatcher })
    ).resolves.toEqual({ status: "refused", reason: "launch-failed" });
  });
});

describe("branchNameForHandoff", () => {
  it("slugs a title into a branch name", () => {
    expect(branchNameForHandoff("Fix: login redirect (Safari)")).toBe("fix-login-redirect-safari");
    expect(branchNameForHandoff("Café résumé")).toBe("cafe-resume");
  });

  it("falls back when the title has nothing usable", () => {
    expect(branchNameForHandoff(undefined)).toBe("agent-handoff");
    expect(branchNameForHandoff("!!!")).toBe("agent-handoff");
  });

  it("caps the length without leaving a trailing hyphen", () => {
    const name = branchNameForHandoff(`${"word ".repeat(30)}`);
    expect(name.length).toBeLessThanOrEqual(48);
    expect(name.endsWith("-")).toBe(false);
  });
});
