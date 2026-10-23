import { describe, expect, it, vi } from "vitest";
import { resolveLiveAssistant, type LiveAssistantSources } from "../liveAssistantSubject.js";

type Lane = { sessionId: string; terminalId: string } | null;

function sources(overrides: Partial<LiveAssistantSources> = {}) {
  const lane: { current: Lane } = { current: { sessionId: "s1", terminalId: "t1" } };
  const generation = { current: 3 as number | null };
  const ended = new Set<(event: { projectId: string; slot: number; sessionId: string }) => void>();
  const global = {
    state: { phase: "running" as const, generation: 7, terminalId: "g1" as string | null },
    owner: null as number | null,
    listeners: new Set<() => void>(),
  };
  const src: LiveAssistantSources = {
    hostId: "local",
    ptyClient: {
      getLiveGeneration: vi.fn(() => generation.current),
      getTerminalAsync: vi.fn(async () => ({ spawnedAt: 500, isExited: false })),
    } as unknown as LiveAssistantSources["ptyClient"],
    getRunningLaneSession: (projectId, slot) =>
      projectId === "p1" && slot === 0 ? lane.current : null,
    onSessionEnded: (listener) => {
      ended.add(listener);
      return () => ended.delete(listener);
    },
    global: {
      getState: () => global.state,
      onChange: (listener) => {
        global.listeners.add(listener);
        return () => global.listeners.delete(listener);
      },
      inputOwnerWebContentsId: () => global.owner,
    },
    ...overrides,
  };
  return { src, lane, generation, ended, global };
}

const laneSubject = {
  hostId: "local",
  scope: { kind: "project" as const, projectId: "p1" },
  terminalId: "t1",
  incarnation: 3,
  lane: 0,
};
const globalSubject = {
  hostId: "local",
  scope: { kind: "global" as const },
  terminalId: "g1",
  incarnation: 3,
};

describe("resolveLiveAssistant", () => {
  it("binds a project lane's run to the session and generation main holds", async () => {
    const { src, lane } = sources();
    const binding = await resolveLiveAssistant(laneSubject, src);
    expect(binding.spawnedAt).toBe(500);
    expect(binding.launchGeneration).toBe(3);
    expect(binding.isBound()).toBe(true);
    // A successor session in the same lane on the same terminal id is not this one.
    lane.current = { sessionId: "s2", terminalId: "t1" };
    expect(binding.isBound()).toBe(false);
  });

  it.each([
    ["no lane", { ...laneSubject, lane: undefined }, "VALIDATION"],
    ["a lane on the global session", { ...globalSubject, lane: 0 }, "VALIDATION"],
    ["another host", { ...laneSubject, hostId: "remote-1" }, "UNSUPPORTED"],
    ["another lane", { ...laneSubject, lane: 1 }, "NOT_FOUND"],
    ["another terminal", { ...laneSubject, terminalId: "t9" }, "NOT_FOUND"],
    ["an older generation", { ...laneSubject, incarnation: 2 }, "STALE_GENERATION"],
    ["a malformed subject", { terminalId: "t1" }, "VALIDATION"],
  ])("refuses %s", async (_name, subject, code) => {
    const { src } = sources();
    await expect(resolveLiveAssistant(subject, src)).rejects.toMatchObject({ code });
    expect(src.ptyClient.getTerminalAsync).not.toHaveBeenCalled();
  });

  it("refuses a run replaced or exited while the host was asked", async () => {
    const replaced = sources();
    vi.mocked(replaced.src.ptyClient.getTerminalAsync).mockImplementationOnce(async () => {
      replaced.lane.current = { sessionId: "s2", terminalId: "t1" };
      return { spawnedAt: 500 } as never;
    });
    await expect(resolveLiveAssistant(laneSubject, replaced.src)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const respawned = sources();
    vi.mocked(respawned.src.ptyClient.getTerminalAsync).mockImplementationOnce(async () => {
      respawned.generation.current = 4;
      return { spawnedAt: 600 } as never;
    });
    await expect(resolveLiveAssistant(laneSubject, respawned.src)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const exited = sources();
    vi.mocked(exited.src.ptyClient.getTerminalAsync).mockResolvedValueOnce({
      spawnedAt: 500,
      isExited: true,
    } as never);
    await expect(resolveLiveAssistant(laneSubject, exited.src)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("hears only its own session end, and lets go of the listener", async () => {
    const { src, ended } = sources();
    const binding = await resolveLiveAssistant(laneSubject, src);
    const end = vi.fn();
    const release = binding.onEnded(end);
    for (const listener of ended) listener({ projectId: "p1", slot: 0, sessionId: "other" });
    expect(end).not.toHaveBeenCalled();
    for (const listener of ended) listener({ projectId: "p1", slot: 0, sessionId: "s1" });
    expect(end).toHaveBeenCalledTimes(1);
    release();
    expect(ended.size).toBe(0);
  });

  it("binds the global session by its run, and only its input owner may type", async () => {
    const { src, global } = sources();
    const binding = await resolveLiveAssistant(globalSubject, src);
    expect(binding.mayType(4)).toBe(false);
    global.owner = 4;
    expect(binding.mayType(4)).toBe(true);
    expect(binding.mayType(5)).toBe(false);

    const end = vi.fn();
    binding.onEnded(end);
    // An attachment change is not an end; a new run is, even under the same terminal id.
    for (const listener of global.listeners) listener();
    expect(end).not.toHaveBeenCalled();
    global.state = { ...global.state, generation: 8 };
    for (const listener of global.listeners) listener();
    expect(end).toHaveBeenCalledTimes(1);
    expect(binding.isBound()).toBe(false);
  });

  it("refuses the global subject when no global session runs", async () => {
    await expect(
      resolveLiveAssistant(globalSubject, sources({ global: null }).src)
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
