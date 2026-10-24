import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingCrash, CrashLogEntry } from "../../../shared/types/ipc/crashRecovery.js";
import type { ProjectState, TerminalSnapshot } from "../../../shared/types/project.js";

const storeData = vi.hoisted(() => new Map<string, unknown>());
const fakeStore = vi.hoisted(() => ({
  get: (key: string) => storeData.get(key),
  set: (key: string, value: unknown) => {
    storeData.set(key, structuredClone(value));
  },
  delete: (key: string) => {
    storeData.delete(key);
  },
}));
vi.mock("../../store.js", () => ({ store: fakeStore }));

const projectStates = vi.hoisted(() => new Map<string, ProjectState | null>());
const projectStoreMock = vi.hoisted(() => ({
  writes: 0,
  enqueueProjectStateUpdate: vi.fn(
    async (id: string, updater: (existing: ProjectState | null) => ProjectState | null) => {
      const next = updater(projectStates.get(id) ?? null);
      if (next !== null) {
        projectStoreMock.writes++;
        projectStates.set(id, next);
      }
    }
  ),
}));
vi.mock("../ProjectStore.js", () => ({ projectStore: projectStoreMock }));

import {
  applyHostEndHold,
  holdTerminalsForHostEnds,
  recordHostEnd,
} from "../hostEndRestoreHold.js";
import { holdTerminalsEndedByHost, readHostEnd } from "../hostEndHoldPolicy.js";

function pending(entry: Partial<CrashLogEntry>): PendingCrash {
  return {
    logPath: "/tmp/crash.json",
    hasBackup: false,
    entry: {
      id: "c1",
      timestamp: 1_000,
      appVersion: "1",
      platform: "darwin",
      osVersion: "x",
      arch: "arm64",
      ...entry,
    },
  } as PendingCrash;
}

function agent(id: string, extra: Partial<TerminalSnapshot> = {}): TerminalSnapshot {
  return {
    id,
    kind: "terminal",
    launchAgentId: "claude",
    agentSessionId: `sess-${id}`,
    location: "grid",
    cwd: "/repo",
    ...extra,
  } as TerminalSnapshot;
}

const WATCHDOG = { cause: "watchdog-deadlock" as const, at: 5_000, missedBeats: 3 };

beforeEach(() => {
  storeData.clear();
  projectStates.clear();
  projectStoreMock.enqueueProjectStateUpdate.mockClear();
  projectStoreMock.writes = 0;
});

describe("readHostEnd", () => {
  it("reads a watchdog kill, dated by the kill and with its missed beats", () => {
    expect(
      readHostEnd(
        pending({
          cause: "watchdog-deadlock",
          crashCause: "external-kill",
          watchdogKilledAt: 5_000,
          watchdogMissedBeats: 3,
        })
      )
    ).toEqual(WATCHDOG);
  });

  it("reads an external kill, dated by the crash record", () => {
    expect(readHostEnd(pending({ crashCause: "external-kill" }))).toEqual({
      cause: "external-kill",
      at: 1_000,
    });
  });

  it("reads a marker left with no other sign, as a kill right after a heartbeat leaves it", () => {
    expect(readHostEnd(pending({ crashCause: "unknown" }))).toEqual({
      cause: "unknown",
      at: 1_000,
    });
  });

  it("dates a watchdog kill by the crash record when the flag carried no time", () => {
    expect(readHostEnd(pending({ cause: "watchdog-deadlock" }))).toEqual({
      cause: "watchdog-deadlock",
      at: 1_000,
    });
  });

  it.each(["uncaught-exception", "native-crash", "power-loss", "suspended-then-lost"])(
    "ignores %s",
    (crashCause) => {
      expect(readHostEnd(pending({ crashCause: crashCause as never }))).toBeUndefined();
    }
  );

  it("ignores a clean start", () => {
    expect(readHostEnd(null)).toBeUndefined();
  });
});

