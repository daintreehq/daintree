// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanopyCard, CanopySnapshot } from "@shared/types/ipc/canopy";
import type { FleetRunRow, FleetSnapshot } from "@shared/types/ipc/fleet";

const invoke = vi.hoisted(() => vi.fn());
const onEvent = vi.hoisted(() => vi.fn(() => () => {}));
const ownCalls = vi.hoisted(() => ({
  archive: vi.fn(() => Promise.resolve()),
  setShown: vi.fn(() => Promise.resolve()),
  setScope: vi.fn(() => Promise.resolve()),
  searchScreens: vi.fn((_targets: unknown[]) => Promise.resolve(["t1"])),
  watchTerminal: vi.fn(() => Promise.resolve({ watchId: 1, snapshot: null })),
  unwatchTerminal: vi.fn(() => Promise.resolve()),
  terminalInput: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/clients/canopyHostClient", () => ({
  canopyHostClient: { invoke, onEvent, release: vi.fn(() => Promise.resolve()) },
}));

import {
  allHostsKey,
  createAllHostsRoute,
  hostsWithCanopyOff,
  mergeHostReadings,
  parseAllHostsKey,
  type HostReading,
} from "../canopyAllHosts";

const SEARCH_LATENCY_MS = 5;

function run(runId: string, workspaceId = "ws"): FleetRunRow {
  return { runId, workspaceId, spawnedAt: 1, cwd: "/" } as FleetRunRow;
}

function fleet(runs: FleetRunRow[], over: Partial<FleetSnapshot> = {}): FleetSnapshot {
  return { runs, changedAt: 10, degraded: false, lastSuccessfulAt: 10, ...over };
}

function canopy(over: Partial<CanopySnapshot> = {}): CanopySnapshot {
  return {
    mode: "on",
    activated: true,
    tier: "free",
    dispositions: [],
    seen: [],
    reads: [],
    scope: null,
    active: true,
    busy: false,
    refreshedAt: 5,
    cards: [],
    glances: [],
    lastError: null,
    failedRuns: [],
    ...over,
  };
}

function cardFor(runId: string): CanopyCard {
  return {
    runId,
    spawnedAt: 1,
    revision: 1,
    category: "approval",
    confidence: 0.9,
    attentionProbability: 0.9,
    attentionScore: 95,
    priority: 95,
    stage: "described",
    wordsFromEarlierRead: false,
    priorityFromEarlierRead: false,
    wordsCategory: "approval",
    describing: false,
    task: null,
    headline: "Wants to run the migration",
    summary: null,
    question: "Do you want to proceed?",
    options: ["Yes", "No"],
    secretPrompt: false,
    risk: "none",
    riskReason: null,
    action: null,
    progress: null,
    steps: null,
    tests: "unknown",
    changes: "unknown",
    handledAt: null,
    activity: null,
    glance: { recap: null, said: null, doing: null, action: null },
    statusLine: null,
    contextLeft: null,
    stalledSince: null,
    observedAt: 1,
  };
}

describe("run keys", () => {
  it("round-trips ids whatever the host id holds", () => {
    for (const host of ["local", "a.b.c", "10.host", "x y", "*", ""]) {
      const key = allHostsKey(host, "term.1");
      expect(parseAllHostsKey(key)).toEqual({ hostId: host, id: "term.1" });
    }
  });

  it("keeps the same run id on two hosts apart", () => {
    expect(allHostsKey("a", "t1")).not.toBe(allHostsKey("b", "t1"));
  });

  it("refuses a bare id", () => {
    expect(parseAllHostsKey("t1")).toBeNull();
  });
});

