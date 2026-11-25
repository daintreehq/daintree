import { describe, expect, it, vi, type Mock } from "vitest";
import { GlobalAssistantService, type GlobalAssistantDeps } from "../GlobalAssistantService.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type MockedDeps = {
  [K in keyof GlobalAssistantDeps]-?: Mock<NonNullable<GlobalAssistantDeps[K]>>;
};

function makeDeps() {
  let n = 0;
  const calls: string[] = [];
  const deps: MockedDeps = {
    agentId: vi.fn(async () => "claude"),
    canRun: vi.fn(async () => true),
    provision: vi.fn(async () => {
      n += 1;
      calls.push(`provision-s${n}`);
      return { sessionId: `s${n}`, sessionPath: "/g", token: `t${n}`, mcpUrl: null };
    }),
    confirmSwitch: vi.fn((sessionId: string) => {
      calls.push(`confirm-${sessionId}`);
    }),
    laneWork: vi.fn(() => "work-b"),
    keptConversation: vi.fn(() => null),
    takeResume: vi.fn(async () => null),
    releaseResume: vi.fn(async () => {}),
    discardResume: vi.fn(async () => {
      calls.push("discard-resume");
    }),
    spawn: vi.fn(async () => true),
    revoke: vi.fn(async (sessionId: string, { capture }: { capture: boolean }) => {
      calls.push(`revoke-${sessionId}${capture ? "-capture" : ""}`);
    }),
    kill: vi.fn(),
    focusedWindows: vi.fn(() => []),
    keepsConversation: vi.fn(() => false),
    savePinnedAgent: vi.fn(),
    coordinates: vi.fn(() => true),
  };
  return { deps, calls };
}

const earlier = { agentId: "claude", agentSessionId: "conv-a" };

