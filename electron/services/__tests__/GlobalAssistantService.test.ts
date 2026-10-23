import { describe, expect, it, vi, type Mock } from "vitest";
import { GlobalAssistantService, type GlobalAssistantDeps } from "../GlobalAssistantService.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type MockedDeps = {
  [K in keyof GlobalAssistantDeps]: Mock<GlobalAssistantDeps[K]>;
};

function makeDeps(overrides: Partial<MockedDeps> = {}) {
  let n = 0;
  const calls: string[] = [];
  const deps: MockedDeps = {
    agentId: vi.fn(async () => "claude"),
    provision: vi.fn(async () => {
      n += 1;
      calls.push(`provision-${n}`);
      return { sessionId: `s${n}`, sessionPath: "/g", token: `t${n}`, mcpUrl: "http://x" };
    }),
    takeResume: vi.fn(async () => null),
    releaseResume: vi.fn(async () => {}),
    discardResume: vi.fn(async () => {
      calls.push("discard-resume");
    }),
    spawn: vi.fn(async () => true),
    revoke: vi.fn(async (id: string) => {
      calls.push(`revoke-${id}`);
    }),
    kill: vi.fn((id: string) => {
      calls.push(`kill-${id}`);
    }),
    ...overrides,
  };
  return { deps, calls };
}