describe("mergeHostReadings", () => {
  it("namespaces runs and workspaces so identical ids on two hosts both survive", () => {
    const readings: HostReading[] = [
      { hostId: "a", canopy: canopy(), fleet: fleet([run("t1")]), error: null },
      { hostId: "b", canopy: canopy(), fleet: fleet([run("t1")]), error: null },
    ];
    const { fleet: merged } = mergeHostReadings(readings);
    expect(merged!.runs.map((r) => r.runId)).toEqual([
      allHostsKey("a", "t1"),
      allHostsKey("b", "t1"),
    ]);
    expect(merged!.runs.map((r) => r.workspaceId)).toEqual([
      allHostsKey("a", "ws"),
      allHostsKey("b", "ws"),
    ]);
  });

  it("keys cards by host and drops the screen readings of a host that is off", () => {
    const card = cardFor("t1");
    const { canopy: merged } = mergeHostReadings([
      { hostId: "a", canopy: canopy({ cards: [card] }), fleet: fleet([run("t1")]), error: null },
      {
        hostId: "b",
        canopy: canopy({ activated: false, cards: [{ ...card }] }),
        fleet: fleet([run("t1")]),
        error: null,
      },
    ]);
    expect(merged!.cards.map((c) => c.runId)).toEqual([allHostsKey("a", "t1")]);
    expect(merged!.activated).toBe(true);
    expect(merged!.mode).toBe("on");
  });

  it("marks only the runs of a host whose reader failed", () => {
    const { canopy: merged } = mergeHostReadings([
      {
        hostId: "a",
        canopy: canopy({ lastError: "down" }),
        fleet: fleet([run("t1")]),
        error: null,
      },
      { hostId: "b", canopy: canopy(), fleet: fleet([run("t1")]), error: null },
    ]);
    expect(merged!.lastError).toBeNull();
    expect(merged!.failedRuns).toEqual([allHostsKey("a", "t1")]);
  });

  it("moves its scan marker when any host scans, whatever that host's clock", () => {
    const at = (a: number, b: number) =>
      mergeHostReadings([
        { hostId: "a", canopy: canopy({ refreshedAt: a }), fleet: null, error: null },
        { hostId: "b", canopy: canopy({ refreshedAt: b }), fleet: null, error: null },
      ]).canopy!.refreshedAt;
    expect(at(100, 50)).not.toBe(at(100, 60));
  });

  it("holds a host that has said nothing out of the list", () => {
    const { canopy: merged, fleet: mergedFleet } = mergeHostReadings([
      { hostId: "a", canopy: null, fleet: null, error: new Error("down") },
      { hostId: "b", canopy: canopy(), fleet: fleet([run("t1")]), error: null },
    ]);
    expect(mergedFleet!.runs).toHaveLength(1);
    expect(merged!.cards).toEqual([]);
  });

  it("has no snapshots until some host has answered", () => {
    expect(mergeHostReadings([{ hostId: "a", canopy: null, fleet: null, error: null }])).toEqual({
      canopy: null,
      fleet: null,
    });
  });

  it("names the hosts that are off", () => {
    expect(
      hostsWithCanopyOff([
        { hostId: "a", canopy: canopy({ activated: false }), fleet: null, error: null },
        { hostId: "b", canopy: canopy(), fleet: null, error: null },
        { hostId: "c", canopy: null, fleet: null, error: null },
      ])
    ).toEqual(["a"]);
  });
});

