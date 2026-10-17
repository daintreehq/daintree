import { describe, expect, it } from "vitest";
import type { RunningLaneSession } from "../../../services/HelpSessionService.js";
import type { LaneWake, LaneWakeOutcome } from "../../../services/mcp-server/terminalNotify.js";
import { AssistantLaneWaker, type LaneWakeRequest } from "../AssistantLaneWaker.js";
import {
  AssistantMessagingPolicy,
  OPEN_LANE_GENERATION,
  type MessagingShell,
} from "../AssistantMessagingPolicy.js";

const SHELL_A: MessagingShell = { kind: "remote", linkSessionId: "link-a" };
const SHELL_B: MessagingShell = { kind: "remote", linkSessionId: "link-b" };
const LANE = { projectId: "proj", slot: 0 };

function harness() {
  const running = new Map<string, RunningLaneSession>();
  const launchGenerations = new Map<string, number>();
  let nextGeneration = 0;
  const policy = new AssistantMessagingPolicy({
    getRunningLaneSession: (projectId, slot) => running.get(`${projectId}#${slot}`) ?? null,
    getLiveGeneration: (terminalId) => launchGenerations.get(terminalId) ?? null,
    isHostMessagingEnabled: () => true,
    acceptsRemoteMessages: () => true,
    onSessionEnded: () => () => {},
    platform: "darwin",
    newGeneration: () => `gen-${++nextGeneration}`,
  });
  const run = (sessionId: string, terminalId = `t-${sessionId}`) => {
    running.set("proj#0", { sessionId, terminalId, projectViewWebContentsId: 1 });
    launchGenerations.set(terminalId, (launchGenerations.get(terminalId) ?? 0) + 1);
  };
  let driver: MessagingShell | null = null;
  const queued: Array<{
    lane: { helpSessionId: string; terminalId: string; projectId: string };
    wake: LaneWake;
  }> = [];
  const waker = new AssistantLaneWaker({
    policy,
    shellDrives: (_projectId, shell) =>
      driver === null ||
      (driver.kind === shell.kind &&
        (driver.kind === "local" ||
          (shell.kind === "remote" && driver.linkSessionId === shell.linkSessionId))),
    queue: (lane, wake) => queued.push({ lane, wake }),
  });
  const outcomes: LaneWakeOutcome[] = [];
  const request = (generation: string, shell = SHELL_A): LaneWakeRequest => ({
    lane: LANE,
    generation,
    shell,
    exchangeId: "task-1",
    sink: { beforeType: () => true, report: (outcome) => outcomes.push(outcome) },
  });
  return {
    policy,
    run,
    waker,
    queued,
    outcomes,
    request,
    driveBy: (shell: MessagingShell | null) => {
      driver = shell;
    },
  };
}

function enrolled() {
  const h = harness();
  h.run("s1");
  const result = h.policy.enroll(LANE, SHELL_A);
  if (!result.ok) throw new Error("expected enrollment");
  return { ...h, generation: result.enrollment.generation };
}

