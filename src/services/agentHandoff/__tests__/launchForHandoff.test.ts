// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionDispatchResult, ActionId } from "@shared/types/actions";

const { draftAgentContext, reportDraftRefused } = vi.hoisted(() => ({
  draftAgentContext: vi.fn((terminalId: string) => ({ status: "drafted" as const, terminalId })),
  reportDraftRefused: vi.fn(),
}));
vi.mock("../agentDraft", () => ({ draftAgentContext, reportDraftRefused }));
// The default dispatcher is never used here; keep the real service out.
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));
vi.mock("@/utils/logger", () => ({ logWarn: vi.fn() }));

const { branchNameForHandoff, launchAgentForHandoff } = await import("../launchForHandoff");

type Handler = (args: unknown) => ActionDispatchResult;

function dispatcherWith(handlers: Partial<Record<string, Handler>>) {
  const calls: { actionId: ActionId; args: unknown }[] = [];
  return {
    calls,
    dispatcher: {
      dispatch: vi.fn(async (actionId: ActionId, args: unknown) => {
        calls.push({ actionId, args });
        const handler = handlers[actionId];
        return handler
          ? handler(args)
          : { ok: false as const, error: { code: "NOT_FOUND" as const, message: actionId } };
      }),
    },
  };
}

const launchOk: Handler = () => ({
  ok: true,
  result: { launched: true, terminalId: "new-term", location: "grid" },
});

const content = { text: "Card body", title: "Fix login", sourceLabel: "Kanban" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("launchAgentForHandoff", () => {
  it("creates the worktree, waits for setup, launches without a prompt, then drafts", async () => {
    const { calls, dispatcher } = dispatcherWith({
      "worktree.createWithRecipe": () => ({ ok: true, result: { worktreeId: "wt-new" } }),
      "worktree.waitUntilReady": () => ({ ok: true, result: { setupState: "ready" } }),
      "agent.launch": launchOk,
    });

    const result = await launchAgentForHandoff(
      "claude",
      { kind: "new-worktree", branchName: "fix-login" },
      content,
      dispatcher
    );

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
    expect(draftAgentContext).toHaveBeenCalledWith("new-term", content, { skipChecks: true });
    expect(result).toEqual({ status: "drafted", terminalId: "new-term" });
  });

  it("still launches when setup outlives the wait", async () => {
    const { dispatcher } = dispatcherWith({
      "worktree.createWithRecipe": () => ({ ok: true, result: { worktreeId: "wt-new" } }),
      "worktree.waitUntilReady": () => ({ ok: true, result: { timedOut: true } }),
      "agent.launch": launchOk,
    });
    const result = await launchAgentForHandoff(
      "claude",
      { kind: "new-worktree", branchName: "b" },
      content,
      dispatcher
    );
    expect(result.status).toBe("drafted");
  });

  it("launches into an existing worktree without creating one", async () => {
    const { calls, dispatcher } = dispatcherWith({ "agent.launch": launchOk });
    await launchAgentForHandoff(
      "codex",
      { kind: "existing-worktree", worktreeId: "wt-feat" },
      content,
      dispatcher
    );
    expect(calls).toEqual([
      {
        actionId: "agent.launch",
        args: { agentId: "codex", location: "grid", worktreeId: "wt-feat" },
      },
    ]);
  });

  it.each<[string, Partial<Record<string, Handler>>]>([
    ["worktree creation fails", {}],
    [
      "the agent does not launch",
      {
        "worktree.createWithRecipe": () => ({ ok: true, result: { worktreeId: "wt-new" } }),
        "worktree.waitUntilReady": () => ({ ok: true, result: {} }),
        "agent.launch": () => ({
          ok: true,
          result: { launched: false, terminalId: null, spawnStatus: "missing-cli" },
        }),
      },
    ],
  ])("refuses as launch-failed when %s, and drafts nothing", async (_name, handlers) => {
    const { dispatcher } = dispatcherWith(handlers);
    const result = await launchAgentForHandoff(
      "claude",
      { kind: "new-worktree", branchName: "b" },
      content,
      dispatcher
    );
    expect(result).toEqual({ status: "refused", reason: "launch-failed" });
    expect(draftAgentContext).not.toHaveBeenCalled();
    expect(reportDraftRefused).toHaveBeenCalledWith("launch-failed");
  });

  it("resolves rather than rejects when a dispatch throws", async () => {
    const dispatcher = { dispatch: vi.fn(async () => Promise.reject(new Error("boom"))) };
    await expect(
      launchAgentForHandoff("claude", { kind: "existing-worktree" }, content, dispatcher)
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