describe("createAllHostsRoute", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    Object.values(ownCalls).forEach((fn) => fn.mockClear());
    Object.defineProperty(window, "electron", {
      value: { canopy: ownCalls },
      configurable: true,
      writable: true,
    });
  });

  it("sends a write to the owning host with the bare id and the incarnation", async () => {
    const { api } = createAllHostsRoute("own", ["own", "remote"]);
    await api.archive(allHostsKey("remote", "t1"), { spawnedAt: 7 });
    expect(invoke).toHaveBeenCalledWith("remote", "canopy:archive", "t1", { spawnedAt: 7 });
    expect(ownCalls.archive).not.toHaveBeenCalled();
    await api.archive(allHostsKey("own", "t1"), { spawnedAt: 8 });
    expect(ownCalls.archive).toHaveBeenCalledWith("t1", { spawnedAt: 8 });
  });

  it("refuses a run that isn't on a host shown", async () => {
    const { api } = createAllHostsRoute("own", ["own"]);
    await expect(api.archive(allHostsKey("gone", "t1"), { spawnedAt: 1 })).rejects.toThrow();
    await expect(api.archive("t1", { spawnedAt: 1 })).rejects.toThrow();
  });

  it("never turns Canopy on", async () => {
    const { api } = createAllHostsRoute("own", ["own", "remote"]);
    await expect(api.setMode("on")).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("tells every host which of its rows are shown, none included", async () => {
    const { api } = createAllHostsRoute("own", ["own", "remote"]);
    await api.setShown([allHostsKey("own", "t1")]);
    expect(ownCalls.setShown).toHaveBeenCalledWith(["t1"]);
    expect(invoke).toHaveBeenCalledWith("remote", "canopy:set-shown", []);
  });

  it("asks each host about its own runs and keys the answers", async () => {
    invoke.mockImplementation((_host, channel) =>
      Promise.resolve(channel === "canopy:search-screens" ? ["t1"] : undefined)
    );
    const { api } = createAllHostsRoute("own", ["own", "remote"]);
    const hits = await api.searchScreens([
      { runId: allHostsKey("own", "t1"), spawnedAt: 1, terms: ["x"] },
      { runId: allHostsKey("remote", "t1"), spawnedAt: 2, terms: ["x"] },
    ]);
    expect(ownCalls.searchScreens).toHaveBeenCalledWith([
      { runId: "t1", spawnedAt: 1, terms: ["x"] },
    ]);
    expect(hits.sort()).toEqual([allHostsKey("own", "t1"), allHostsKey("remote", "t1")].sort());
  });

  it("keeps the other hosts' answers when one can't search", async () => {
    invoke.mockRejectedValue(new Error("offline"));
    const { api } = createAllHostsRoute("own", ["own", "remote"]);
    const hits = await api.searchScreens([
      { runId: allHostsKey("own", "t1"), spawnedAt: 1, terms: ["x"] },
      { runId: allHostsKey("remote", "t1"), spawnedAt: 2, terms: ["x"] },
    ]);
    expect(hits).toEqual([allHostsKey("own", "t1")]);
  });

  it("runs no more than three host searches at once", async () => {
    let live = 0;
    let peak = 0;
    invoke.mockImplementation(async () => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, SEARCH_LATENCY_MS));
      live -= 1;
      return [];
    });
    const hosts = ["h1", "h2", "h3", "h4", "h5", "h6"];
    const { api } = createAllHostsRoute("own", hosts);
    await api.searchScreens(
      hosts.map((host) => ({ runId: allHostsKey(host, "t1"), spawnedAt: 1, terms: ["x"] }))
    );
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("watches one terminal at a time, on the host it is on, and renumbers the stream", async () => {
    invoke.mockResolvedValue({ watchId: 1, snapshot: null });
    const { terminalApi } = createAllHostsRoute("own", ["own", "remote"]);
    const own = await terminalApi.watchTerminal(allHostsKey("own", "t1"), { spawnedAt: 1 });
    const remote = await terminalApi.watchTerminal(allHostsKey("remote", "t1"), { spawnedAt: 1 });
    // The host that was being watched is released when the other is opened.
    expect(ownCalls.unwatchTerminal).toHaveBeenCalledTimes(1);
    expect(own.watchId).not.toBe(remote.watchId);
    await terminalApi.terminalInput(remote.watchId!, "x");
    expect(invoke).toHaveBeenCalledWith("remote", "canopy:terminal-input", 1, "x");
    // A stale id of the old stream reaches nobody.
    await terminalApi.terminalInput(own.watchId!, "y");
    expect(ownCalls.terminalInput).not.toHaveBeenCalled();
  });

  it("releases every watched host on unwatch", async () => {
    invoke.mockResolvedValue({ watchId: 3, snapshot: null });
    const { terminalApi } = createAllHostsRoute("own", ["own", "remote"]);
    await terminalApi.watchTerminal(allHostsKey("remote", "t1"), { spawnedAt: 1 });
    await terminalApi.unwatchTerminal();
    expect(invoke).toHaveBeenCalledWith("remote", "canopy:unwatch-terminal");
  });
});
