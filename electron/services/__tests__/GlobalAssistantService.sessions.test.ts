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
  [K in Exclude<keyof GlobalAssistantDeps, "agentUsable">]-?: Mock<
    NonNullable<GlobalAssistantDeps[K]>
  >;
} & { agentUsable?: Mock<NonNullable<GlobalAssistantDeps["agentUsable"]>> };

/** One session's deps, its calls tagged with the session's name. */
function makeDeps(name: string, overrides: Partial<MockedDeps> = {}) {
  let n = 0;
  const calls: string[] = [];
  const deps: MockedDeps = {
    agentId: vi.fn(async () => "claude"),
    provision: vi.fn(async (agentId: string) => {
      n += 1;
      calls.push(`provision-${agentId}`);
      return { sessionId: `${name}-s${n}`, sessionPath: "/g", token: `t${n}`, mcpUrl: null };
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
    kill: vi.fn(() => {}),
    focusedWindows: vi.fn(() => []),
    keepsConversation: vi.fn(() => false),
    savePinnedAgent: vi.fn(() => {}),
    ...overrides,
  };
  return { deps, calls };
}

/** The first session follows the default agent; the second runs only as chosen. */
function twoSessions() {
  const first = makeDeps("first");
  const second = makeDeps("second", { agentId: vi.fn(async () => null) });
  return {
    first,
    second,
    a: new GlobalAssistantService(first.deps, { slot: 0 }),
    b: new GlobalAssistantService(second.deps, { slot: 1, followsDefault: false }),
  };
}

describe("GlobalAssistantService — two sessions side by side (#18142)", () => {
  it("keeps each session's readers and input owner to itself", async () => {
    const { a, b } = twoSessions();
    await Promise.all([a.ensureSession(), b.startOn("codex")]);
    const inA = a.attach(10, 1);
    const inB = b.attach(10, 1);
    const otherB = b.attach(20, 2);
    const epochA = a.getState().inputEpoch;

    b.claimInput(otherB, 20);

    expect(a.getState()).toMatchObject({ inputOwner: inA, inputEpoch: epochA });
    expect(b.getState().inputOwner).toBe(otherB);
    // An attachment, and the epoch it holds, are one session's alone.
    expect(a.canWrite(inB, b.getState().inputEpoch)).toBe(false);
    expect(b.canWrite(inA, epochA)).toBe(false);
    expect(() => a.claimInput(inB, 10)).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));

    b.detachWebContents(20);
    expect(a.getState().attachments.map((x) => x.attachmentId)).toEqual([inA]);
    expect(b.getState().inputOwner).toBe(inB);
  });

  it("cancels one session's launch while the other's goes on to run", async () => {
    const { a, b, first, second } = twoSessions();
    const spawnA = deferred<boolean>();
    const spawnB = deferred<boolean>();
    first.deps.spawn.mockImplementationOnce(() => spawnA.promise);
    second.deps.spawn.mockImplementationOnce(() => spawnB.promise);
    const launchA = a.ensureSession();
    const launchB = b.startOn("codex");
    await vi.waitFor(() => expect(second.deps.spawn).toHaveBeenCalled());

    const cancelled = b.cancelLaunch();
    spawnB.resolve(true);
    spawnA.resolve(true);

    await expect(launchB).rejects.toMatchObject({ code: "CANCELLED" });
    await cancelled;
    await expect(launchA).resolves.toMatchObject({ phase: "running", agentId: "claude" });
    expect(b.getState().phase).toBe("absent");
    expect(first.deps.revoke).not.toHaveBeenCalled();
    // A cancel keeps what the launch was picking up, and the agent it was started on.
    expect(second.deps.discardResume).not.toHaveBeenCalled();
    expect(b.getState()).toMatchObject({ pinnedAgentId: "codex", occupied: true });
  });

  it("stops one session and forgets only its conversation", async () => {
    const { a, b, first, second } = twoSessions();
    await Promise.all([a.ensureSession(), b.startOn("codex")]);
    const runB = b.getRunningSession();

    await a.discard();

    expect(a.getState().phase).toBe("absent");
    expect(first.deps.discardResume).toHaveBeenCalledTimes(1);
    expect(second.deps.discardResume).not.toHaveBeenCalled();
    expect(second.deps.revoke).not.toHaveBeenCalled();
    expect(b.getRunningSession()).toEqual(runB);
  });

  it("restarts and quits each session on its own deps", async () => {
    const { a, b, first, second } = twoSessions();
    await Promise.all([a.ensureSession(), b.startOn("codex")]);

    await b.restart();
    expect(second.deps.discardResume).toHaveBeenCalledTimes(1);
    expect(first.deps.discardResume).not.toHaveBeenCalled();
    expect(a.getRunningSession()?.sessionId).toBe("first-s1");

    await Promise.all([a.shutdown(), b.shutdown()]);
    expect(first.deps.revoke).toHaveBeenCalledWith("first-s1", { capture: true });
    expect(second.deps.revoke).toHaveBeenCalledWith("second-s2", { capture: true });
    // Quitting keeps every conversation, and the agent a session was started on.
    expect(second.deps.savePinnedAgent).not.toHaveBeenCalledWith(null);
  });

  it("ends only its own run when one session's terminal exits", async () => {
    const { a, b } = twoSessions();
    await Promise.all([a.ensureSession(), b.startOn("codex")]);
    const terminalA = a.getState().terminalId!;

    b.handleTerminalExit(terminalA);
    a.handleTerminalExit(terminalA);
    await vi.waitFor(() => expect(a.getState().phase).toBe("absent"));
    expect(b.getState().phase).toBe("running");
  });
});

