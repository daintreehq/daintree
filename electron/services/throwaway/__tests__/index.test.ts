import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
  pty: null as EventEmitter | null,
  registered: new Map<string, unknown>(),
  // Reached only by a launch that got as far as starting its agent.
  mkdir: vi.fn(async () => {
    throw new Error("no spawn in this test");
  }),
}));

vi.mock("node:fs/promises", () => ({ mkdir: shared.mkdir }));

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/daintree-test" } }));
vi.mock("../../../window/serviceRefs.js", () => ({
  getPtyClient: () => shared.pty,
  getCliAvailabilityServiceRef: () => ({ getAvailability: () => ({ claude: "ready" }) }),
}));
vi.mock("../../../remote/runtime.js", () => ({
  registerRemoteService: (name: string, service: unknown) => {
    shared.registered.set(name, service);
    return () => shared.registered.delete(name);
  },
}));

async function load() {
  vi.resetModules();
  const throwaway = await import("../index.js");
  const { HostThrowawayRuns } = await import("../HostThrowawayRuns.js");
  return { throwaway, HostThrowawayRuns };
}

beforeEach(() => {
  shared.pty = new EventEmitter();
  shared.registered.clear();
  shared.mkdir.mockClear();
  vi.restoreAllMocks();
});

describe("the host's registered throwaway runs (#14447)", () => {
  it("hears the pty-host's exits, lost terminals and loss of the host itself", async () => {
    const { throwaway, HostThrowawayRuns } = await load();
    const exit = vi.spyOn(HostThrowawayRuns.prototype, "handleExit");
    const lost = vi.spyOn(HostThrowawayRuns.prototype, "handleLost");
    const hostLost = vi.spyOn(HostThrowawayRuns.prototype, "handleHostLost");
    await throwaway.getHostThrowawayRuns();
    shared.pty!.emit("exit", "daintree-throwaway-1", 0);
    shared.pty!.emit("terminal-lost", "daintree-throwaway-2");
    shared.pty!.emit("host-crash", 1);
    expect(exit).toHaveBeenCalledWith("daintree-throwaway-1");
    expect(lost).toHaveBeenCalledWith("daintree-throwaway-2");
    expect(hostLost).toHaveBeenCalledTimes(1);
  });

  it("launches nothing for an owner that went while the runs were loading", async () => {
    const { throwaway, HostThrowawayRuns } = await load();
    const run = vi.spyOn(HostThrowawayRuns.prototype, "run");
    const teardown = throwaway.registerHostThrowawayRuns();
    const executor = shared.registered.get(
      "hostThrowawayRuns"
    ) as import("../../../remote/assistant/throwawayRelay.js").HostThrowawayExecutor;
    const owner = { senderId: "sender-a", helpSessionId: "help-1" };
    const launching = executor.run(
      owner,
      { tool: "throwaway.launch", args: { agentId: "claude" } },
      { callId: "call-1", timeoutMs: 90_000 }
    );
    const other = executor.run(
      { senderId: "sender-a", helpSessionId: "help-2" },
      { tool: "throwaway.status", args: { runId: "run-1" } },
      { callId: "call-2", timeoutMs: 90_000 }
    );
    executor.endOwner(owner, "session-ended");
    await expect(launching).resolves.toEqual({ status: "failed", reason: "launch-failed" });
    await other;
    // Only the other help session's call reached the runs.
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toEqual({ senderId: "sender-a", helpSessionId: "help-2" });
    teardown();
  });

  it("launches nothing for an owner that went just as the runs finished loading", async () => {
    const { throwaway } = await load();
    const teardown = throwaway.registerHostThrowawayRuns();
    const executor = shared.registered.get(
      "hostThrowawayRuns"
    ) as import("../../../remote/assistant/throwawayRelay.js").HostThrowawayExecutor;
    const owner = { senderId: "sender-a", helpSessionId: "help-1" };
    const launching = executor.run(
      owner,
      { tool: "throwaway.launch", args: { agentId: "claude" } },
      { callId: "call-1", timeoutMs: 90_000 }
    );
    // Queued on the load itself, so it lands between the load and the launch's check.
    void throwaway.getHostThrowawayRuns().then(() => executor.endOwner(owner, "session-ended"));
    await expect(launching).resolves.toEqual({ status: "failed", reason: "launch-failed" });
    expect(shared.mkdir).not.toHaveBeenCalled();
    teardown();
  });

  it("starts the agent of an owner that is still there", async () => {
    const { throwaway } = await load();
    const teardown = throwaway.registerHostThrowawayRuns();
    const executor = shared.registered.get(
      "hostThrowawayRuns"
    ) as import("../../../remote/assistant/throwawayRelay.js").HostThrowawayExecutor;
    await executor.run(
      { senderId: "sender-a", helpSessionId: "help-1" },
      { tool: "throwaway.launch", args: { agentId: "claude" } },
      { callId: "call-1", timeoutMs: 90_000 }
    );
    expect(shared.mkdir).toHaveBeenCalledTimes(1);
    teardown();
  });
});
