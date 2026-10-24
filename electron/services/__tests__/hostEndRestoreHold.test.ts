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
  enqueueProjectStateUpdate: vi.fn(
    async (id: string, updater: (existing: ProjectState | null) => ProjectState | null) => {
      const next = updater(projectStates.get(id) ?? null);
      if (next !== null) projectStates.set(id, next);
    }
  ),
}));
vi.mock("../ProjectStore.js", () => ({ projectStore: projectStoreMock }));

import { applyHostEndHold, recordHostEnd } from "../hostEndRestoreHold.js";
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

  it.each(["uncaught-exception", "native-crash", "power-loss", "suspended-then-lost", "unknown"])(
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
    expect(holdTerminalsEndedByHost([legacy], WATCHDOG).held).toBe(1);
  });

  it("leaves shells, trashed panes, existing holds, plugin holds and exited agents alone", () => {
    const input = [
      agent("legacyExited", { lastAgentObservation: undefined, agentState: "exited" }),
      { id: "shell", kind: "terminal", location: "grid", cwd: "/repo" } as TerminalSnapshot,
      agent("trashed", { location: "trash" }),
      agent("held", { restoreRecovery: { reason: "resume-deferred" } }),
      agent("plugin", { holdOnRestart: true }),
      agent("exited", { lastAgentObservation: { agentState: "exited" } }),
      agent("browser", { kind: "browser" }),
    ];
    const { terminals, held } = holdTerminalsEndedByHost(input, WATCHDOG);
    expect(held).toBe(0);
    expect(terminals).toEqual(input);
  });

  it("holds a pane without a usable session id, with no conversation to name", () => {
    const { terminals } = holdTerminalsEndedByHost(
      [agent("a", { agentSessionId: "--dangerous" })],
      WATCHDOG
    );
    expect(terminals[0].restoreRecovery).toEqual({
      reason: "host-ended-uncleanly",
      hostEnd: WATCHDOG,
    });
  });
});

describe("applyHostEndHold", () => {
  const watchdogCrash = (id = "c1") =>
    pending({ id, cause: "watchdog-deadlock", watchdogKilledAt: 5_000, watchdogMissedBeats: 3 });

  it("does nothing until an unclean end is recorded", async () => {
    projectStates.set("p1", { projectId: "p1", terminals: [agent("a")] } as ProjectState);
    recordHostEnd(pending({ crashCause: "power-loss" }), ["p1"]);
    expect(await applyHostEndHold("p1")).toBe(0);
    expect(projectStoreMock.enqueueProjectStateUpdate).not.toHaveBeenCalled();
  });

  it("holds nothing when no backup says what was running", async () => {
    recordHostEnd(watchdogCrash(), null);
    projectStates.set("p1", { projectId: "p1", terminals: [agent("a")] } as ProjectState);
    expect(await applyHostEndHold("p1")).toBe(0);
  });

  it("holds each live workspace once, even one first opened in a later session", async () => {
    recordHostEnd(watchdogCrash(), ["p1", "p2"]);
    projectStates.set("p1", { projectId: "p1", terminals: [agent("a")] } as ProjectState);
    projectStates.set("p2", { projectId: "p2", terminals: [agent("b")] } as ProjectState);

    expect(await applyHostEndHold("p1")).toBe(1);
    expect(projectStates.get("p1")?.terminals[0].restoreRecovery).toEqual({
      reason: "host-ended-uncleanly",
      sessionId: "sess-a",
      hostEnd: WATCHDOG,
    });

    // The user resumes the pane; the next hydrate of the same workspace keeps it.
    projectStates.set("p1", { projectId: "p1", terminals: [agent("a")] } as ProjectState);
    expect(await applyHostEndHold("p1")).toBe(0);
    expect(projectStates.get("p1")?.terminals[0].restoreRecovery).toBeUndefined();

    // p2 is opened only after a clean quit and a reboot: still held.
    expect(await applyHostEndHold("p2")).toBe(1);
    // Every workspace heard of it, so nothing is left to hold.
    expect(storeData.has("hostEndRestoreHolds")).toBe(false);
  });

  it("leaves a workspace that wasn't live alone", async () => {
    recordHostEnd(watchdogCrash(), ["p1"]);
    projectStates.set("asleep", { projectId: "asleep", terminals: [agent("a")] } as ProjectState);
    expect(await applyHostEndHold("asleep")).toBe(0);
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
    projectStates.set("p1", { projectId: "p1", terminals: [agent("a")] } as ProjectState);

    expect(await applyHostEndHold("p1")).toBe(1);
    expect(projectStates.get("p1")?.terminals[0].restoreRecovery?.hostEnd).toEqual({
      cause: "external-kill",
      at: 1_000,
    });
    expect(storeData.get("hostEndRestoreHolds")).toEqual([
      expect.objectContaining({ crashId: "c2", workspaceIds: ["p2"] }),
    ]);
  });

  it("stays due when the save fails, so the next hydrate holds", async () => {
    recordHostEnd(watchdogCrash(), ["p1"]);
    projectStates.set("p1", { projectId: "p1", terminals: [agent("a")] } as ProjectState);
    projectStoreMock.enqueueProjectStateUpdate.mockRejectedValueOnce(new Error("disk"));
    expect(await applyHostEndHold("p1")).toBe(0);
    expect(await applyHostEndHold("p1")).toBe(1);
  });

  it("writes nothing when no pane needs holding", async () => {
    recordHostEnd(watchdogCrash(), ["p1"]);
    const state = { projectId: "p1", terminals: [] } as unknown as ProjectState;
    projectStates.set("p1", state);
    expect(await applyHostEndHold("p1")).toBe(0);
    expect(projectStates.get("p1")).toBe(state);
  });

  it("ignores a hydrate with no workspace", async () => {
    recordHostEnd(watchdogCrash(), ["p1"]);
    expect(await applyHostEndHold(null)).toBe(0);
  });
});
