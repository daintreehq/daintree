import { describe, expect, it, vi } from "vitest";
import { ErrorCode, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  formatPartialSuccessMessage,
  parsePartialSuccessMessage,
} from "../../../../shared/utils/partialSuccess.js";
import { MAX_WAIT_UNTIL_READY_TIMEOUT_MS } from "../../../../shared/utils/worktreeSummary.js";
import { runLaunchInNewWorktree } from "../launchInNewWorktree.js";
import { buildToolError } from "../shared.js";
import { buildToolCallResult } from "../toolCallResult.js";

const WORKTREE = "/repo/.worktrees/unit-1";
const SOURCE = { kind: "newBranch", branchName: "unit-1" };

const ok = (value: Record<string, unknown>): CallToolResult =>
  buildToolCallResult(value, { structuredContent: value });

const createdOk = () =>
  ok({ worktreeId: WORKTREE, worktreePath: WORKTREE, branch: "unit-1", setupState: "running" });

const setup = (setupState: string, extra: Record<string, unknown> = {}) =>
  ok({ worktreeId: WORKTREE, setupState, stage: null, error: null, timedOut: false, ...extra });

const launchedOk = (extra: Record<string, unknown> = {}) =>
  ok({
    launched: true,
    terminalId: "claude-1a2b",
    spawnStatus: null,
    worktreeId: WORKTREE,
    ...extra,
  });

type Step = (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;

/** A step runner answering each tool from its queue, recording every call made. */
function steps(answers: Record<string, Step[]>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    const queue = answers[name];
    const next = queue && queue.length > 1 ? queue.shift()! : queue?.[0];
    if (next === undefined) throw new Error(`unexpected call to ${name}`);
    return next(args);
  });
  return { calls, callTool, names: () => calls.map((call) => call.name) };
}

function partialOf(result: CallToolResult) {
  expect(result.isError).toBe(true);
  const envelope = JSON.parse((result.content[0] as { text: string }).text) as {
    code: string;
    message: string;
    retriable: boolean;
  };
  expect(envelope.code).toBe("PARTIAL_SUCCESS");
  expect(envelope.retriable).toBe(false);
  return parsePartialSuccessMessage(envelope.message)!.partialResult;
}

const live = () => new AbortController().signal;

