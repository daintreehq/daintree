import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingCrash, CrashLogEntry } from "../../../shared/types/ipc/crashRecovery.js";
import type { ProjectState, TerminalSnapshot } from "../../../shared/types/project.js";

const storeData = vi.hoisted(() => new Map<string, unknown>());
const fakeStore = vi.hoisted(() => ({
  get: (key: string) => storeData.get(key),
  set: (key: string, value: unknown) => {
    storeData.set(key, structuredClone(value));
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

import {
  applyHostEndHold,
  holdTerminalsEndedByHost,
  holdTerminalsForRecordedHostEnd,
  readHostEnd,
  recordHostEnd,
} from "../hostEndRestoreHold.js";

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

  it("leaves shells, trashed panes, existing holds, plugin holds and exited agents alone", () => {
    const input = [
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
  it("does nothing until an unclean end is recorded", async () => {
    projectStates.set("p1", { projectId: "p1", terminals: [agent("a")] } as ProjectState);
    recordHostEnd(pending({ crashCause: "power-loss" }));
    expect(await applyHostEndHold("p1")).toBe(0);
    expect(projectStoreMock.enqueueProjectStateUpdate).not.toHaveBeenCalled();
  });

  it("holds each workspace once, even across later sessions", async () => {
    recordHostEnd(
      pending({ cause: "watchdog-deadlock", watchdogKilledAt: 5_000, watchdogMissedBeats: 3 })
    );
    projectStates.set("p1", { projectId: "p1", terminals: [agent("a")] } as ProjectState);
    projectStates.set("p2", { projectId: "p2", terminals: [agent("b")] } as ProjectState);

    expect(await applyHostEndHold("p1")).toBe(1);
    expect(projectStates.get("p1")?.terminals[0].restoreRecovery?.reason).toBe(
      "host-ended-uncleanly"
    );

    // The user resumes the pane; the next hydrate of the same workspace keeps it.
    projectStates.set("p1", { projectId: "p1", terminals: [agent("a")] } as ProjectState);
    expect(await applyHostEndHold("p1")).toBe(0);
    expect(projectStates.get("p1")?.terminals[0].restoreRecovery).toBeUndefined();

    // A workspace not opened until later still has its agents held.
    expect(await applyHostEndHold("p2")).toBe(1);
  });

  it("a newer unclean end holds again", async () => {
    recordHostEnd(pending({ crashCause: "external-kill", timestamp: 1_000 }));
    projectStates.set("p1", { projectId: "p1", terminals: [agent("a")] } as ProjectState);
    await applyHostEndHold("p1");
    projectStates.set("p1", { projectId: "p1", terminals: [agent("a")] } as ProjectState);

    recordHostEnd(pending({ crashCause: "external-kill", timestamp: 9_000 }));
    expect(await applyHostEndHold("p1")).toBe(1);
    expect(projectStates.get("p1")?.terminals[0].restoreRecovery?.hostEnd).toEqual({
      cause: "external-kill",
      at: 9_000,
    });
  });

  it("writes nothing when no pane needs holding", async () => {
    recordHostEnd(pending({ crashCause: "external-kill" }));
    const state = { projectId: "p1", terminals: [] } as unknown as ProjectState;
    projectStates.set("p1", state);
    expect(await applyHostEndHold("p1")).toBe(0);
    expect(projectStates.get("p1")).toBe(state);
  });

  it("ignores a hydrate with no workspace", async () => {
    recordHostEnd(pending({ crashCause: "external-kill" }));
    expect(await applyHostEndHold(null)).toBe(0);
  });
});

describe("holdTerminalsForRecordedHostEnd", () => {
  it("holds a crash restore's panes only while an unclean end is recorded", () => {
    const input = [agent("a")];
    expect(holdTerminalsForRecordedHostEnd(input)).toBe(input);
    recordHostEnd(pending({ crashCause: "external-kill" }));
    expect(holdTerminalsForRecordedHostEnd(input)[0].restoreRecovery?.reason).toBe(
      "host-ended-uncleanly"
    );
  });
});