describe("holdTerminalsEndedByHost", () => {
  it("holds running agent panes with their conversation and the observed cause", () => {
    const { terminals, held } = holdTerminalsEndedByHost([agent("a")], WATCHDOG);
    expect(held).toBe(1);
    expect(terminals[0].restoreRecovery).toEqual({
      reason: "host-ended-uncleanly",
      sessionId: "sess-a",
      hostEnd: WATCHDOG,
    });
  });

  it("holds a legacy agent pane identified the way restore identifies it", () => {
    const legacy = {
      id: "old",
      kind: "agent",
      type: "claude",
      location: "dock",
      cwd: "/repo",
    } as unknown as TerminalSnapshot;
    expect(holdTerminalsEndedByHost([legacy], WATCHDOG).terminals[0]).toMatchObject({
      id: "old",
      restoreRecovery: { reason: "host-ended-uncleanly", hostEnd: WATCHDOG },
    });
  });

  it("leaves shells, trashed panes, existing holds, plugin holds and exited agents alone", () => {
    const input = [
      agent("legacyExited", { lastAgentObservation: undefined, agentState: "exited" }),
      { id: "shell", kind: "terminal", location: "grid", cwd: "/repo" } as TerminalSnapshot,
      agent("trashed", { location: "trash" }),
      agent("held", { restoreRecovery: { reason: "resume-deferred" } }),
      agent("plugin", { holdOnRestart: true }),
      agent("exited", { lastAgentObservation: { agentState: "exited" } }),
      agent("bothExited", { lastAgentObservation: { agentState: "exited" }, agentState: "exited" }),
      agent("browser", { kind: "browser" }),
    ];
    const { terminals, held } = holdTerminalsEndedByHost(input, WATCHDOG);
    expect(held).toBe(0);
    expect(terminals).toEqual(input);
  });

  it("holds an agent restarted after it exited, before its new run reported", () => {
    const restarted = agent("a", {
      lastAgentObservation: { agentState: "exited" },
      agentState: "working",
    });
    expect(holdTerminalsEndedByHost([restarted], WATCHDOG).held).toBe(1);
  });

  it.each([
    ["a flag-like id", "--dangerous"],
    ["an empty id", ""],
    ["control characters", "sess\nrm"],
    ["no id", undefined],
  ])("holds a pane with %s, naming no conversation", (_label, agentSessionId) => {
    const { terminals } = holdTerminalsEndedByHost(
      [agent("a", { agentSessionId: agentSessionId as string | undefined })],
      WATCHDOG
    );
    expect(terminals[0].restoreRecovery).toEqual({
      reason: "host-ended-uncleanly",
      hostEnd: WATCHDOG,
    });
  });

  it("names a pane two ends in a row cut short by the first", () => {
    const later = { cause: "external-kill" as const, at: 9_000 };
    const { terminals, held } = holdTerminalsForHostEnds([agent("a")], [WATCHDOG, later]);
    expect(held).toBe(1);
    expect(terminals[0].restoreRecovery?.hostEnd).toEqual(WATCHDOG);
  });
});