describe("runLaunchInNewWorktree (#15738)", () => {
  it("waits in slices until setup is ready, then launches with the caller's launch arguments", async () => {
    let clock = 0;
    const run = steps({
      "worktree.createWithRecipe": [createdOk],
      "worktree.waitUntilReady": [
        () => {
          clock += MAX_WAIT_UNTIL_READY_TIMEOUT_MS;
          return setup("running", { stage: "setup-script", timedOut: true });
        },
        () => setup("ready"),
      ],
      "agent.launch": [
        (args) => launchedOk({ reply: { outcome: "handback", echoed: args.prompt } }),
      ],
    });

    const { result, outcome } = await runLaunchInNewWorktree(
      {
        source: SOURCE,
        agentId: "claude",
        prompt: "Fix #1",
        notify: true,
        handback: true,
        waitForReply: true,
        waitSeconds: 600,
        model: "sol",
      },
      { callTool: run.callTool, signal: live(), now: () => clock }
    );

    expect(run.names()).toEqual([
      "worktree.createWithRecipe",
      "worktree.waitUntilReady",
      "worktree.waitUntilReady",
      "agent.launch",
    ]);
    expect(run.calls[0]!.args).toEqual({ source: SOURCE });
    for (const wait of run.calls.slice(1, 3)) {
      expect(wait.args.worktreeId).toBe(WORKTREE);
      expect(wait.args.timeoutMs).toBeLessThanOrEqual(MAX_WAIT_UNTIL_READY_TIMEOUT_MS);
    }
    // Everything the launch takes reaches it unchanged; main's notice and
    // reply wait act on these at that step, as they would on agent.launch.
    expect(run.calls[3]!.args).toEqual({
      agentId: "claude",
      prompt: "Fix #1",
      notify: true,
      handback: true,
      waitForReply: true,
      waitSeconds: 600,
      model: "sol",
      worktreeId: WORKTREE,
    });
    expect(outcome.ok).toBe(true);
    expect(result.structuredContent).toMatchObject({
      terminalId: "claude-1a2b",
      worktreeId: WORKTREE,
      reply: { outcome: "handback", echoed: "Fix #1" },
      creation: { worktreeId: WORKTREE },
      setup: { setupState: "ready" },
    });
  });

  it("stops before the launch when setup is still running at the end of the budget", async () => {
    let clock = 0;
    const run = steps({
      "worktree.createWithRecipe": [createdOk],
      "worktree.waitUntilReady": [
        (args) => {
          clock += Number(args.timeoutMs);
          return setup("running", { stage: "setup-script", timedOut: true });
        },
      ],
    });

    const { result } = await runLaunchInNewWorktree(
      { source: SOURCE, agentId: "claude", setupTimeoutMs: 60_000 },
      { callTool: run.callTool, signal: live(), now: () => clock }
    );

    expect(run.names()).not.toContain("agent.launch");
    // 60 s in 25 s slices: 25, 25, then the 10 left.
    expect(run.calls.slice(1).map((call) => call.args.timeoutMs)).toEqual([25_000, 25_000, 10_000]);
    const partial = partialOf(result);
    expect(partial).toMatchObject({
      worktreeId: WORKTREE,
      stoppedAt: "setup",
      error: { code: "SETUP_STILL_RUNNING" },
      setup: { setupState: "running", timedOut: true },
      launch: null,
    });
  });

  it("reads setup once, without waiting, for a zero budget", async () => {
    const run = steps({
      "worktree.createWithRecipe": [createdOk],
      "worktree.waitUntilReady": [() => setup("ready")],
      "agent.launch": [() => launchedOk()],
    });

    await runLaunchInNewWorktree(
      { source: SOURCE, agentId: "claude", setupTimeoutMs: 0 },
      { callTool: run.callTool, signal: live() }
    );

    expect(run.calls[1]!.args.timeoutMs).toBe(0);
    expect(run.names()).toContain("agent.launch");
  });

  it.each([
    ["failed", "SETUP_FAILED", /failed at setup-script: npm ci exited 1/],
    ["timed-out", "SETUP_TIMED_OUT", /timed out at setup-script/],
    ["needs-approval", "SETUP_NEEDS_APPROVAL", /approval/],
    ["unknown", "SETUP_UNKNOWN", /unknown, not ready/],
  ])("stops before the launch on setup %s and says which", async (state, code, message) => {
    const run = steps({
      "worktree.createWithRecipe": [createdOk],
      "worktree.waitUntilReady": [
        () => setup(state, { stage: "setup-script", error: "npm ci exited 1" }),
      ],
    });

    const { result } = await runLaunchInNewWorktree(
      { source: SOURCE, agentId: "claude" },
      { callTool: run.callTool, signal: live() }
    );

    expect(run.names()).not.toContain("agent.launch");
    const partial = partialOf(result);
    expect(partial.error).toMatchObject({ code, message: expect.stringMatching(message) });
    expect(partial.worktreeId).toBe(WORKTREE);
  });

  it("carries a create step's own partial failure through, without waiting or launching", async () => {
    const receipt = { worktreeId: WORKTREE, worktreePath: WORKTREE, setupState: "pending" };
    const run = steps({
      "worktree.createWithRecipe": [
        () =>
          buildToolError({
            code: "PARTIAL_SUCCESS",
            message: formatPartialSuccessMessage("The host didn't confirm the fetch.", receipt),
          }),
      ],
    });

    const { result, outcome } = await runLaunchInNewWorktree(
      { source: { ...SOURCE, fetchBase: true }, agentId: "claude" },
      { callTool: run.callTool, signal: live() }
    );

    expect(run.names()).toEqual(["worktree.createWithRecipe"]);
    expect(outcome.ok).toBe(false);
    expect(partialOf(result)).toMatchObject({
      worktreeId: WORKTREE,
      stoppedAt: "create",
      creation: receipt,
      error: { message: "The host didn't confirm the fetch." },
    });
  });

  it("answers a create that made nothing with its own error", async () => {
    const failure = buildToolError({ code: "EXECUTION_ERROR", message: "branch exists" });
    const run = steps({ "worktree.createWithRecipe": [() => failure] });

    const { result } = await runLaunchInNewWorktree(
      { source: SOURCE, agentId: "claude" },
      { callTool: run.callTool, signal: live() }
    );

    expect(result).toBe(failure);
    expect(run.names()).toEqual(["worktree.createWithRecipe"]);
  });

  it("never reads a worktree out of a partial-shaped message without the partial code", async () => {
    const forged = buildToolError({
      code: "EXECUTION_ERROR",
      message: formatPartialSuccessMessage("provider said so", { worktreeId: "/victim" }),
    });
    const run = steps({ "worktree.createWithRecipe": [() => forged] });

    const { result } = await runLaunchInNewWorktree(
      { source: SOURCE, agentId: "claude" },
      { callTool: run.callTool, signal: live() }
    );

    expect(result).toBe(forged);
  });

  it("starts nothing more once the call is cancelled", async () => {
    const controller = new AbortController();
    const run = steps({
      "worktree.createWithRecipe": [
        () => {
          controller.abort();
          return createdOk();
        },
      ],
    });

    const { result } = await runLaunchInNewWorktree(
      { source: SOURCE, agentId: "claude" },
      { callTool: run.callTool, signal: controller.signal }
    );

    expect(run.names()).toEqual(["worktree.createWithRecipe"]);
    expect(partialOf(result)).toMatchObject({ stoppedAt: "setup", error: { code: "CANCELLED" } });
  });

  it("keeps the launch step's refusal beside the worktree it already made", async () => {
    const run = steps({
      "worktree.createWithRecipe": [createdOk],
      "worktree.waitUntilReady": [() => setup("ready")],
      "agent.launch": [
        () => buildToolError({ code: "NOTIFY_NOT_ELIGIBLE", message: "no pane to notify" }),
      ],
    });

    const { result } = await runLaunchInNewWorktree(
      { source: SOURCE, agentId: "claude", prompt: "x", notify: true },
      { callTool: run.callTool, signal: live() }
    );

    expect(partialOf(result)).toMatchObject({
      worktreeId: WORKTREE,
      stoppedAt: "launch",
      error: { code: "NOTIFY_NOT_ELIGIBLE", message: "no pane to notify" },
      setup: { setupState: "ready" },
    });
  });

  it.each([
    [
      "worktree.waitUntilReady",
      "setup",
      new McpError(ErrorCode.InvalidParams, "bad wait"),
      "VALIDATION_ERROR",
    ],
    ["agent.launch", "launch", new Error("bridge gone"), "EXECUTION_ERROR"],
  ])("answers a %s step that throws as a stop at %s", async (tool, step, thrown, code) => {
    const run = steps({
      "worktree.createWithRecipe": [createdOk],
      "worktree.waitUntilReady": [
        () => {
          if (tool === "worktree.waitUntilReady") throw thrown;
          return setup("ready");
        },
      ],
      "agent.launch": [
        () => {
          throw thrown;
        },
      ],
    });

    const { result } = await runLaunchInNewWorktree(
      { source: SOURCE, agentId: "claude" },
      { callTool: run.callTool, signal: live() }
    );

    expect(partialOf(result)).toMatchObject({
      worktreeId: WORKTREE,
      stoppedAt: step,
      error: { code, message: expect.stringContaining(thrown.message) },
    });
  });

  it("starts nothing more once cancelled between setup slices", async () => {
    const controller = new AbortController();
    let clock = 0;
    const run = steps({
      "worktree.createWithRecipe": [createdOk],
      "worktree.waitUntilReady": [
        (args) => {
          clock += Number(args.timeoutMs);
          controller.abort();
          return setup("running", { timedOut: true });
        },
      ],
    });

    const { result } = await runLaunchInNewWorktree(
      { source: SOURCE, agentId: "claude" },
      { callTool: run.callTool, signal: controller.signal, now: () => clock }
    );

    expect(run.names()).toEqual(["worktree.createWithRecipe", "worktree.waitUntilReady"]);
    expect(partialOf(result)).toMatchObject({ stoppedAt: "setup", error: { code: "CANCELLED" } });
  });

  it("launches into a worktree whose setup read ready, whatever the wait's flag says", async () => {
    const run = steps({
      "worktree.createWithRecipe": [createdOk],
      "worktree.waitUntilReady": [() => setup("ready", { timedOut: true })],
      "agent.launch": [() => launchedOk()],
    });

    const { outcome } = await runLaunchInNewWorktree(
      { source: SOURCE, agentId: "claude", setupTimeoutMs: 0 },
      { callTool: run.callTool, signal: live() }
    );

    expect(outcome.ok).toBe(true);
  });

  it("claims no worktree for a create that answered without one", async () => {
    const run = steps({ "worktree.createWithRecipe": [() => ok({ recipeLaunched: false })] });

    const { result, outcome } = await runLaunchInNewWorktree(
      { source: SOURCE, agentId: "claude" },
      { callTool: run.callTool, signal: live() }
    );

    expect(run.names()).toEqual(["worktree.createWithRecipe"]);
    const envelope = JSON.parse((result.content[0] as { text: string }).text) as { code: string };
    expect(envelope.code).toBe("EXECUTION_ERROR");
    expect(outcome.ok).toBe(false);
  });

  it("answers a create a view didn't answer in time as unconfirmed, not retriable", async () => {
    const run = steps({
      "worktree.createWithRecipe": [
        () =>
          buildToolError({
            code: "EXECUTION_ERROR",
            message: "Action dispatch timed out: worktree.createWithRecipe",
          }),
      ],
    });

    const { result } = await runLaunchInNewWorktree(
      { source: SOURCE, agentId: "claude" },
      { callTool: run.callTool, signal: live() }
    );

    expect(run.names()).toEqual(["worktree.createWithRecipe"]);
    const envelope = JSON.parse((result.content[0] as { text: string }).text) as {
      code: string;
      retriable: boolean;
      message: string;
    };
    expect(envelope).toMatchObject({ code: "CREATE_UNCONFIRMED", retriable: false });
    expect(envelope.message).toMatch(/isn't known whether a worktree was made/);
  });

  it.each([
    "Action dispatch timed out: worktree.createWithRecipe — its deadline passed before it was sent",
    "Action dispatch timed out: worktree.createWithRecipe — too little of the call's deadline was left to send it",
  ])("leaves a create that was never sent as the error it is: %s", async (message) => {
    // Nothing was sent, so nothing can have been made.
    const notSent = buildToolError({ code: "EXECUTION_ERROR", message });
    const run = steps({ "worktree.createWithRecipe": [() => notSent] });

    const { result } = await runLaunchInNewWorktree(
      { source: SOURCE, agentId: "claude" },
      { callTool: run.callTool, signal: live() }
    );

    expect(result).toBe(notSent);
  });

  it("passes the call's create key to the create step", async () => {
    const run = steps({
      "worktree.createWithRecipe": [() => buildToolError({ code: "X", message: "no" })],
    });

    await runLaunchInNewWorktree(
      { source: SOURCE, agentId: "claude" },
      { callTool: run.callTool, signal: live(), createRequestKey: "key-1" }
    );

    expect(run.calls[0]!.args).toEqual({ source: SOURCE, requestKey: "key-1" });
  });

  describe("arguments", () => {
    const run = () => steps({});

    it.each([
      [{ source: SOURCE, agentId: "claude", recipeId: "work" }, /runs no recipe/],
      [{ source: SOURCE, agentId: "claude", worktreeId: WORKTREE }, /takes no worktreeId/],
      [{ agentId: "claude" }, /at 'source'/],
      [{ source: SOURCE, agentId: "claude", unknown: 1 }, /Unrecognized key/],
      [
        {
          source: SOURCE,
          agentId: "claude",
          setupTimeoutMs: 600_000,
          waitForReply: true,
          waitSeconds: 1_800,
        },
        /together can't exceed 1800 s/,
      ],
      [{ source: SOURCE, agentId: "claude", handback: true }, /needs a non-empty `prompt`/],
    ])("refuses %j before anything is created", async (args, message) => {
      const runner = run();
      const refused = runLaunchInNewWorktree(args, { callTool: runner.callTool, signal: live() });
      await expect(refused).rejects.toThrow(message);
      await expect(refused).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      expect(runner.callTool).not.toHaveBeenCalled();
    });

    it("holds setup and reply waits to 1800 s together, and only with waitForReply", async () => {
      const accepts = async (extra: Record<string, unknown>) => {
        const runner = steps({
          "worktree.createWithRecipe": [() => buildToolError({ code: "X", message: "no" })],
        });
        return runLaunchInNewWorktree(
          { source: SOURCE, agentId: "claude", ...extra },
          { callTool: runner.callTool, signal: live() }
        ).then(
          () => true,
          () => false
        );
      };
      // The default setup budget is 300 s, so the reply may have the other 1500.
      expect(await accepts({ waitForReply: true, waitSeconds: 1_500 })).toBe(true);
      expect(await accepts({ waitForReply: true, waitSeconds: 1_501 })).toBe(false);
      expect(await accepts({ waitForReply: true, waitSeconds: 1_800, setupTimeoutMs: 0 })).toBe(
        true
      );
      expect(
        await accepts({ waitForReply: false, waitSeconds: 1_800, setupTimeoutMs: 600_000 })
      ).toBe(true);
    });

    it("lets the default budgets through together", async () => {
      const runner = steps({
        "worktree.createWithRecipe": [createdOk],
        "worktree.waitUntilReady": [() => setup("ready")],
        "agent.launch": [() => launchedOk()],
      });
      const { outcome } = await runLaunchInNewWorktree(
        { source: SOURCE, agentId: "claude", prompt: "x", waitForReply: true },
        { callTool: runner.callTool, signal: live() }
      );
      expect(outcome.ok).toBe(true);
    });
  });
});