describe("GlobalAssistantService", () => {
  it("provisions and spawns once for concurrent opens from two windows", async () => {
    const { deps } = makeDeps();
    const service = new GlobalAssistantService(deps);
    const [a, b] = await Promise.all([service.ensureSession(), service.ensureSession()]);
    expect(deps.provision).toHaveBeenCalledTimes(1);
    expect(deps.spawn).toHaveBeenCalledTimes(1);
    expect(a.terminalId).toBe(b.terminalId);
    expect(a.phase).toBe("running");
    await service.ensureSession();
    expect(deps.provision).toHaveBeenCalledTimes(1);
  });

  it("puts the bearer in the spawn env and not in the returned state", async () => {
    const { deps } = makeDeps();
    const service = new GlobalAssistantService(deps);
    const state = await service.ensureSession();
    expect(deps.spawn.mock.calls[0]![0].env).toMatchObject({ DAINTREE_MCP_TOKEN: "t1" });
    expect(JSON.stringify(state)).not.toContain('t1"');
  });

  it("revokes and kills on a failed spawn, then lets a later open retry", async () => {
    const { deps, calls } = makeDeps();
    deps.spawn.mockResolvedValueOnce(false);
    const service = new GlobalAssistantService(deps);
    await expect(service.ensureSession()).rejects.toMatchObject({ code: "INTERNAL" });
    const revokedAt = calls.indexOf("revoke-s1");
    const killedAt = calls.findIndex((c) => c.startsWith("kill-"));
    expect(revokedAt).toBeGreaterThan(-1);
    expect(killedAt).toBeGreaterThan(revokedAt);
    expect(service.getState().phase).toBe("absent");
    const state = await service.ensureSession();
    expect(state.phase).toBe("running");
  });

  it("releases the resume claim when the spawn fails", async () => {
    const { deps } = makeDeps();
    deps.takeResume.mockResolvedValue({ agentId: "claude", agentSessionId: "conv", claimId: "c1" });
    deps.spawn.mockResolvedValueOnce(false);
    const service = new GlobalAssistantService(deps);
    await expect(service.ensureSession()).rejects.toBeTruthy();
    expect(deps.releaseResume).toHaveBeenCalledWith("c1");
  });

  it("resumes the exact conversation for the same agent and never for another", async () => {
    const { deps } = makeDeps();
    deps.takeResume.mockResolvedValue({ agentId: "claude", agentSessionId: "conv", claimId: "c1" });
    await new GlobalAssistantService(deps).ensureSession();
    expect(deps.spawn.mock.calls[0]![0].resumeAgentSessionId).toBe("conv");

    const other = makeDeps();
    other.deps.takeResume.mockResolvedValue({
      agentId: "codex",
      agentSessionId: "conv",
      claimId: "c2",
    });
    await new GlobalAssistantService(other.deps).ensureSession();
    expect(other.deps.spawn.mock.calls[0]![0].resumeAgentSessionId).toBeUndefined();
  });

  it("refuses with a clear error when no agent can run it", async () => {
    const { deps } = makeDeps({ agentId: vi.fn(async () => null) });
    const service = new GlobalAssistantService(deps);
    await expect(service.ensureSession()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(deps.provision).not.toHaveBeenCalled();
  });

  it("kills a PTY and revokes when torn down during the spawn", async () => {
    const spawn = deferred<boolean>();
    const { deps, calls } = makeDeps();
    deps.spawn.mockReturnValue(spawn.promise);
    const service = new GlobalAssistantService(deps);
    const launch = service.ensureSession();
    await vi.waitFor(() => expect(deps.spawn).toHaveBeenCalled());
    const terminalId = deps.spawn.mock.calls[0]![0].terminalId;
    await service.teardown("discard");
    deps.kill.mockClear();
    spawn.resolve(true);
    await expect(launch).rejects.toMatchObject({ code: "CANCELLED" });
    expect(deps.kill).toHaveBeenCalledWith(terminalId);
    expect(calls).toContain("revoke-s1");
    expect(service.getState().phase).toBe("absent");
  });

  it("does not publish a run whose PTY exited before the spawn confirmed", async () => {
    const spawn = deferred<boolean>();
    const { deps } = makeDeps();
    deps.spawn.mockReturnValueOnce(spawn.promise);
    const service = new GlobalAssistantService(deps);
    const launch = service.ensureSession();
    await vi.waitFor(() => expect(deps.spawn).toHaveBeenCalled());
    service.handleTerminalExit(deps.spawn.mock.calls[0]![0].terminalId);
    spawn.resolve(true);
    await expect(launch).rejects.toMatchObject({ code: "INTERNAL" });
    expect(service.getState().phase).toBe("absent");
    expect((await service.ensureSession()).phase).toBe("running");
    expect(deps.provision).toHaveBeenCalledTimes(2);
  });

  it("waits for a teardown still revoking before it provisions a replacement", async () => {
    const revoke = deferred<void>();
    const { deps } = makeDeps();
    const service = new GlobalAssistantService(deps);
    await service.ensureSession();
    deps.revoke.mockReturnValueOnce(revoke.promise);
    const torn = service.teardown("discard");
    const reopened = service.ensureSession();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deps.provision).toHaveBeenCalledTimes(1);
    revoke.resolve();
    await torn;
    expect((await reopened).phase).toBe("running");
    expect(deps.provision).toHaveBeenCalledTimes(2);
  });

  it("cancels a launch whose agent is changed while it provisions", async () => {
    const provision = deferred<{
      sessionId: string;
      sessionPath: string;
      token: string;
      mcpUrl: null;
    }>();
    const { deps } = makeDeps();
    deps.provision.mockReturnValue(provision.promise as never);
    const service = new GlobalAssistantService(deps);
    const launch = service.ensureSession();
    await vi.waitFor(() => expect(deps.provision).toHaveBeenCalled());
    await service.onAgentChanged("codex");
    provision.resolve({ sessionId: "late", sessionPath: "/g", token: "t", mcpUrl: null });
    await expect(launch).rejects.toMatchObject({ code: "CANCELLED" });
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it("a restart or discard during shutdown cannot erase the captured conversation", async () => {
    const capture = deferred<void>();
    const { deps } = makeDeps();
    const service = new GlobalAssistantService(deps);
    await service.ensureSession();
    deps.revoke.mockReturnValueOnce(capture.promise);
    const down = service.shutdown();
    await expect(service.restart()).rejects.toMatchObject({ code: "CANCELLED" });
    void service.discard();
    capture.resolve();
    await down;
    expect(deps.discardResume).not.toHaveBeenCalled();
  });

  it("discards a provision that finishes after teardown without spawning", async () => {
    const provision = deferred<{
      sessionId: string;
      sessionPath: string;
      token: string;
      mcpUrl: null;
    }>();
    const { deps } = makeDeps();
    deps.provision.mockReturnValue(provision.promise as never);
    const service = new GlobalAssistantService(deps);
    const launch = service.ensureSession();
    await vi.waitFor(() => expect(deps.provision).toHaveBeenCalled());
    await service.teardown("discard");
    provision.resolve({ sessionId: "late", sessionPath: "/g", token: "t", mcpUrl: null });
    await expect(launch).rejects.toMatchObject({ code: "CANCELLED" });
    expect(deps.spawn).not.toHaveBeenCalled();
    expect(deps.revoke).toHaveBeenCalledWith("late", { capture: false });
  });

  it("revokes before it kills, and forgets the conversation on discard and restart only", async () => {
    const { deps, calls } = makeDeps();
    const service = new GlobalAssistantService(deps);
    await service.ensureSession();
    await service.discard();
    const revokedAt = calls.indexOf("revoke-s1");
    const killedAt = calls.findIndex((c) => c.startsWith("kill-"));
    expect(revokedAt).toBeGreaterThan(-1);
    expect(killedAt).toBeGreaterThan(revokedAt);
    expect(deps.discardResume).toHaveBeenCalledTimes(1);
    expect(service.getState().phase).toBe("absent");

    await service.ensureSession();
    await service.teardown("agent-change");
    expect(deps.discardResume).toHaveBeenCalledTimes(1);

    await service.ensureSession();
    const restarted = await service.restart();
    expect(deps.discardResume).toHaveBeenCalledTimes(2);
    expect(restarted.phase).toBe("running");
    expect(deps.takeResume).toHaveBeenLastCalledWith();
  });

  it("restart starts fresh without claiming the old conversation", async () => {
    const { deps } = makeDeps();
    const service = new GlobalAssistantService(deps);
    await service.ensureSession();
    deps.takeResume.mockClear();
    await service.restart();
    expect(deps.takeResume).not.toHaveBeenCalled();
    expect(deps.provision).toHaveBeenCalledTimes(2);
  });

  it("captures the conversation on shutdown and refuses new opens", async () => {
    const { deps } = makeDeps();
    const service = new GlobalAssistantService(deps);
    await service.ensureSession();
    await service.shutdown();
    expect(deps.revoke).toHaveBeenCalledWith("s1", { capture: true });
    await expect(service.ensureSession()).rejects.toMatchObject({ code: "CANCELLED" });
    expect(() => service.attach(1, 1)).toThrow();
  });

  it("ends the run when the agent changes, and leaves it alone for the same agent", async () => {
    const { deps } = makeDeps();
    const service = new GlobalAssistantService(deps);
    await service.ensureSession();
    await service.onAgentChanged("claude");
    expect(service.getState().phase).toBe("running");
    await service.onAgentChanged("codex");
    expect(service.getState().phase).toBe("absent");
    expect(deps.revoke).toHaveBeenCalledWith("s1", { capture: false });
  });

  it("revokes when the PTY exits by itself", async () => {
    const { deps } = makeDeps();
    const service = new GlobalAssistantService(deps);
    const state = await service.ensureSession();
    service.handleTerminalExit("some-other-terminal");
    expect(service.getState().phase).toBe("running");
    service.handleTerminalExit(state.terminalId!);
    await vi.waitFor(() => expect(deps.revoke).toHaveBeenCalledWith("s1", { capture: false }));
    expect(service.getState().phase).toBe("absent");
  });

  describe("attachments and input", () => {
    it("gives the first attachment input and moves it only on an explicit claim", async () => {
      const service = new GlobalAssistantService(makeDeps().deps);
      const a = service.attach(10, 1);
      const b = service.attach(20, 2);
      expect(service.getState().inputOwner).toBe(a);
      const epochBefore = service.getState().inputEpoch;
      expect(service.canWrite(a, epochBefore)).toBe(true);
      expect(service.canWrite(b, epochBefore)).toBe(false);

      service.claimInput(b, 20);
      expect(service.getState().inputOwner).toBe(b);
      expect(service.canWrite(a, epochBefore)).toBe(false);
      expect(service.canWrite(b, epochBefore)).toBe(false);
      expect(service.canWrite(b, service.getState().inputEpoch)).toBe(true);
    });

    it("refuses a claim from a window that does not own the attachment", () => {
      const service = new GlobalAssistantService(makeDeps().deps);
      const a = service.attach(10, 1);
      expect(() => service.claimInput(a, 99)).toThrow(/another window/);
      expect(() => service.claimInput("missing", 10)).toThrow(/gone/);
      expect(service.detach(a, 99)).toBe(false);
    });

    it("releases input when its owner detaches, without ending the session", async () => {
      const { deps } = makeDeps();
      const service = new GlobalAssistantService(deps);
      await service.ensureSession();
      const a = service.attach(10, 1);
      service.attach(20, 2);
      service.detach(a, 10);
      expect(service.getState().inputOwner).toBeNull();
      expect(service.getState().phase).toBe("running");
      expect(deps.revoke).not.toHaveBeenCalled();
    });

    it("a view eviction or window close drops readers and leaves the session running", async () => {
      const { deps } = makeDeps();
      const service = new GlobalAssistantService(deps);
      await service.ensureSession();
      service.attach(10, 1);
      service.attach(11, 1);
      service.attach(20, 2);
      service.detachWebContents(10);
      service.detachWindow(1);
      expect(service.getState().attachments).toHaveLength(1);
      expect(service.getState().phase).toBe("running");
      expect(deps.revoke).not.toHaveBeenCalled();
      expect(deps.kill).not.toHaveBeenCalled();
    });

    it("notifies listeners of changes and survives a throwing one", () => {
      const service = new GlobalAssistantService(makeDeps().deps);
      const seen = vi.fn();
      service.onChange(() => {
        throw new Error("boom");
      });
      service.onChange(seen);
      vi.spyOn(console, "warn").mockImplementation(() => {});
      service.attach(10, 1);
      expect(seen).toHaveBeenCalled();
    });
  });
});