describe("GlobalAssistantService — a session started on a chosen agent (#18142)", () => {
  it("starts fresh on the agent chosen and keeps it", async () => {
    const { b, second } = twoSessions();
    const state = await b.startOn("antigravity");
    expect(state).toMatchObject({ phase: "running", agentId: "antigravity", slot: 1 });
    expect(second.deps.provision).toHaveBeenCalledWith("antigravity");
    expect(second.deps.agentId).not.toHaveBeenCalled();
    expect(second.deps.takeResume).not.toHaveBeenCalled();
    expect(second.deps.savePinnedAgent).toHaveBeenCalledWith("antigravity");
    expect(b.getState().pinnedAgentId).toBe("antigravity");
  });

  it("follows no change of the default agent, and clears onto the same agent", async () => {
    const { b, second } = twoSessions();
    await b.startOn("codex");
    await b.onAgentChanged("claude");
    expect(b.getState().phase).toBe("running");
    expect(second.deps.revoke).not.toHaveBeenCalled();

    await b.restart();
    expect(second.deps.provision).toHaveBeenLastCalledWith("codex");
    expect(b.getState()).toMatchObject({ phase: "running", agentId: "codex" });
  });

  it("refuses to start over a session that runs or keeps a conversation", async () => {
    const running = twoSessions();
    await running.a.ensureSession();
    await expect(running.a.startOn("codex")).rejects.toMatchObject({ code: "VALIDATION" });
    expect(running.first.deps.savePinnedAgent).not.toHaveBeenCalled();

    const kept = twoSessions();
    kept.first.deps.keepsConversation.mockReturnValue(true);
    expect(kept.a.isOccupied()).toBe(true);
    await expect(kept.a.startOn("codex")).rejects.toMatchObject({ code: "VALIDATION" });
    expect(kept.first.deps.provision).not.toHaveBeenCalled();
  });

  it("counts as free only with nothing running, chosen or kept", () => {
    const { a, b } = twoSessions();
    expect(a.getState()).toMatchObject({ occupied: false, pinnedAgentId: null, agentId: null });
    const pinned = new GlobalAssistantService(makeDeps("x").deps, {
      slot: 1,
      pinnedAgentId: "codex",
    });
    expect(pinned.getState()).toMatchObject({ occupied: true, agentId: "codex", phase: "absent" });
    expect(b.isOccupied()).toBe(false);
  });

  it("brings its conversation back on the agent chosen in an earlier run of the app", async () => {
    const { deps } = makeDeps("second", { agentId: vi.fn(async () => null) });
    deps.takeResume.mockResolvedValue({ agentId: "codex", agentSessionId: "conv", claimId: "c1" });
    const service = new GlobalAssistantService(deps, { slot: 1, pinnedAgentId: "codex" });
    await service.ensureSession();
    expect(deps.spawn.mock.calls[0]![0]).toMatchObject({
      agentId: "codex",
      resumeAgentSessionId: "conv",
    });
  });

  it("frees the session once its stop has finished, and not before", async () => {
    const forgotten = deferred<void>();
    const { b, second } = twoSessions();
    second.deps.discardResume.mockImplementation(() => forgotten.promise);
    await b.startOn("codex");

    const stopped = b.discard();
    await vi.waitFor(() => expect(second.deps.discardResume).toHaveBeenCalled());
    expect(b.getState()).toMatchObject({ phase: "absent", occupied: true });
    expect(second.deps.savePinnedAgent).not.toHaveBeenCalledWith(null);

    forgotten.resolve();
    await stopped;
    expect(second.deps.savePinnedAgent).toHaveBeenLastCalledWith(null);
    expect(b.getState()).toMatchObject({ occupied: false, pinnedAgentId: null });
  });

  it("keeps its agent when it is started again while its stop winds down", async () => {
    const forgotten = deferred<void>();
    const { b, second } = twoSessions();
    second.deps.discardResume.mockImplementation(() => forgotten.promise);
    await b.startOn("codex");

    const stopped = b.discard();
    const again = b.ensureSession();
    forgotten.resolve();
    await stopped;
    await expect(again).resolves.toMatchObject({ phase: "running", agentId: "codex" });
    expect(b.getState().pinnedAgentId).toBe("codex");
  });

  it("stays taken while a clear winds down, so nothing else lands in it", async () => {
    const forgotten = deferred<void>();
    const { a, first } = twoSessions();
    first.deps.discardResume.mockImplementation(() => forgotten.promise);
    await a.ensureSession();

    const cleared = a.restart();
    await vi.waitFor(() => expect(first.deps.discardResume).toHaveBeenCalled());
    expect(a.getState().phase).toBe("absent");
    expect(a.isOccupied()).toBe(true);
    await expect(a.startOn("codex")).rejects.toMatchObject({ code: "VALIDATION" });

    forgotten.resolve();
    await expect(cleared).resolves.toMatchObject({ phase: "running", agentId: "claude" });
  });

  it("keeps the agent a second session first runs on, so a clear still knows it", async () => {
    const { deps } = makeDeps("second", { agentId: vi.fn(async () => "codex") });
    deps.takeResume.mockResolvedValue({ agentId: "codex", agentSessionId: "conv", claimId: "c1" });
    const service = new GlobalAssistantService(deps, { slot: 1, followsDefault: false });
    await service.ensureSession();
    expect(deps.savePinnedAgent).toHaveBeenCalledWith("codex");

    // The clear forgets the conversation its agent was read from.
    deps.agentId.mockResolvedValue(null);
    await service.restart();
    expect(service.getState()).toMatchObject({ phase: "running", agentId: "codex" });
  });

  it("lets a conversation kept on another agent win over the choice", async () => {
    const usable = vi.fn(async () => true);
    const { deps } = makeDeps("first", { agentUsable: usable });
    deps.takeResume.mockResolvedValue({ agentId: "claude", agentSessionId: "conv", claimId: "c1" });
    const service = new GlobalAssistantService(deps, { slot: 0, pinnedAgentId: "codex" });
    await service.ensureSession();
    // The agent checked is the one that runs.
    expect(usable).toHaveBeenCalledWith("claude");
    expect(deps.spawn.mock.calls[0]![0]).toMatchObject({
      agentId: "claude",
      resumeAgentSessionId: "conv",
    });
    expect(deps.savePinnedAgent).toHaveBeenCalledWith("claude");
  });

  it("refuses a chosen agent that can no longer run, keeping its conversation", async () => {
    const { deps } = makeDeps("second", { agentUsable: vi.fn(async () => false) });
    deps.takeResume.mockResolvedValue({
      agentId: "antigravity",
      agentSessionId: "conv",
      claimId: "c1",
    });
    const service = new GlobalAssistantService(deps, { slot: 1, pinnedAgentId: "antigravity" });
    await expect(service.ensureSession()).rejects.toMatchObject({
      code: "UNSUPPORTED",
      userMessage: expect.stringContaining("conversation is kept"),
    });
    expect(deps.agentUsable).toHaveBeenCalledWith("antigravity");
    // Its claim is handed back, so the conversation stays to resume.
    expect(deps.releaseResume).toHaveBeenCalledWith("c1");
    expect(deps.provision).not.toHaveBeenCalled();
    expect(service.getState()).toMatchObject({ pinnedAgentId: "antigravity", occupied: true });

    // The default's own pick is never second-guessed here.
    const first = makeDeps("first", { agentUsable: vi.fn(async () => false) });
    await new GlobalAssistantService(first.deps, { slot: 0 }).ensureSession();
    expect(first.deps.agentUsable).not.toHaveBeenCalled();
  });

  it("frees a stopped session even when quitting begins while it winds down", async () => {
    const forgotten = deferred<void>();
    const { b, second } = twoSessions();
    second.deps.discardResume.mockImplementation(() => forgotten.promise);
    await b.startOn("codex");

    const stopped = b.discard();
    await vi.waitFor(() => expect(second.deps.discardResume).toHaveBeenCalled());
    const quit = b.shutdown();
    forgotten.resolve();
    await Promise.all([stopped, quit]);
    expect(second.deps.savePinnedAgent).toHaveBeenLastCalledWith(null);
  });

  it("keeps an agent it inferred or adopted only once the session runs", async () => {
    const { deps } = makeDeps("second", { agentId: vi.fn(async () => "codex") });
    deps.takeResume.mockResolvedValue({ agentId: "codex", agentSessionId: "conv", claimId: "c1" });
    deps.provision.mockResolvedValueOnce(null);
    const service = new GlobalAssistantService(deps, { slot: 1, followsDefault: false });
    await expect(service.ensureSession()).rejects.toMatchObject({ code: "INTERNAL" });
    expect(deps.savePinnedAgent).not.toHaveBeenCalled();
    expect(service.getState().pinnedAgentId).toBeNull();

    await service.ensureSession();
    expect(deps.savePinnedAgent).toHaveBeenCalledWith("codex");
  });

  it("frees a stopped session whose start queued behind the stop never came to run", async () => {
    const forgotten = deferred<void>();
    const { b, second } = twoSessions();
    second.deps.discardResume.mockImplementation(() => forgotten.promise);
    await b.startOn("codex");

    const stopped = b.discard();
    second.deps.spawn.mockResolvedValueOnce(false);
    const queued = b.ensureSession();
    forgotten.resolve();
    await stopped;
    // Still starting when the stop finished: the agent waits on it.
    expect(second.deps.savePinnedAgent).not.toHaveBeenCalledWith(null);
    await expect(queued).rejects.toMatchObject({ code: "INTERNAL" });
    await vi.waitFor(() => expect(second.deps.savePinnedAgent).toHaveBeenLastCalledWith(null));
    expect(b.getState()).toMatchObject({ occupied: false, pinnedAgentId: null });
  });
});
