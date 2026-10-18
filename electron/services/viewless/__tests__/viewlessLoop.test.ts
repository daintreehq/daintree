import { describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../../ipc/channels.js";
import type { ViewlessApprovalAsk, ViewlessTerminalRecord } from "../ViewlessActionExecutor.js";
import { executeViewlessAction } from "../ViewlessActionExecutor.js";
import {
  makeDeps,
  makeHosts,
  makePty,
  makeWorktree,
  PROJECT,
  request,
} from "./viewlessTestDeps.js";

/** A host whose pty-host and workspace host remember what the loop did to them. */
function loopHost() {
  const records: Record<string, ViewlessTerminalRecord> = {};
  const screens: Record<string, string> = {};
  const pty = makePty(records, screens);
  const worktrees = [makeWorktree()];
  const { deps, invoke, store } = makeDeps(
    { getPtyReader: () => pty, getWorkspaceHosts: () => makeHosts() },
    { worktrees }
  );
  invoke.mockImplementation(async (_projectId: string, channel: string, args: unknown[]) => {
    if (channel === CHANNELS.WORKTREE_GET_ALL_WITH_STATUS) return { worktrees, gitBacked: true };
    if (channel === CHANNELS.WORKTREE_GET_DEFAULT_PATH) {
      return `/repo-wt/${(args[0] as { branchName: string }).branchName}`;
    }
    if (channel === CHANNELS.WORKTREE_CREATE) {
      worktrees.push(
        makeWorktree({
          id: "/repo-wt/feature",
          worktreeId: "/repo-wt/feature",
          path: "/repo-wt/feature",
          branch: "feature",
          isMainWorktree: false,
          isCurrent: false,
        })
      );
      return { worktreeId: "/repo-wt/feature", branch: "feature" };
    }
    if (channel === CHANNELS.TERMINAL_SPAWN) {
      const spawn = args[0] as { id: string; launchAgentId?: string; worktreeId?: string };
      records[spawn.id] = {
        kind: "terminal",
        launchAgentId: spawn.launchAgentId,
        worktreeId: spawn.worktreeId,
        agentState: "idle",
      };
      screens[spawn.id] = "All 42 tests passed\n";
      return spawn.id;
    }
    if (channel === CHANNELS.TERMINAL_TRASH) {
      const id = args[0] as string;
      records[id] = { ...records[id], isTrashed: true };
      return undefined;
    }
    if (channel === CHANNELS.WORKTREE_DELETE) {
      const { worktreeId } = args[0] as { worktreeId: string };
      worktrees.splice(
        worktrees.findIndex((worktree) => worktree.id === worktreeId),
        1
      );
      return undefined;
    }
    return undefined;
  });

  return { deps, invoke, store, worktrees };
}

/**
 * The orchestration loop a hub drives on a host with no window open (#13495),
 * run through the executor with a pty-host and workspace host that remember
 * what was done to them: make a worktree, launch an agent in it, read it, close
 * it and delete the worktree. What the next frontend to attach would hydrate
 * is read back off the saved layout at each step.
 */
describe("the orchestration loop with no frontend", () => {
  it("creates, launches, reads, closes and deletes, leaving a layout a view can adopt", async () => {
    const { deps, store } = loopHost();

    const created = await executeViewlessAction(
      request("worktree.create", {
        worktreeId: PROJECT.path,
        options: { baseBranch: "main", newBranch: "feature", path: "/repo-wt/feature" },
      }),
      deps
    );
    expect(created).toMatchObject({ ok: true, result: { worktreeId: "/repo-wt/feature" } });

    const launched = await executeViewlessAction(
      request("agent.launch", {
        agentId: "claude",
        worktreeId: "/repo-wt/feature",
        prompt: "Run the tests",
      }),
      deps
    );
    expect(launched).toMatchObject({ ok: true, result: { launched: true } });
    const terminalId = (launched as { result: { terminalId: string } }).result.terminalId;
    expect(store.read()?.terminals).toEqual([
      expect.objectContaining({
        id: terminalId,
        launchAgentId: "claude",
        worktreeId: "/repo-wt/feature",
      }),
    ]);

    const listed = await executeViewlessAction(
      request("terminal.list", { worktreeId: "/repo-wt/feature" }),
      deps
    );
    expect(listed).toMatchObject({
      ok: true,
      result: { terminals: [{ id: terminalId, agentId: "claude", agentState: "idle" }] },
    });

    const output = await executeViewlessAction(request("terminal.getOutput", { terminalId }), deps);
    expect((output as { result: { content: string } }).result.content).toContain("42 tests passed");

    const closed = await executeViewlessAction(request("terminal.close", { terminalId }), deps);
    expect(closed).toEqual({ ok: true, result: { closedIds: [terminalId] } });
    expect(store.read()?.terminals).toEqual([]);

    // Confirm-gated: refused until main holds an approval, then run.
    const refused = await executeViewlessAction(
      request("worktree.delete", { worktreeId: "/repo-wt/feature" }),
      deps
    );
    expect(refused).toMatchObject({ ok: false, error: { code: "CONFIRMATION_REQUIRED" } });
    const deleted = await executeViewlessAction(
      request("worktree.delete", { worktreeId: "/repo-wt/feature" }, { confirmed: true }),
      deps
    );
    expect(deleted).toMatchObject({ ok: true });

    const remaining = await executeViewlessAction(request("worktree.list", undefined), deps);
    expect(
      (remaining as { result: { worktrees: Array<{ id: string }> } }).result.worktrees.map(
        (w) => w.id
      )
    ).toEqual([PROJECT.path]);
  });

  it("runs it for a Shell's assistant while nobody drives the project, its delete approved there (#13501)", async () => {
    const { deps, store } = loopHost();
    const readTerminalStatus = vi.fn(async (args: unknown) => ({
      terminals: (args as { terminalIds: string[] }).terminalIds.map((terminalId) => ({
        terminalId,
        agentId: "claude",
        agentState: "idle" as const,
      })),
      source: "pty" as const,
      unavailableFields: [],
    }));
    deps.readTerminalStatus = readTerminalStatus as never;
    // The relay's own check: nobody else holds the lease until the end.
    let heldBy: Error | null = null;
    const asked: ViewlessApprovalAsk[] = [];
    const run = (actionId: string, args: unknown) =>
      executeViewlessAction(
        {
          ...request(actionId, args),
          checkWrite: () => heldBy,
          requestApproval: async (ask) => {
            asked.push(ask);
            return { decision: "approved", deadline: Date.now() + 40_000 };
          },
        },
        deps
      );

    const created = await run("worktree.createWithRecipe", {
      source: { kind: "existingBranch", branchName: "feature" },
    });
    expect(created).toMatchObject({ ok: true, result: { worktreeId: "/repo-wt/feature" } });

    const launched = await run("agent.launch", {
      agentId: "claude",
      worktreeId: "/repo-wt/feature",
      prompt: "Run the tests",
    });
    const terminalId = (launched as { result: { terminalId: string } }).result.terminalId;

    const status = await run("terminal.getStatus", { worktreeId: "/repo-wt/feature" });
    expect(status).toMatchObject({ ok: true, result: { terminals: [{ terminalId }] } });

    const output = await run("terminal.getOutput", { terminalId });
    expect((output as { result: { content: string } }).result.content).toContain("42 tests passed");

    expect(await run("terminal.close", { terminalId })).toEqual({
      ok: true,
      result: { closedIds: [terminalId] },
    });
    const deleted = await run("worktree.delete", { worktreeId: "/repo-wt/feature" });
    expect(deleted).toMatchObject({ ok: true });
    expect(asked).toEqual([
      expect.objectContaining({
        actionId: "worktree.delete",
        args: { worktreeId: "/repo-wt/feature" },
        subject: "feature",
      }),
    ]);
    expect(store.read()?.terminals).toEqual([]);

    // A view that takes the project over stops the next change before it is made.
    heldBy = new Error("studio-02 has control of this project on the host");
    await expect(run("terminal.new", {})).rejects.toBe(heldBy);
  });
});
