import { describe, expect, it, vi } from "vitest";
import { MAX_RELAY_RESULT_BYTES, type ThrowawayCallPayload } from "../linkMethods.js";
import { RELAY_CALL_RETENTION_MS } from "../relayCallLedger.js";
import {
  createThrowawayRelay,
  type HostThrowawayExecution,
  type HostThrowawayExecutor,
} from "../throwawayRelay.js";

const RUN = {
  runId: "run-1",
  agentId: "claude",
  startedAt: 1_000,
  ageMs: 0,
  timeLimitMs: null,
  expiresAt: null,
  state: "running" as const,
  endedAt: null,
  endReason: null,
};

const LAUNCH: ThrowawayCallPayload = {
  helpSessionId: "help-1",
  tier: "core",
  callId: "call-1",
  resend: false,
  call: { tool: "throwaway.launch", args: { agentId: "claude" } },
  runMs: 90_000,
};

function executor(
  answer: () => Promise<HostThrowawayExecution> = async () => ({
    status: "done",
    result: { tool: "throwaway.launch", run: RUN },
  })
) {
  const run = vi.fn<HostThrowawayExecutor["run"]>(answer);
  return { run };
}

describe("createThrowawayRelay (#14446)", () => {
  it("runs a call for its sender and help session, with the call's own id and deadline", async () => {
    const runs = executor();
    const relay = createThrowawayRelay({ acceptsRemoteControl: () => true, executor: () => runs });
    await expect(relay.call("sender-a", LAUNCH)).resolves.toEqual({
      status: "done",
      result: { tool: "throwaway.launch", run: RUN },
    });
    expect(runs.run).toHaveBeenCalledWith(
      { senderId: "sender-a", helpSessionId: "help-1" },
      LAUNCH.call,
      { callId: "call-1", timeoutMs: 90_000 }
    );
    relay.dispose();
  });

  it("never launches twice for one callId, while it runs or after it settled", async () => {
    let finish!: (answer: HostThrowawayExecution) => void;
    const runs = executor(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const relay = createThrowawayRelay({ acceptsRemoteControl: () => true, executor: () => runs });
    const first = relay.call("sender-a", LAUNCH);
    const joined = relay.call("sender-a", { ...LAUNCH, resend: true });
    await vi.waitFor(() => expect(runs.run).toHaveBeenCalledTimes(1));
    finish({ status: "done", result: { tool: "throwaway.launch", run: RUN } });
    const answers = await Promise.all([first, joined]);
    expect(answers[1]).toEqual(answers[0]);
    await expect(relay.call("sender-a", { ...LAUNCH, resend: true })).resolves.toEqual(answers[0]);
    // A first send repeated is the same call too: its record answers it.
    await expect(relay.call("sender-a", LAUNCH)).resolves.toEqual(answers[0]);
    expect(runs.run).toHaveBeenCalledTimes(1);
    relay.dispose();
  });

  it("never starts a resend it has no record of, and refuses an id reused for another call", async () => {
    let now = 0;
    const runs = executor();
    const relay = createThrowawayRelay({
      acceptsRemoteControl: () => true,
      executor: () => runs,
      now: () => now,
    });
    await expect(relay.call("sender-a", { ...LAUNCH, resend: true })).resolves.toEqual({
      status: "unknown",
    });
    expect(runs.run).not.toHaveBeenCalled();
    await relay.call("sender-a", LAUNCH);
    await expect(
      relay.call("sender-a", {
        ...LAUNCH,
        call: { tool: "throwaway.launch", args: { agentId: "codex" } },
      })
    ).resolves.toEqual({ status: "conflict" });
    // Another help session under the same id is another call too.
    await expect(relay.call("sender-a", { ...LAUNCH, helpSessionId: "help-2" })).resolves.toEqual({
      status: "conflict",
    });
    // Another sender's ids are its own.
    await relay.call("sender-b", LAUNCH);
    expect(runs.run).toHaveBeenCalledTimes(2);
    now += RELAY_CALL_RETENTION_MS + 1;
    await expect(relay.call("sender-a", { ...LAUNCH, resend: true })).resolves.toEqual({
      status: "unknown",
    });
    expect(runs.run).toHaveBeenCalledTimes(2);
    relay.dispose();
  });

  it("refuses before anything runs while the person refuses remote control or no runs exist", async () => {
    const runs = executor();
    let accepts = false;
    let offered: HostThrowawayExecutor | null = runs;
    const relay = createThrowawayRelay({
      acceptsRemoteControl: () => accepts,
      executor: () => offered,
    });
    await expect(relay.call("sender-a", LAUNCH)).resolves.toEqual({
      status: "refused",
      reason: "control-off",
    });
    accepts = true;
    offered = null;
    await expect(relay.call("sender-a", { ...LAUNCH, callId: "call-2" })).resolves.toEqual({
      status: "refused",
      reason: "throwaway-off",
    });
    expect(runs.run).not.toHaveBeenCalled();
    relay.dispose();
  });

  it("reads an executor that threw as its tool's failure, and a read's throw as a throw", async () => {
    const runs = executor(async () => {
      throw new Error("pty-host gone");
    });
    const relay = createThrowawayRelay({ acceptsRemoteControl: () => true, executor: () => runs });
    await expect(relay.call("sender-a", LAUNCH)).resolves.toEqual({
      status: "failed",
      reason: "launch-failed",
    });
    const send = {
      ...LAUNCH,
      callId: "call-2",
      call: { tool: "throwaway.sendKeys" as const, args: { runId: "run-1", keys: ["enter"] } },
    };
    await expect(relay.call("sender-a", send)).resolves.toEqual({
      status: "failed",
      reason: "input-failed",
    });
    const status = {
      ...LAUNCH,
      callId: "call-3",
      call: { tool: "throwaway.status" as const, args: { runId: "run-1" } },
    };
    await expect(relay.call("sender-a", status)).rejects.toThrow("pty-host gone");
    // Settled as that throw: a resend reads it again rather than running it.
    await expect(relay.call("sender-a", { ...status, resend: true })).rejects.toThrow(
      "pty-host gone"
    );
    expect(runs.run).toHaveBeenCalledTimes(3);
    relay.dispose();
  });

  it("never runs again on an answer the Shell couldn't read, or one for another tool", async () => {
    const runs = executor(
      async () => ({ status: "done", result: { tool: "throwaway.launch" } }) as never
    );
    const relay = createThrowawayRelay({ acceptsRemoteControl: () => true, executor: () => runs });
    await expect(relay.call("sender-a", LAUNCH)).rejects.toMatchObject({ code: "INTERNAL" });
    await expect(relay.call("sender-a", { ...LAUNCH, resend: true })).rejects.toMatchObject({
      code: "INTERNAL",
    });
    runs.run.mockResolvedValueOnce({
      status: "done",
      result: { tool: "throwaway.status", run: RUN },
    });
    await expect(relay.call("sender-a", { ...LAUNCH, callId: "call-2" })).rejects.toMatchObject({
      code: "INTERNAL",
    });
    expect(runs.run).toHaveBeenCalledTimes(2);
    relay.dispose();
  });

  it("cuts an output read too large to carry to its last lines, saying so", async () => {
    const line = "x".repeat(1_000);
    const lines = Array.from({ length: 400 }, (_, index) => `${index}:${line}`);
    const runs = executor(async () => ({
      status: "done",
      result: {
        tool: "throwaway.output",
        run: RUN,
        content: lines.join("\n"),
        lineCount: lines.length,
        truncated: false,
      },
    }));
    const relay = createThrowawayRelay({ acceptsRemoteControl: () => true, executor: () => runs });
    const answer = await relay.call("sender-a", {
      ...LAUNCH,
      call: { tool: "throwaway.output", args: { runId: "run-1" } },
    });
    expect(Buffer.byteLength(JSON.stringify(answer), "utf8")).toBeLessThanOrEqual(
      MAX_RELAY_RESULT_BYTES
    );
    if (answer.status !== "done" || answer.result.tool !== "throwaway.output") {
      throw new Error("expected an output read");
    }
    const kept = answer.result.content.split("\n");
    expect(answer.result.truncated).toBe(true);
    expect(answer.result.lineCount).toBe(kept.length);
    expect(kept.length).toBeLessThan(lines.length);
    expect(kept).toEqual(lines.slice(lines.length - kept.length));
    relay.dispose();
  });

  it("measures an output read as it is carried, escapes and multibyte text included", async () => {
    const read = (content: string) =>
      executor(async () => ({
        status: "done",
        result: { tool: "throwaway.output", run: RUN, content, lineCount: 1, truncated: false },
      }));
    const output = {
      ...LAUNCH,
      call: { tool: "throwaway.output" as const, args: { runId: "run-1" } },
    };
    // Each fits raw but not escaped, or not in bytes: both must be cut.
    const quoted = Array.from({ length: 400 }, (_, index) => `${index}${'"'.repeat(300)}`);
    const wide = Array.from(
      { length: 400 },
      (_, index) => `${index}${"\u00e9\u{1F600}".repeat(100)}`
    );
    for (const lines of [quoted, wide]) {
      const relay = createThrowawayRelay({
        acceptsRemoteControl: () => true,
        executor: () => read(lines.join("\n")),
      });
      const answer = await relay.call("sender-a", output);
      expect(Buffer.byteLength(JSON.stringify(answer), "utf8")).toBeLessThanOrEqual(
        MAX_RELAY_RESULT_BYTES
      );
      if (answer.status !== "done" || answer.result.tool !== "throwaway.output") {
        throw new Error("expected an output read");
      }
      const kept = answer.result.content.split("\n");
      expect(answer.result.truncated).toBe(true);
      expect(kept).toEqual(lines.slice(lines.length - kept.length));
      relay.dispose();
    }
    // One line too long to carry at all leaves nothing of it.
    const relay = createThrowawayRelay({
      acceptsRemoteControl: () => true,
      executor: () => read('"'.repeat(MAX_RELAY_RESULT_BYTES)),
    });
    await expect(relay.call("sender-a", output)).resolves.toMatchObject({
      status: "done",
      result: { content: "", lineCount: 0, truncated: true },
    });
    relay.dispose();
  });
});
