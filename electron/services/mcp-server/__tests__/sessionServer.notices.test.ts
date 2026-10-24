import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0-test",
  },
}));

import { createSessionServer } from "../sessionServer.js";
import type { SessionServerDeps } from "../sessionServer.js";
import { TIER_NOT_PERMITTED_CODE } from "../shared.js";
import { buildToolInputSchema } from "../tierAuth.js";
import { MCP_EXTERNAL_OMITTED_ARGS } from "../../../../shared/config/mcpExternalTierAllowlist.js";
import {
  toolErrorPayload,
  fakeSessionStore,
  fakeDeps,
  makeMockTransport,
  callTool,
} from "./helpers/sessionServerFixture.js";

describe("terminal notices", () => {
  const OWN_PANE = { key: "help\u0000lane-1", terminalId: "own-pane" };

  function notifyDeps(
    options: { tier?: "core" | "full" | "external"; origin?: string } = {},
    overrides?: Partial<SessionServerDeps>
  ) {
    const pending = { complete: vi.fn(), cancel: vi.fn() };
    const terminalNotify = {
      whenIdle: vi.fn().mockResolvedValue({ armed: true, terminalId: "t-a" }),
      prepareSend: vi.fn().mockResolvedValue(pending),
      prepareLaunch: vi.fn().mockResolvedValue(pending),
      prepareKeys: vi.fn().mockResolvedValue(pending),
      forgetTarget: vi.fn(),
      holdTarget: vi.fn(),
      settleTargetHold: vi.fn(),
      supersede: vi.fn(),
      releaseHold: vi.fn(),
    };
    const dispatchAction = vi.fn().mockResolvedValue({
      result: { ok: true, result: { sent: true, terminalId: "t-a", submissionToken: "tok-1" } },
    });
    const sessionStore = fakeSessionStore(options.tier ?? "core");
    const deps = fakeDeps({
      sessionStore,
      terminalNotify,
      resolveOwnPane: () => OWN_PANE,
      dispatchAction,
      ...overrides,
    });
    const start = async (sessionId: string) => {
      if (options.origin !== undefined) {
        (sessionStore as unknown as { sessionOriginMap: Map<string, string> }).sessionOriginMap.set(
          sessionId,
          options.origin
        );
      }
      const server = createSessionServer(sessionId, deps);
      await server.connect(makeMockTransport());
      return server;
    };
    return { deps, terminalNotify, pending, dispatchAction, start };
  }

  describe("batch tools", () => {
    it("launches each named agent as its own agent.launch, each with its own notice", async () => {
      const dispatchAction = vi.fn().mockImplementation(async (_id: string, args: unknown) => ({
        result: {
          ok: true,
          result: {
            launched: true,
            terminalId: `t-${(args as { agentId: string }).agentId}`,
            spawnStatus: null,
          },
        },
      }));
      const { terminalNotify, start } = notifyDeps({ origin: "help" }, { dispatchAction });
      const server = await start("session-launch-many");

      const result = await callTool(server, {
        name: "agent.launchMany",
        arguments: {
          agentIds: ["claude", "codex"],
          prompt: "one fact",
          name: "Fact",
          notify: true,
          handback: true,
        },
      });

      expect(dispatchAction.mock.calls.map((c) => [c[0], c[1]])).toEqual([
        [
          "agent.launch",
          {
            agentId: "claude",
            prompt: "one fact",
            name: "Fact: claude",
            notify: true,
            handback: true,
            requestedId: expect.stringMatching(/^claude-[0-9a-f]{4}$/),
          },
        ],
        [
          "agent.launch",
          {
            agentId: "codex",
            prompt: "one fact",
            name: "Fact: codex",
            notify: true,
            handback: true,
            requestedId: expect.stringMatching(/^codex-[0-9a-f]{4}$/),
          },
        ],
      ]);
      expect(terminalNotify.prepareLaunch).toHaveBeenCalledTimes(2);
      expect(result.structuredContent).toMatchObject({
        results: [
          { target: "claude", ok: true, result: { terminalId: "t-claude" } },
          { target: "codex", ok: true, result: { terminalId: "t-codex" } },
        ],
      });
    });

    it("sends each terminal its own message through the assistant's send", async () => {
      const { terminalNotify, dispatchAction, start } = notifyDeps({ origin: "help" });
      const server = await start("session-send-many");

      await callTool(server, {
        name: "terminal.sendCommandMany",
        arguments: {
          sends: [
            { terminalId: "t-a", command: "ballot A" },
            { terminalId: "t-b", command: "ballot B" },
          ],
          notify: true,
        },
      });

      expect(dispatchAction.mock.calls.map((c) => [c[0], c[1]])).toEqual([
        ["terminal.sendCommand", { terminalId: "t-a", command: "ballot A" }],
        ["terminal.sendCommand", { terminalId: "t-b", command: "ballot B" }],
      ]);
      expect(terminalNotify.prepareSend.mock.calls.map((c) => c[1])).toEqual(["t-a", "t-b"]);
      // Omitted, so a notice may carry a handback summary in place of the screen.
      expect(terminalNotify.prepareSend.mock.calls.map((c) => c[2]?.replyLines)).toEqual([
        undefined,
        undefined,
      ]);
    });

    it("passes an explicit replyLines, zero included, to each send's notice", async () => {
      const { terminalNotify, start } = notifyDeps({ origin: "help" });
      const server = await start("session-send-many-lines");

      await callTool(server, {
        name: "terminal.sendCommandMany",
        arguments: {
          sends: [
            { terminalId: "t-a", command: "ballot A" },
            { terminalId: "t-b", command: "ballot B" },
          ],
          notify: true,
          replyLines: 0,
        },
      });

      expect(terminalNotify.prepareSend.mock.calls.map((c) => c[2]?.replyLines)).toEqual([0, 0]);
    });

    it("sends through the owned tool from an agent pane, which refuses what it did not create", async () => {
      const { deps, dispatchAction, start } = notifyDeps({ origin: "external" });
      Object.assign(deps.sessionStore, { terminalAdoption: { get: () => undefined } });
      const server = await start("session-send-many-pane");

      const result = await callTool(server, {
        name: "terminal.sendCommandMany",
        arguments: { sends: [{ terminalId: "t-foreign", command: "hi" }] },
      });

      expect(dispatchAction).not.toHaveBeenCalled();
      expect(result.structuredContent).toMatchObject({
        results: [{ target: "t-foreign", ok: false }],
      });
    });

    it("holds a waitForReply send open and returns the agent's reply with the send", async () => {
      const bind = vi.fn();
      const wait = vi.fn(() => ({
        bind,
        cancel: vi.fn(),
        promise: Promise.resolve({
          terminalId: "t-a",
          outcome: "handback" as const,
          reply: { text: "Fact: honey", lineCount: 1, truncated: false },
        }),
      }));
      const { dispatchAction, start } = notifyDeps({ origin: "help" }, { replyWaiter: { wait } });
      const server = await start("session-wait-send");

      const result = await callTool(server, {
        name: "terminal.sendCommand",
        arguments: { terminalId: "t-a", command: "one fact", waitForReply: true, waitSeconds: 60 },
      });

      expect(dispatchAction.mock.calls[0]?.[1]).toEqual({ terminalId: "t-a", command: "one fact" });
      expect(wait).toHaveBeenCalledWith(
        expect.objectContaining({ terminalId: "t-a", timeoutMs: 60_000 })
      );
      expect(bind).toHaveBeenCalledWith("t-a", "tok-1");
      expect(result.structuredContent).toMatchObject({
        sent: true,
        reply: { outcome: "handback", reply: { text: "Fact: honey" } },
      });
    });

    it("drops the pane's undelivered notice about a target it prompts without notify", async () => {
      const { terminalNotify, start } = notifyDeps({ origin: "help" });
      const server = await start("session-supersede");

      await callTool(server, {
        name: "terminal.sendCommand",
        arguments: { terminalId: "t-a", command: "now vote" },
      });
      expect(terminalNotify.supersede).toHaveBeenCalledWith(OWN_PANE, "t-a");

      terminalNotify.supersede.mockClear();
      await callTool(server, {
        name: "terminal.sendCommand",
        arguments: { terminalId: "t-a", command: "now vote", notify: true },
      });
      expect(terminalNotify.supersede).not.toHaveBeenCalled();
      expect(terminalNotify.prepareSend).toHaveBeenCalled();
    });

    it("holds a notice behind the same call's reply wait, and drops it once answered", async () => {
      const wait = vi.fn(() => ({
        bind: vi.fn(),
        cancel: vi.fn(),
        promise: Promise.resolve({ terminalId: "t-a", outcome: "handback" as const }),
      }));
      const { terminalNotify, start } = notifyDeps({ origin: "help" }, { replyWaiter: { wait } });
      const server = await start("session-wait-notify");

      await callTool(server, {
        name: "terminal.sendCommand",
        arguments: { terminalId: "t-a", command: "one fact", notify: true, waitForReply: true },
      });
      await Promise.resolve();

      const hold = terminalNotify.prepareSend.mock.calls[0]?.[2]?.hold;
      expect(hold).toBeDefined();
      expect(terminalNotify.releaseHold).toHaveBeenCalledWith(OWN_PANE, hold, true, false);
    });

    it("tells the notice when the wait answered with a stop and no marker", async () => {
      const wait = vi.fn(() => ({
        bind: vi.fn(),
        cancel: vi.fn(),
        promise: Promise.resolve({ terminalId: "t-a", outcome: "settled" as const }),
      }));
      const { terminalNotify, start } = notifyDeps({ origin: "help" }, { replyWaiter: { wait } });
      const server = await start("session-wait-notify-no-marker");

      await callTool(server, {
        name: "terminal.sendCommand",
        arguments: {
          terminalId: "t-a",
          command: "one fact",
          notify: true,
          handback: true,
          waitForReply: true,
        },
      });
      await Promise.resolve();

      const hold = terminalNotify.prepareSend.mock.calls[0]?.[2]?.hold;
      expect(terminalNotify.releaseHold).toHaveBeenCalledWith(OWN_PANE, hold, true, true);
    });

    it("gives each batch item's notice its own hold, released when its wait runs out", async () => {
      const dispatchAction = vi.fn().mockImplementation(async (_id: string, args: unknown) => ({
        result: {
          ok: true,
          result: {
            launched: true,
            terminalId: `t-${(args as { agentId: string }).agentId}`,
            spawnStatus: null,
          },
        },
      }));
      const wait = vi.fn(() => ({
        bind: vi.fn(),
        cancel: vi.fn(),
        promise: Promise.resolve({ terminalId: "t-claude", outcome: "timeout" as const }),
      }));
      const { terminalNotify, start } = notifyDeps(
        { origin: "help" },
        { dispatchAction, replyWaiter: { wait } }
      );
      const server = await start("session-batch-wait-notify");

      await callTool(server, {
        name: "agent.launchMany",
        arguments: {
          agentIds: ["claude", "codex"],
          prompt: "one fact",
          notify: true,
          waitForReply: true,
        },
      });

      const holds = terminalNotify.prepareLaunch.mock.calls.map((call) => call[1]?.hold);
      expect(holds).toHaveLength(2);
      expect(holds[0]).toBeDefined();
      expect(holds[0]).not.toBe(holds[1]);
      expect(terminalNotify.releaseHold.mock.calls).toEqual([
        [OWN_PANE, holds[0], false, false],
        [OWN_PANE, holds[1], false, false],
      ]);
    });

    it("gives a duplicate waited launch the reply, not a bare receipt", async () => {
      const dispatchAction = vi.fn().mockResolvedValue({
        result: {
          ok: true,
          result: {
            launched: true,
            terminalId: "claude-1a2b",
            location: "grid",
            spawnStatus: null,
            worktreeId: null,
            worktreePath: null,
            branch: null,
            cwd: "/repo",
            reply: null,
          },
        },
      });
      const wait = vi.fn(() => ({
        bind: vi.fn(),
        cancel: vi.fn(),
        promise: Promise.resolve({
          terminalId: "claude-1a2b",
          outcome: "handback" as const,
          reply: { text: "Fact: honey", lineCount: 1, truncated: false },
        }),
      }));
      const { start } = notifyDeps({ origin: "help" }, { dispatchAction, replyWaiter: { wait } });
      const server = await start("session-wait-dedup");
      const call = () =>
        callTool(server, {
          name: "agent.launch",
          arguments: {
            agentId: "claude",
            prompt: "one fact",
            requestedId: "claude-1a2b",
            waitForReply: true,
          },
        });

      const first = await call();
      const second = await call();

      expect(dispatchAction).toHaveBeenCalledTimes(1);
      for (const result of [first, second]) {
        expect(result.structuredContent).toMatchObject({
          terminalId: "claude-1a2b",
          reply: { outcome: "handback", reply: { text: "Fact: honey" } },
        });
      }
    });

    it("sends every item before waiting, then returns each item's reply", async () => {
      const order: string[] = [];
      const dispatchAction = vi.fn().mockImplementation(async (_id: string, args: unknown) => {
        const { terminalId } = args as { terminalId: string };
        order.push(`send ${terminalId}`);
        return {
          result: {
            ok: true,
            result: { sent: true, terminalId, submissionToken: `tok-${terminalId}` },
          },
        };
      });
      const wait = vi.fn((options: { terminalId?: string }) => {
        order.push(`wait ${options.terminalId}`);
        return {
          bind: vi.fn(),
          cancel: vi.fn(),
          promise: Promise.resolve({
            terminalId: options.terminalId ?? "",
            outcome: "settled" as const,
            reply: { text: `vote from ${options.terminalId}`, lineCount: 1, truncated: false },
          }),
        };
      });
      const { start } = notifyDeps({ origin: "help" }, { dispatchAction, replyWaiter: { wait } });
      const server = await start("session-wait-batch");

      const result = await callTool(server, {
        name: "terminal.sendCommandMany",
        arguments: {
          sends: [
            { terminalId: "t-a", command: "ballot" },
            { terminalId: "t-b", command: "ballot" },
          ],
          waitForReply: true,
        },
      });

      expect(order).toEqual(["wait t-a", "send t-a", "wait t-b", "send t-b"]);
      expect(result.structuredContent).toMatchObject({
        results: [
          { target: "t-a", ok: true, reply: { reply: { text: "vote from t-a" } } },
          { target: "t-b", ok: true, reply: { reply: { text: "vote from t-b" } } },
        ],
      });
    });

    it("keeps going past an item that fails, and cancels only that item's wait", async () => {
      const dispatchAction = vi.fn().mockImplementation(async (_id: string, args: unknown) => {
        const { terminalId } = args as { terminalId: string };
        if (terminalId === "t-a") throw new Error("renderer gone");
        return { result: { ok: true, result: { sent: true, terminalId, submissionToken: "tok" } } };
      });
      const cancels: string[] = [];
      const wait = vi.fn((options: { terminalId?: string }) => ({
        bind: vi.fn(),
        cancel: vi.fn(() => cancels.push(options.terminalId ?? "")),
        promise: Promise.resolve({
          terminalId: options.terminalId ?? "",
          outcome: "settled" as const,
        }),
      }));
      const { start } = notifyDeps({ origin: "help" }, { dispatchAction, replyWaiter: { wait } });
      const server = await start("session-batch-item-error");

      const result = await callTool(server, {
        name: "terminal.sendCommandMany",
        arguments: {
          sends: [
            { terminalId: "t-a", command: "x" },
            { terminalId: "t-b", command: "x" },
          ],
          waitForReply: true,
        },
      });

      const items = (
        result.structuredContent as { results: Array<{ target: string; ok: boolean }> }
      ).results;
      expect(items.map((r) => [r.target, r.ok])).toEqual([
        ["t-a", false],
        ["t-b", true],
      ]);
      expect(cancels).toEqual(["t-a"]);
    });

    it("shares the response ceiling across replies, keeping each reply's end", async () => {
      const dispatchAction = vi.fn().mockImplementation(async (_id: string, args: unknown) => {
        const { terminalId } = args as { terminalId: string };
        return { result: { ok: true, result: { sent: true, terminalId, submissionToken: "tok" } } };
      });
      const long = "a".repeat(20_000) + "END";
      const wait = vi.fn((options: { terminalId?: string }) => ({
        bind: vi.fn(),
        cancel: vi.fn(),
        promise: Promise.resolve({
          terminalId: options.terminalId ?? "",
          outcome: "settled" as const,
          reply: { text: long, lineCount: 1, truncated: false },
        }),
      }));
      const { start } = notifyDeps({ origin: "help" }, { dispatchAction, replyWaiter: { wait } });
      const server = await start("session-batch-reply-budget");

      const result = await callTool(server, {
        name: "terminal.sendCommandMany",
        arguments: {
          sends: ["t-a", "t-b", "t-c", "t-d"].map((terminalId) => ({ terminalId, command: "x" })),
          waitForReply: true,
        },
      });

      expect(result.isError).not.toBe(true);
      const items = (
        result.structuredContent as {
          results: Array<{ reply: { reply: { text: string; truncated: boolean } } }>;
        }
      ).results;
      expect(items).toHaveLength(4);
      for (const item of items) {
        expect(item.reply.reply.text.endsWith("END")).toBe(true);
        expect(item.reply.reply.text.length).toBeLessThan(long.length);
        expect(item.reply.reply.truncated).toBe(true);
      }
    });

    it("rejects malformed batch arguments before any item runs", async () => {
      const { dispatchAction, start } = notifyDeps({ origin: "help" });
      const server = await start("session-batch-invalid");

      await expect(
        callTool(server, { name: "agent.launchMany", arguments: { agentIds: [], prompt: "x" } })
      ).rejects.toThrow(/agent\.launchMany/);
      expect(dispatchAction).not.toHaveBeenCalled();
    });
  });

  describe("terminal.notifyWhenIdle", () => {
    it("arms in main for the caller's own pane, never through a renderer", async () => {
      const { terminalNotify, dispatchAction, deps, start } = notifyDeps();
      const server = await start("session-notify");

      const result = await callTool(server, {
        name: "terminal.notifyWhenIdle",
        arguments: { terminalId: "t-a", note: "next: review" },
      });

      expect(result.isError).not.toBe(true);
      expect(terminalNotify.whenIdle).toHaveBeenCalledWith(OWN_PANE, {
        terminalId: "t-a",
        note: "next: review",
      });
      expect(result.structuredContent).toEqual({ armed: true, terminalId: "t-a" });
      expect(dispatchAction).not.toHaveBeenCalled();
      expect(deps.appendAuditRecord).toHaveBeenCalledWith(
        expect.objectContaining({ toolId: "terminal.notifyWhenIdle" })
      );
    });

    it("refuses a connection with no pane of its own", async () => {
      const { terminalNotify, start } = notifyDeps({}, { resolveOwnPane: () => null });
      const server = await start("session-notify-no-pane");

      const result = await callTool(server, {
        name: "terminal.notifyWhenIdle",
        arguments: { terminalId: "t-a" },
      });

      expect(result.isError).toBe(true);
      expect(toolErrorPayload(result).code).toBe("NOTIFY_NOT_ELIGIBLE");
      expect(terminalNotify.whenIdle).not.toHaveBeenCalled();
    });

    it("keeps the tool from an api-key session altogether", async () => {
      const { terminalNotify, start } = notifyDeps({ tier: "external" });
      const server = await start("session-notify-external");

      const result = await callTool(server, {
        name: "terminal.notifyWhenIdle",
        arguments: { terminalId: "t-a" },
      });

      expect(result.isError).toBe(true);
      expect(toolErrorPayload(result).code).toBe(TIER_NOT_PERMITTED_CODE);
      expect(terminalNotify.whenIdle).not.toHaveBeenCalled();
    });

    it("returns a refusal under its own code", async () => {
      const { TerminalNotifyError } = await import("../terminalNotify.js");
      const { terminalNotify, start } = notifyDeps();
      terminalNotify.whenIdle.mockRejectedValue(
        new TerminalNotifyError("NOTIFY_TARGET_UNAVAILABLE", "Not here.")
      );
      const server = await start("session-notify-refused");

      const result = await callTool(server, {
        name: "terminal.notifyWhenIdle",
        arguments: { terminalId: "t-a" },
      });

      expect(result.isError).toBe(true);
      expect(toolErrorPayload(result).code).toBe("NOTIFY_TARGET_UNAVAILABLE");
    });

    it("rejects malformed arguments before the service sees them", async () => {
      const { terminalNotify, start } = notifyDeps();
      const server = await start("session-notify-invalid");

      await expect(
        callTool(server, { name: "terminal.notifyWhenIdle", arguments: {} })
      ).rejects.toThrow(/terminal\.notifyWhenIdle/);
      expect(terminalNotify.whenIdle).not.toHaveBeenCalled();
    });
  });

  describe("notify on a send", () => {
    it("arms before the prompt goes out, strips the flag, and hands the notice the result", async () => {
      const { terminalNotify, pending, dispatchAction, start } = notifyDeps({ origin: "help" });
      const server = await start("session-send-notify");

      const result = await callTool(server, {
        name: "terminal.sendCommand",
        arguments: { terminalId: "t-a", command: "plan it", notify: true },
      });

      expect(result.isError).not.toBe(true);
      expect(terminalNotify.prepareSend).toHaveBeenCalledWith(OWN_PANE, "t-a", {});
      expect(terminalNotify.prepareSend.mock.invocationCallOrder[0]).toBeLessThan(
        dispatchAction.mock.invocationCallOrder[0]!
      );
      expect(dispatchAction.mock.calls[0]?.slice(0, 2)).toEqual([
        "terminal.sendCommand",
        { terminalId: "t-a", command: "plan it" },
      ]);
      expect(pending.complete).toHaveBeenCalledWith({
        sent: true,
        terminalId: "t-a",
        submissionToken: "tok-1",
      });
      expect(pending.cancel).not.toHaveBeenCalled();
    });

    it("hands the notice the reply length it asked for, and strips it from the send", async () => {
      const { terminalNotify, dispatchAction, start } = notifyDeps({ origin: "help" });
      const server = await start("session-send-reply-lines");

      await callTool(server, {
        name: "terminal.sendCommand",
        arguments: { terminalId: "t-a", command: "vote", notify: true, replyLines: 12 },
      });

      expect(terminalNotify.prepareSend).toHaveBeenCalledWith(OWN_PANE, "t-a", { replyLines: 12 });
      expect(dispatchAction.mock.calls[0]?.[1]).toEqual({ terminalId: "t-a", command: "vote" });
    });

    it("tells the notice the prompt asked for a handback, and still sends the flag", async () => {
      const { terminalNotify, dispatchAction, start } = notifyDeps({ origin: "help" });
      const server = await start("session-send-handback");

      await callTool(server, {
        name: "terminal.sendCommand",
        arguments: { terminalId: "t-a", command: "vote", notify: true, handback: true },
      });

      expect(terminalNotify.prepareSend).toHaveBeenCalledWith(OWN_PANE, "t-a", { handback: true });
      expect(dispatchAction.mock.calls[0]?.[1]).toEqual({
        terminalId: "t-a",
        command: "vote",
        handback: true,
      });
    });

    it("forwards a malformed reply length for the send's own schema to reject", async () => {
      const { terminalNotify, dispatchAction, start } = notifyDeps({ origin: "help" });
      const server = await start("session-send-reply-lines-bad");

      await callTool(server, {
        name: "terminal.sendCommand",
        arguments: { terminalId: "t-a", command: "vote", notify: true, replyLines: -1 },
      });

      expect(terminalNotify.prepareSend).toHaveBeenCalledWith(OWN_PANE, "t-a", {});
      expect(dispatchAction.mock.calls[0]?.[1]).toMatchObject({ replyLines: -1 });
    });

    it("arms a key press through its own path and strips the flag from the keys", async () => {
      const { terminalNotify, dispatchAction, start } = notifyDeps({ origin: "help" });
      const server = await start("session-keys-notify");

      await callTool(server, {
        name: "terminal.sendKeys",
        arguments: { terminalId: "t-a", keys: ["Down", "Enter"], notify: true },
      });

      expect(terminalNotify.prepareKeys).toHaveBeenCalledWith(OWN_PANE, "t-a", {});
      expect(terminalNotify.prepareSend).not.toHaveBeenCalled();
      expect(dispatchAction.mock.calls[0]?.slice(0, 2)).toEqual([
        "terminal.sendKeys",
        { terminalId: "t-a", keys: ["Down", "Enter"] },
      ]);
    });

    it("drops the pane's own notice for a terminal it closes", async () => {
      const { deps, terminalNotify, start } = notifyDeps(
        { origin: "help" },
        { readTerminalCloseContext: vi.fn(async () => null) }
      );
      // One the session launched, idle, so the close runs without asking (#12881).
      deps.sessionStore.resourceOwnership.record("session-close-forgets", [
        { kind: "terminal", id: "t-a" },
      ]);
      const server = await start("session-close-forgets");

      await callTool(server, { name: "terminal.close", arguments: { terminalId: "t-a" } });

      expect(terminalNotify.forgetTarget).toHaveBeenCalledWith(OWN_PANE, "t-a");
    });

    // #14369: held, not dropped, because the user may refuse the restart.
    it("holds the pane's own notice across a restart and drops it once the restart lands", async () => {
      const { deps, terminalNotify, start } = notifyDeps({ origin: "help" });
      deps.sessionStore.resourceOwnership.record("session-restart-holds", [
        { kind: "terminal", id: "t-a" },
      ]);
      const server = await start("session-restart-holds");

      await callTool(server, {
        name: "terminal.restartOnPresetOwned",
        arguments: { terminalId: "t-a", presetId: "work" },
      });

      expect(terminalNotify.forgetTarget).not.toHaveBeenCalled();
      const hold = terminalNotify.holdTarget.mock.calls[0]?.[2];
      expect(terminalNotify.holdTarget).toHaveBeenCalledWith(OWN_PANE, "t-a", hold);
      expect(terminalNotify.settleTargetHold).toHaveBeenCalledWith(OWN_PANE, hold, true);
    });

    it("gives the notice back when the restart is refused", async () => {
      const { deps, terminalNotify, dispatchAction, start } = notifyDeps({ origin: "help" });
      dispatchAction.mockResolvedValue({
        result: { ok: false, error: { code: "CONFIRMATION_DENIED", message: "declined" } },
      });
      deps.sessionStore.resourceOwnership.record("session-restart-refused", [
        { kind: "terminal", id: "t-a" },
      ]);
      const server = await start("session-restart-refused");

      await callTool(server, {
        name: "terminal.restartOnPresetOwned",
        arguments: { terminalId: "t-a", presetId: "work" },
      });

      const hold = terminalNotify.holdTarget.mock.calls[0]?.[2];
      expect(hold).toBeDefined();
      expect(terminalNotify.settleTargetHold).toHaveBeenCalledTimes(1);
      expect(terminalNotify.settleTargetHold).toHaveBeenCalledWith(OWN_PANE, hold, false);
    });

    it("leaves a send without the flag alone", async () => {
      const { terminalNotify, dispatchAction, start } = notifyDeps({ origin: "help" });
      const server = await start("session-send-plain");

      await callTool(server, {
        name: "terminal.sendCommand",
        arguments: { terminalId: "t-a", command: "plan it", notify: false },
      });

      expect(terminalNotify.prepareSend).not.toHaveBeenCalled();
      expect(dispatchAction.mock.calls[0]?.[1]).toEqual({ terminalId: "t-a", command: "plan it" });
    });

    it("drops the notice when the send fails", async () => {
      const { pending, start } = notifyDeps(
        { origin: "help" },
        {
          dispatchAction: vi.fn().mockResolvedValue({
            result: { ok: false, error: { code: "EXECUTION_ERROR", message: "no pty" } },
          }),
        }
      );
      const server = await start("session-send-failed");

      const result = await callTool(server, {
        name: "terminal.sendCommand",
        arguments: { terminalId: "t-a", command: "plan it", notify: true },
      });

      expect(result.isError).toBe(true);
      expect(pending.cancel).toHaveBeenCalledTimes(1);
      expect(pending.complete).not.toHaveBeenCalled();
    });

    it("drops the notice when the dispatch throws", async () => {
      const { pending, start } = notifyDeps(
        { origin: "help" },
        { dispatchAction: vi.fn().mockRejectedValue(new Error("bridge gone")) }
      );
      const server = await start("session-send-threw");

      await callTool(server, {
        name: "terminal.sendCommand",
        arguments: { terminalId: "t-a", command: "plan it", notify: true },
      });

      expect(pending.cancel).toHaveBeenCalledTimes(1);
    });

    it("sends nothing when the notice is refused", async () => {
      const { TerminalNotifyError } = await import("../terminalNotify.js");
      const { terminalNotify, dispatchAction, start } = notifyDeps({ origin: "help" });
      terminalNotify.prepareSend.mockRejectedValue(
        new TerminalNotifyError("VALIDATION_ERROR", "Not an agent.")
      );
      const server = await start("session-send-refused");

      const result = await callTool(server, {
        name: "terminal.sendCommand",
        arguments: { terminalId: "shell", command: "ls", notify: true },
      });

      expect(result.isError).toBe(true);
      expect(toolErrorPayload(result).code).toBe("VALIDATION_ERROR");
      expect(dispatchAction).not.toHaveBeenCalled();
    });

    it("refuses an api-key client before anything is sent: it has no pane", async () => {
      const { terminalNotify, dispatchAction, start } = notifyDeps({ tier: "external" });
      const server = await start("session-launch-external");

      const result = await callTool(server, {
        name: "agent.launch",
        arguments: { agentId: "claude", prompt: "plan it", notify: true },
      });

      expect(result.isError).toBe(true);
      expect(toolErrorPayload(result).code).toBe("NOTIFY_NOT_ELIGIBLE");
      expect(terminalNotify.prepareLaunch).not.toHaveBeenCalled();
      expect(dispatchAction).not.toHaveBeenCalled();
    });

    it("hands a launch's result to its notice", async () => {
      const launchResult = { launched: true, terminalId: "t-new", spawnStatus: null };
      const dispatchAction = vi
        .fn()
        .mockResolvedValue({ result: { ok: true, result: launchResult } });
      const { terminalNotify, pending, start } = notifyDeps({}, { dispatchAction });
      const server = await start("session-launch-notify");

      await callTool(server, {
        name: "agent.launch",
        arguments: { agentId: "claude", prompt: "plan it", notify: true },
      });

      expect(terminalNotify.prepareLaunch).toHaveBeenCalledWith(OWN_PANE, {});
      expect(dispatchAction).toHaveBeenCalledTimes(1);
      // A launch keeps the flag: the renderer, which knows the agent registry,
      // is what refuses it for a shell or panel.
      expect(dispatchAction.mock.calls[0]?.[1]).toMatchObject({ notify: true });
      expect(pending.complete).toHaveBeenCalledWith(launchResult);
    });

    it("drops the notice when the launch refuses it", async () => {
      const { pending, start } = notifyDeps(
        {},
        {
          dispatchAction: vi.fn().mockResolvedValue({
            result: { ok: false, error: { code: "UNACTIONABLE_TARGET", message: "not an agent" } },
          }),
        }
      );
      const server = await start("session-launch-refused");

      const result = await callTool(server, {
        name: "agent.launch",
        arguments: { agentId: "browser", prompt: "plan it", notify: true },
      });

      expect(result.isError).toBe(true);
      expect(pending.cancel).toHaveBeenCalledTimes(1);
      expect(pending.complete).not.toHaveBeenCalled();
    });

    it("refuses a launch with no prompt to finish", async () => {
      const { terminalNotify, dispatchAction, start } = notifyDeps();
      const server = await start("session-launch-no-prompt");

      const result = await callTool(server, {
        name: "agent.launch",
        arguments: { agentId: "claude", notify: true },
      });

      expect(toolErrorPayload(result).code).toBe("VALIDATION_ERROR");
      expect(terminalNotify.prepareLaunch).not.toHaveBeenCalled();
      expect(dispatchAction).not.toHaveBeenCalled();
    });
  });

  it("does not advertise notify to an api-key client", async () => {
    const { buildToolInputSchema } = await import("../tierAuth.js");
    const entry = {
      id: "agent.launch",
      inputSchema: {
        type: "object",
        properties: { agentId: { type: "string" }, notify: { type: "boolean" } },
        required: ["agentId"],
      },
    } as unknown as Parameters<typeof buildToolInputSchema>[0];

    expect(buildToolInputSchema(entry).properties).toHaveProperty("notify");
    expect(
      buildToolInputSchema(entry, MCP_EXTERNAL_OMITTED_ARGS["agent.launch"]).properties
    ).not.toHaveProperty("notify");
  });
});