describe("AssistantLaneWaker", () => {
  it("queues the wake on the enrolled run's own pane", () => {
    const h = enrolled();
    h.waker.wake(h.request(h.generation));
    expect(h.queued).toHaveLength(1);
    expect(h.queued[0].lane).toEqual({
      helpSessionId: "s1",
      terminalId: "t-s1",
      projectId: "proj",
    });
    expect(h.queued[0].wake.id).toBe("task-1");
    expect(h.queued[0].wake.recheck()).toEqual({ kind: "ready" });
    expect(h.outcomes).toEqual([]);
  });

  it("carries a hub update's kind through to the pane, and leaves a message's unset", () => {
    const h = enrolled();
    h.waker.wake({ ...h.request(h.generation), kind: "update" });
    h.waker.wake({ ...h.request(h.generation), exchangeId: "task-2" });
    expect(h.queued.map((q) => q.wake.kind)).toEqual(["update", undefined]);
  });

  it("never wakes a lane that isn't enrolled, and launches nothing", () => {
    const h = harness();
    h.waker.wake(h.request("gen-1"));
    expect(h.queued).toEqual([]);
    expect(h.outcomes).toEqual([{ kind: "unavailable", reason: "not-enrolled" }]);
  });

  it("refuses a wake sent under another Shell's session", () => {
    const h = enrolled();
    h.waker.wake(h.request(h.generation, SHELL_B));
    expect(h.queued).toEqual([]);
    expect(h.outcomes).toEqual([{ kind: "unavailable", reason: "wrong-shell" }]);
  });

  it("finds a lane relaunched since admission unavailable at the last check", () => {
    const h = enrolled();
    h.waker.wake(h.request(h.generation));
    h.run("s1");
    expect(h.queued[0].wake.recheck()).toEqual({ kind: "unavailable", reason: "not-enrolled" });
  });

  it("finds a lane re-enrolled since admission unavailable at the last check", () => {
    const h = enrolled();
    h.waker.wake(h.request(h.generation));
    h.policy.unenroll(LANE, SHELL_A, h.generation);
    h.policy.enroll(LANE, SHELL_A);
    expect(h.queued[0].wake.recheck()).toEqual({
      kind: "unavailable",
      reason: "stale-generation",
    });
  });

  it("holds while paused, and is ready again once the pause lifts", () => {
    const h = enrolled();
    h.policy.setPaused(true);
    h.waker.wake(h.request(h.generation));
    expect(h.queued).toHaveLength(1);
    expect(h.queued[0].wake.recheck()).toEqual({ kind: "held", reason: "paused" });

    h.policy.setPaused(false);
    expect(h.queued[0].wake.recheck()).toEqual({ kind: "ready" });
  });

  it("reads the drive lease as the sending Shell at every check", () => {
    const h = enrolled();
    h.driveBy({ kind: "local" });
    h.waker.wake(h.request(h.generation));
    expect(h.queued[0].wake.recheck()).toEqual({ kind: "held", reason: "driven-elsewhere" });

    h.driveBy(SHELL_A);
    expect(h.queued[0].wake.recheck()).toEqual({ kind: "ready" });
  });

  it("passes reservation and outcomes through to the exchange's sink", () => {
    const h = enrolled();
    h.waker.wake(h.request(h.generation));
    const wake = h.queued[0].wake;
    expect(wake.beforeType()).toBe(true);
    wake.report({ kind: "delivered" });
    expect(h.outcomes).toEqual([{ kind: "delivered" }]);
  });
  it("follows the same Shell to its newer session, and no other Shell (#13332)", () => {
    const h = harness();
    h.run("s1");
    h.policy.bindSender("link-a", "sender-a");
    const result = h.policy.enroll(LANE, SHELL_A);
    if (!result.ok) throw new Error("expected enrollment");
    h.driveBy(SHELL_B);
    h.waker.wake(h.request(result.enrollment.generation));
    // Held behind another driver, then the Shell restarts onto a new session.
    expect(h.queued[0].wake.recheck()).toEqual({ kind: "held", reason: "driven-elsewhere" });
    h.policy.releaseLinkSession("link-a");
    h.policy.bindSender("link-a2", "sender-a");
    h.driveBy({ kind: "remote", linkSessionId: "link-a2" });
    expect(h.queued[0].wake.recheck()).toEqual({ kind: "ready" });

    // A different Shell's session is never the one it follows.
    h.policy.releaseLinkSession("link-a2");
    h.policy.bindSender("link-c", "sender-c");
    h.driveBy({ kind: "remote", linkSessionId: "link-c" });
    expect(h.queued[0].wake.recheck()).toEqual({ kind: "held", reason: "driven-elsewhere" });
  });

  describe("a remote Shell's message to an open lane (#13467)", () => {
    it("is typed whoever drives the project: it's this machine's notice to its own assistant", () => {
      const h = harness();
      h.run("s1");
      h.driveBy({ kind: "local" });
      h.waker.wake(h.request(OPEN_LANE_GENERATION, SHELL_B));
      expect(h.queued).toHaveLength(1);
      expect(h.queued[0].lane).toEqual({
        helpSessionId: "s1",
        terminalId: "t-s1",
        projectId: "proj",
      });
      expect(h.queued[0].wake.recheck()).toEqual({ kind: "ready" });
    });

    it("never types into the run that replaced the one it was queued for", () => {
      const h = harness();
      h.run("s1");
      h.waker.wake(h.request(OPEN_LANE_GENERATION));
      h.run("s1");
      expect(h.queued[0].wake.recheck()).toEqual({ kind: "unavailable", reason: "relaunched" });
    });

    it("waits while paused, and reports a lane that isn't running or was turned off", () => {
      const h = harness();
      h.run("s1");
      h.waker.wake(h.request(OPEN_LANE_GENERATION));
      h.policy.setPaused(true);
      expect(h.queued[0].wake.recheck()).toEqual({ kind: "held", reason: "paused" });
      h.policy.setPaused(false);
      h.policy.declineRun(LANE, { kind: "local" });
      expect(h.queued[0].wake.recheck()).toEqual({ kind: "unavailable", reason: "declined" });

      const idle = harness();
      idle.waker.wake(idle.request(OPEN_LANE_GENERATION));
      expect(idle.queued).toEqual([]);
      expect(idle.outcomes).toEqual([{ kind: "unavailable", reason: "unavailable" }]);
    });
  });
});