describe("applyHostEndHold", () => {
  const watchdogCrash = (id = "c1") =>
    pending({ id, cause: "watchdog-deadlock", watchdogKilledAt: 5_000, watchdogMissedBeats: 3 });
  const seedAgent = (workspaceId: string, paneId: string) =>
    projectStates.set(workspaceId, {
      projectId: workspaceId,
      terminals: [agent(paneId)],
    } as ProjectState);

  it("does nothing until an unclean end is recorded", async () => {
    seedAgent("p1", "a");
    recordHostEnd(pending({ crashCause: "power-loss" }), ["p1"]);
    expect(await applyHostEndHold("p1")).toEqual([]);
    expect(projectStoreMock.enqueueProjectStateUpdate).not.toHaveBeenCalled();
  });

  it("holds nothing when no backup says what was running", async () => {
    recordHostEnd(watchdogCrash(), null);
    seedAgent("p1", "a");
    expect(await applyHostEndHold("p1")).toEqual([]);
    expect(storeData.has("hostEndRestoreHolds")).toBe(false);
  });

  it("holds each live workspace once, even one first opened in a later session", async () => {
    recordHostEnd(watchdogCrash(), ["p1", "p2"]);
    seedAgent("p1", "a");
    seedAgent("p2", "b");

    expect(await applyHostEndHold("p1")).toEqual([WATCHDOG]);
    expect(projectStates.get("p1")?.terminals[0].restoreRecovery).toEqual({
      reason: "host-ended-uncleanly",
      sessionId: "sess-a",
      hostEnd: WATCHDOG,
    });

    // The user resumes the pane; the next hydrate of the same workspace keeps it.
    seedAgent("p1", "a");
    expect(await applyHostEndHold("p1")).toEqual([]);
    expect(projectStates.get("p1")?.terminals[0].restoreRecovery).toBeUndefined();

    // A clean quit and a reboot later: a fresh module reads the same store.
    vi.resetModules();
    const reloaded = await import("../hostEndRestoreHold.js");
    expect(await reloaded.applyHostEndHold("p2")).toEqual([WATCHDOG]);
    expect(projectStates.get("p2")?.terminals[0].restoreRecovery?.reason).toBe(
      "host-ended-uncleanly"
    );
    // Every workspace heard of it, so nothing is left to hold.
    expect(storeData.has("hostEndRestoreHolds")).toBe(false);
  });

  it("leaves a workspace that wasn't live alone", async () => {
    recordHostEnd(watchdogCrash(), ["p1"]);
    seedAgent("asleep", "a");
    expect(await applyHostEndHold("asleep")).toEqual([]);
    expect(projectStates.get("asleep")?.terminals[0].restoreRecovery).toBeUndefined();
  });

  it("records the same crash once, however often a launch reads it", () => {
    recordHostEnd(watchdogCrash(), ["p1"]);
    recordHostEnd(watchdogCrash(), ["p1", "p2"]);
    expect(storeData.get("hostEndRestoreHolds")).toEqual([
      expect.objectContaining({ crashId: "c1", workspaceIds: ["p1"] }),
    ]);
  });

  it("keeps an older end's workspaces when a newer one is recorded, named by the first", async () => {
    recordHostEnd(pending({ id: "c1", crashCause: "external-kill", timestamp: 1_000 }), ["p1"]);
    recordHostEnd(pending({ id: "c2", crashCause: "external-kill", timestamp: 9_000 }), [
      "p1",
      "p2",
    ]);
    // p1 is owed once, to the first end.
    expect(storeData.get("hostEndRestoreHolds")).toEqual([
      expect.objectContaining({ crashId: "c1", workspaceIds: ["p1"] }),
      expect.objectContaining({ crashId: "c2", workspaceIds: ["p2"] }),
    ]);
    seedAgent("p1", "a");

    expect(await applyHostEndHold("p1")).toEqual([{ cause: "external-kill", at: 1_000 }]);
    expect(projectStates.get("p1")?.terminals[0].restoreRecovery?.hostEnd).toEqual({
      cause: "external-kill",
      at: 1_000,
    });
    expect(storeData.get("hostEndRestoreHolds")).toEqual([
      expect.objectContaining({ crashId: "c2", workspaceIds: ["p2"] }),
    ]);
  });

  it("forgets no workspace however many ends pile up behind it", async () => {
    recordHostEnd(pending({ id: "c0", crashCause: "external-kill" }), ["first"]);
    for (let i = 1; i <= 20; i++) {
      recordHostEnd(pending({ id: `c${i}`, crashCause: "external-kill" }), [`w${i}`]);
    }
    seedAgent("first", "a");
    expect(await applyHostEndHold("first")).toHaveLength(1);
    expect(projectStates.get("first")?.terminals[0].restoreRecovery?.reason).toBe(
      "host-ended-uncleanly"
    );
  });

  it("stays due when the save fails, and still hands the ends back for the payload", async () => {
    recordHostEnd(watchdogCrash(), ["p1"]);
    seedAgent("p1", "a");
    projectStoreMock.enqueueProjectStateUpdate.mockRejectedValueOnce(new Error("disk"));
    expect(await applyHostEndHold("p1")).toEqual([WATCHDOG]);
    expect(projectStates.get("p1")?.terminals[0].restoreRecovery).toBeUndefined();
    expect(await applyHostEndHold("p1")).toEqual([WATCHDOG]);
    expect(projectStates.get("p1")?.terminals[0].restoreRecovery?.reason).toBe(
      "host-ended-uncleanly"
    );
  });

  it("runs one application per workspace at a time", async () => {
    recordHostEnd(watchdogCrash(), ["p1"]);
    seedAgent("p1", "a");
    const [first, second] = await Promise.all([applyHostEndHold("p1"), applyHostEndHold("p1")]);
    expect(first).toEqual([WATCHDOG]);
    expect(second).toBe(first);
    expect(projectStoreMock.enqueueProjectStateUpdate).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when no pane needs holding", async () => {
    recordHostEnd(watchdogCrash(), ["p1"]);
    projectStates.set("p1", { projectId: "p1", terminals: [] } as unknown as ProjectState);
    await applyHostEndHold("p1");
    expect(projectStoreMock.enqueueProjectStateUpdate).toHaveBeenCalledTimes(1);
    expect(projectStoreMock.writes).toBe(0);
    expect(storeData.has("hostEndRestoreHolds")).toBe(false);
  });

  it("ignores a hydrate with no workspace", async () => {
    recordHostEnd(watchdogCrash(), ["p1"]);
    expect(await applyHostEndHold(null)).toEqual([]);
    expect(projectStoreMock.enqueueProjectStateUpdate).not.toHaveBeenCalled();
  });
});