describe("GlobalAssistantService.resumeConversation (#18169)", () => {
  it("stops the run with its conversation captured and kept, then reopens the choice exactly", async () => {
    const { deps, calls } = makeDeps();
    const service = new GlobalAssistantService(deps);
    const running = await service.ensureSession();

    const state = await service.resumeConversation(earlier, {
      generation: running.generation,
      phase: "running",
    });

    expect(state.phase).toBe("running");
    // Captured, so its id is kept for the picker; never forgotten.
    expect(calls).toContain("revoke-s1-capture");
    expect(calls).not.toContain("discard-resume");
    expect(deps.takeResume).toHaveBeenCalledTimes(1);
    expect(deps.provision).toHaveBeenLastCalledWith("claude", {
      switchingTo: { agentSessionId: "conv-a", work: "work-b" },
    });
    expect(deps.spawn.mock.calls.at(-1)![0]).toMatchObject({
      resumeAgentSessionId: "conv-a",
      exactResume: true,
    });
    expect(deps.spawn.mock.calls.at(-1)![0]).not.toHaveProperty("prompt");
    // The old run is gone before the successor provisions.
    expect(calls.indexOf("revoke-s1-capture")).toBeLessThan(calls.indexOf("provision-s2"));
  });

  it("reads the seat's work before the run is stopped", async () => {
    const { deps, calls } = makeDeps();
    deps.laneWork.mockImplementation(() => {
      calls.push("lane-work");
      return "work-b";
    });
    const service = new GlobalAssistantService(deps);
    const running = await service.ensureSession();
    await service.resumeConversation(earlier, {
      generation: running.generation,
      phase: "running",
    });
    expect(calls.indexOf("lane-work")).toBeLessThan(calls.indexOf("revoke-s1-capture"));
  });

  it("writes the switch only once the spawn is confirmed", async () => {
    const { deps, calls } = makeDeps();
    const service = new GlobalAssistantService(deps);
    const running = await service.ensureSession();
    deps.spawn.mockResolvedValueOnce(false);

    await expect(
      service.resumeConversation(earlier, { generation: running.generation, phase: "running" })
    ).rejects.toMatchObject({ code: "INTERNAL" });

    expect(deps.confirmSwitch).not.toHaveBeenCalled();
    expect(calls).toContain("revoke-s2");

    const again = await service.ensureSession();
    expect(again.phase).toBe("running");
    expect(deps.confirmSwitch).not.toHaveBeenCalled();
  });

  it("confirms the switch for the session that spawned it", async () => {
    const { deps } = makeDeps();
    const service = new GlobalAssistantService(deps);
    const running = await service.ensureSession();
    await service.resumeConversation(earlier, {
      generation: running.generation,
      phase: "running",
    });
    expect(deps.confirmSwitch).toHaveBeenCalledTimes(1);
    expect(deps.confirmSwitch).toHaveBeenCalledWith("s2");
  });

  it("starts an absent session on the choice without claiming the conversation it kept", async () => {
    const { deps, calls } = makeDeps();
    const service = new GlobalAssistantService(deps);
    const absent = service.getState();

    const state = await service.resumeConversation(earlier, {
      generation: absent.generation,
      phase: "absent",
    });

    expect(state.phase).toBe("running");
    expect(deps.takeResume).not.toHaveBeenCalled();
    expect(calls.some((call) => call.startsWith("revoke-"))).toBe(false);
    expect(deps.spawn.mock.calls[0]![0].resumeAgentSessionId).toBe("conv-a");
  });

  it("refuses, stopping nothing, once the session changed since the person was asked", async () => {
    const { deps, calls } = makeDeps();
    const service = new GlobalAssistantService(deps);
    const running = await service.ensureSession();

    await expect(
      service.resumeConversation(earlier, {
        generation: running.generation + 1,
        phase: "running",
      })
    ).rejects.toMatchObject({ code: "STALE_GENERATION" });
    await expect(
      service.resumeConversation(earlier, { generation: running.generation, phase: "absent" })
    ).rejects.toMatchObject({ code: "STALE_GENERATION" });

    expect(calls.some((call) => call.startsWith("revoke-"))).toBe(false);
    expect(service.getState().phase).toBe("running");
  });

  it("refuses while a launch is under way", async () => {
    const spawned = deferred<boolean>();
    const { deps } = makeDeps();
    deps.spawn.mockReturnValueOnce(spawned.promise);
    const service = new GlobalAssistantService(deps);
    const launch = service.ensureSession();
    const launching = service.getState();
    expect(launching.phase).toBe("launching");

    await expect(
      service.resumeConversation(earlier, {
        generation: launching.generation,
        phase: "launching",
      })
    ).rejects.toMatchObject({ code: "STALE_GENERATION" });

    spawned.resolve(true);
    await launch;
    expect(deps.provision).toHaveBeenCalledTimes(1);
  });

  it("refuses a conversation on another agent than the one running", async () => {
    const { deps } = makeDeps();
    const service = new GlobalAssistantService(deps);
    const running = await service.ensureSession();
    await expect(
      service.resumeConversation(
        { agentId: "codex", agentSessionId: "thread-1" },
        { generation: running.generation, phase: "running" }
      )
    ).rejects.toMatchObject({ code: "STALE_GENERATION" });
    expect(deps.revoke).not.toHaveBeenCalled();
  });

  it("refuses, stopping nothing, when the other session holds the conversation", async () => {
    const { deps } = makeDeps();
    const service = new GlobalAssistantService(deps);
    const running = await service.ensureSession();
    await expect(
      service.resumeConversation(
        earlier,
        { generation: running.generation, phase: "running" },
        () => false
      )
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(deps.revoke).not.toHaveBeenCalled();
  });

  it("names the conversation a launch reopens until that launch settles", async () => {
    const spawned = deferred<boolean>();
    const { deps } = makeDeps();
    const service = new GlobalAssistantService(deps);
    const running = await service.ensureSession();
    deps.spawn.mockReturnValueOnce(spawned.promise);

    const switched = service.resumeConversation(earlier, {
      generation: running.generation,
      phase: "running",
    });
    expect(service.switchingTo()).toEqual(earlier);
    spawned.resolve(true);
    await switched;
    expect(service.switchingTo()).toBeNull();
  });

  it("lets a Start pressed during the switch join it rather than start another", async () => {
    const spawned = deferred<boolean>();
    const { deps } = makeDeps();
    const service = new GlobalAssistantService(deps);
    const running = await service.ensureSession();
    deps.spawn.mockReturnValueOnce(spawned.promise);

    const switched = service.resumeConversation(earlier, {
      generation: running.generation,
      phase: "running",
    });
    const started = service.ensureSession();
    spawned.resolve(true);
    const [a, b] = await Promise.all([switched, started]);
    expect(a.terminalId).toBe(b.terminalId);
    expect(deps.provision).toHaveBeenCalledTimes(2);
  });
});

describe("GlobalAssistantService.resumableAgentId (#18169)", () => {
  it("answers the running agent", async () => {
    const { deps } = makeDeps();
    const service = new GlobalAssistantService(deps);
    await service.ensureSession();
    deps.agentId.mockResolvedValue("codex");
    await expect(service.resumableAgentId()).resolves.toBe("claude");
  });

  it("answers the agent a start would run while nothing runs", async () => {
    const { deps } = makeDeps();
    deps.agentId.mockResolvedValue("codex");
    await expect(new GlobalAssistantService(deps).resumableAgentId()).resolves.toBe("codex");

    const pinned = makeDeps();
    await expect(
      new GlobalAssistantService(pinned.deps, { pinnedAgentId: "codex" }).resumableAgentId()
    ).resolves.toBe("codex");
  });

  it("answers the kept conversation's agent when it differs from the chosen one, as a start does", async () => {
    const { deps } = makeDeps();
    deps.keptConversation.mockReturnValue({ agentId: "claude", agentSessionId: "kept" });
    const service = new GlobalAssistantService(deps, { pinnedAgentId: "codex" });
    await expect(service.resumableAgentId()).resolves.toBe("claude");
  });
});
