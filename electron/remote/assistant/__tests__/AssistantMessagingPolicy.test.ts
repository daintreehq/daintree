import { describe, expect, it } from "vitest";
import type {
  HelpSessionEndedEvent,
  RunningLaneSession,
} from "../../../services/HelpSessionService.js";
import {
  AssistantMessagingPolicy,
  type AssistantMessagingPolicyDeps,
  type MessagingShell,
} from "../AssistantMessagingPolicy.js";

const LOCAL: MessagingShell = { kind: "local" };
const SHELL_A: MessagingShell = { kind: "remote", linkSessionId: "link-a" };
const SHELL_B: MessagingShell = { kind: "remote", linkSessionId: "link-b" };

function laneKey(projectId: string, slot: number): string {
  return `${projectId}#${slot}`;
}

function harness(overrides: Partial<AssistantMessagingPolicyDeps> = {}) {
  const running = new Map<string, RunningLaneSession>();
  const launchGenerations = new Map<string, number>();
  const enabledHosts = new Set<string>();
  const listeners = new Set<(event: HelpSessionEndedEvent) => void>();
  /** Which link session's view each run was started through, by session id. */
  const startedBy = new Map<string, string>();
  let nextGeneration = 0;
  const policy = new AssistantMessagingPolicy({
    getRunningLaneSession: (projectId, slot) => running.get(laneKey(projectId, slot)) ?? null,
    startedThrough: (session, linkSessionId) => startedBy.get(session.sessionId) === linkSessionId,
    getLiveGeneration: (terminalId) => launchGenerations.get(terminalId) ?? null,
    isHostMessagingEnabled: (hostId) => enabledHosts.has(hostId),
    onSessionEnded: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    platform: "darwin",
    now: () => 1_000,
    newGeneration: () => `gen-${++nextGeneration}`,
    ...overrides,
  });
  const run = (
    projectId: string,
    slot: number,
    sessionId: string,
    terminalId = `t-${sessionId}`
  ) => {
    running.set(laneKey(projectId, slot), {
      sessionId,
      terminalId,
      projectViewWebContentsId: 1,
    });
    launchGenerations.set(terminalId, (launchGenerations.get(terminalId) ?? 0) + 1);
  };
  const end = (
    projectId: string,
    slot: number,
    sessionId: string,
    reason: HelpSessionEndedEvent["reason"] = "revoked"
  ) => {
    for (const listener of [...listeners]) {
      listener({ projectId, slot, sessionId, reason });
    }
  };
  return { policy, running, launchGenerations, enabledHosts, listeners, startedBy, run, end };
}

const lane = (projectId = "proj", slot = 0) => ({ projectId, slot });

describe("AssistantMessagingPolicy", () => {
  it("admits nothing until a lane is enrolled", () => {
    const h = harness();
    h.run("proj", 0, "s1");
    expect(
      h.policy.checkLane({ lane: lane(), generation: "gen-1", shell: SHELL_A, kind: "admit" })
    ).toEqual({ ok: false, reason: "not-enrolled" });
    h.enabledHosts.add("studio");
    expect(h.policy.checkHost({ hostId: "studio", kind: "admit" })).toEqual({
      ok: false,
      reason: "no-hub",
    });
  });

  it("refuses a lane whose assistant isn't running rather than starting one", () => {
    const h = harness();
    expect(h.policy.enroll(lane(), SHELL_A)).toEqual({ ok: false, reason: "unavailable" });
    expect(h.policy.getEnrollment(lane())).toBeNull();
  });

  it.each([
    ["negative", -1],
    ["past the last slot", 3],
    ["fractional", 0.5],
    ["NaN", Number.NaN],
    ["not a number", "0" as unknown as number],
  ])("refuses a %s slot", (_label, slot) => {
    const h = harness();
    h.run("proj", 0, "s1");
    expect(h.policy.enroll({ projectId: "proj", slot }, SHELL_A)).toEqual({
      ok: false,
      reason: "invalid-lane",
    });
  });

  it("gives every enrollment a fresh generation and refuses the old one", () => {
    const h = harness();
    h.run("proj", 0, "s1");
    const first = h.policy.enroll(lane(), SHELL_A);
    const second = h.policy.enroll(lane(), SHELL_A);
    if (!first.ok || !second.ok) throw new Error("expected enrollments");
    expect(second.enrollment.generation).not.toBe(first.enrollment.generation);
    expect(
      h.policy.checkLane({
        lane: lane(),
        generation: first.enrollment.generation,
        shell: SHELL_A,
        kind: "admit",
      })
    ).toEqual({ ok: false, reason: "stale-generation" });
    expect(
      h.policy.checkLane({
        lane: lane(),
        generation: second.enrollment.generation,
        shell: SHELL_A,
        kind: "admit",
      }).ok
    ).toBe(true);
  });

  it("keeps a lane to the Shell that enrolled it, even against the same claimed client", () => {
    const h = harness();
    h.run("proj", 0, "s1");
    const enrolled = h.policy.enroll(lane(), SHELL_A);
    if (!enrolled.ok) throw new Error("expected enrollment");
    const generation = enrolled.enrollment.generation;
    expect(h.policy.checkLane({ lane: lane(), generation, shell: SHELL_B, kind: "admit" })).toEqual(
      { ok: false, reason: "wrong-shell" }
    );
    expect(h.policy.checkLane({ lane: lane(), generation, shell: LOCAL, kind: "inspect" })).toEqual(
      { ok: false, reason: "wrong-shell" }
    );
    expect(h.policy.enroll(lane(), SHELL_B)).toEqual({ ok: false, reason: "wrong-shell" });
    expect(h.policy.unenroll(lane(), SHELL_B, generation)).toBe(false);
    expect(h.policy.unenroll(lane(), SHELL_A, "gen-other")).toBe(false);
    expect(h.policy.unenroll(lane(), SHELL_A, generation)).toBe(true);
    expect(h.policy.getEnrollment(lane())).toBeNull();
  });

  it("keeps sibling lanes and other projects apart", () => {
    const h = harness();
    h.run("proj", 0, "s1");
    h.run("proj", 1, "s2");
    h.run("other", 0, "s3");
    const a = h.policy.enroll(lane("proj", 0), SHELL_A);
    const b = h.policy.enroll(lane("proj", 1), SHELL_B);
    const c = h.policy.enroll(lane("other", 0), SHELL_A);
    if (!a.ok || !b.ok || !c.ok) throw new Error("expected enrollments");
    h.end("proj", 0, "s1");
    expect(h.policy.getEnrollment(lane("proj", 0))).toBeNull();
    expect(h.policy.getEnrollment(lane("proj", 1))?.enrolledBy).toEqual(SHELL_B);
    expect(h.policy.getEnrollment(lane("other", 0))?.sessionId).toBe("s3");
  });

  it("ends an enrollment with its session, and an old session's end never touches a newer one", () => {
    const h = harness();
    h.run("proj", 0, "s1");
    expect(h.policy.enroll(lane(), SHELL_A).ok).toBe(true);
    h.run("proj", 0, "s2");
    const renewed = h.policy.enroll(lane(), SHELL_A);
    if (!renewed.ok) throw new Error("expected enrollment");
    h.end("proj", 0, "s1");
    expect(h.policy.getEnrollment(lane())?.generation).toBe(renewed.enrollment.generation);
    h.end("proj", 0, "s2");
    expect(h.policy.getEnrollment(lane())).toBeNull();
  });

  it("ends the enrollment when the lane is running a different run than it was given to", () => {
    const h = harness();
    h.run("proj", 0, "s1");
    const enrolled = h.policy.enroll(lane(), SHELL_A);
    if (!enrolled.ok) throw new Error("expected enrollment");
    const check = {
      lane: lane(),
      generation: enrolled.enrollment.generation,
      shell: SHELL_A,
      kind: "admit" as const,
    };
    // Relaunched in place: same session and terminal id, a new PTY incarnation.
    h.launchGenerations.set("t-s1", 99);
    expect(h.policy.checkLane(check)).toEqual({ ok: false, reason: "not-enrolled" });
    expect(h.policy.getEnrollment(lane())).toBeNull();

    h.run("proj", 0, "s1", "t-other");
    const again = h.policy.enroll(lane(), SHELL_A);
    if (!again.ok) throw new Error("expected enrollment");
    h.run("proj", 0, "s1", "t-third");
    expect(h.policy.checkLane({ ...check, generation: again.enrollment.generation })).toEqual({
      ok: false,
      reason: "not-enrolled",
    });
  });

  it("reports a lane that stopped running as unavailable but still inspectable", () => {
    const h = harness();
    h.run("proj", 0, "s1");
    const enrolled = h.policy.enroll(lane(), SHELL_A);
    if (!enrolled.ok) throw new Error("expected enrollment");
    h.running.delete(laneKey("proj", 0));
    const base = { lane: lane(), generation: enrolled.enrollment.generation, shell: SHELL_A };
    expect(h.policy.checkLane({ ...base, kind: "reply" })).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(h.policy.checkLane({ ...base, kind: "inspect" }).ok).toBe(true);
  });

  it("pause stops admissions and wakes while inspection and in-flight replies go on", () => {
    const h = harness();
    h.run("proj", 0, "s1");
    const enrolled = h.policy.enroll(lane(), SHELL_A);
    if (!enrolled.ok) throw new Error("expected enrollment");
    const base = { lane: lane(), generation: enrolled.enrollment.generation, shell: SHELL_A };
    h.policy.setPaused(true);
    expect(h.policy.isPaused()).toBe(true);
    expect(h.policy.checkLane({ ...base, kind: "admit" })).toEqual({ ok: false, reason: "paused" });
    expect(h.policy.checkLane({ ...base, kind: "wake" })).toEqual({ ok: false, reason: "paused" });
    expect(h.policy.checkLane({ ...base, kind: "reply" }).ok).toBe(true);
    expect(h.policy.checkLane({ ...base, kind: "inspect" }).ok).toBe(true);
    // Pause exempts replies from the pause only, never from ownership.
    expect(h.policy.checkLane({ ...base, shell: SHELL_B, kind: "reply" })).toEqual({
      ok: false,
      reason: "wrong-shell",
    });
    h.policy.setPaused(false);
    expect(h.policy.checkLane({ ...base, kind: "admit" }).ok).toBe(true);
  });

  it("a local lane is this Shell's one hub, and its host opt-in is read at every check", () => {
    const h = harness();
    h.run("proj", 0, "s1");
    h.run("proj", 1, "s2");
    const hub = h.policy.enroll(lane("proj", 0), LOCAL);
    if (!hub.ok) throw new Error("expected hub");
    expect(h.policy.getHub()?.slot).toBe(0);
    expect(h.policy.enroll(lane("proj", 1), LOCAL)).toEqual({ ok: false, reason: "hub-taken" });

    expect(h.policy.checkHost({ hostId: "studio", kind: "admit" })).toEqual({
      ok: false,
      reason: "host-disabled",
    });
    h.enabledHosts.add("studio");
    expect(h.policy.checkHost({ hostId: "studio", kind: "admit" })).toMatchObject({ ok: true });
    h.policy.setPaused(true);
    expect(h.policy.checkHost({ hostId: "studio", kind: "wake" })).toEqual({
      ok: false,
      reason: "paused",
    });
    expect(h.policy.checkHost({ hostId: "studio", kind: "reply" }).ok).toBe(true);
    h.enabledHosts.delete("studio");
    expect(h.policy.checkHost({ hostId: "studio", kind: "reply" })).toEqual({
      ok: false,
      reason: "host-disabled",
    });

    h.enabledHosts.add("studio");
    h.end("proj", 0, "s1");
    expect(h.policy.getHub()).toBeNull();
    expect(h.policy.checkHost({ hostId: "studio", kind: "reply" })).toEqual({
      ok: false,
      reason: "no-hub",
    });
    expect(h.policy.enroll(lane("proj", 1), LOCAL).ok).toBe(true);
  });

  it("drops the hub when its run is replaced, rather than reporting a stale one", () => {
    const h = harness();
    h.enabledHosts.add("studio");
    h.run("proj", 0, "s1");
    expect(h.policy.enroll(lane(), LOCAL).ok).toBe(true);
    h.run("proj", 0, "s2");
    expect(h.policy.checkHost({ hostId: "studio", kind: "admit" })).toEqual({
      ok: false,
      reason: "no-hub",
    });
    expect(h.policy.getHub()).toBeNull();
  });

  it("releases every lane a remote Shell enrolled once its session is gone", () => {
    const h = harness();
    h.run("proj", 0, "s1");
    h.run("proj", 1, "s2");
    h.run("proj", 2, "s3");
    h.run("hub", 0, "s4");
    expect(h.policy.enroll(lane("proj", 0), SHELL_A).ok).toBe(true);
    expect(h.policy.enroll(lane("proj", 1), SHELL_A).ok).toBe(true);
    expect(h.policy.enroll(lane("proj", 2), SHELL_B).ok).toBe(true);
    expect(h.policy.enroll(lane("hub", 0), LOCAL).ok).toBe(true);
    h.policy.releaseLinkSession("link-a");
    expect(h.policy.getEnrollment(lane("proj", 0))).toBeNull();
    expect(h.policy.getEnrollment(lane("proj", 1))).toBeNull();
    expect(h.policy.getEnrollment(lane("proj", 2))?.enrolledBy).toEqual(SHELL_B);
    expect(h.policy.getHub()?.projectId).toBe("hub");
  });

  describe("a Shell's sender carries its enrollments across sessions", () => {
    const SHELL_A2: MessagingShell = { kind: "remote", linkSessionId: "link-a2" };

    it("keeps a proven Shell's enrollments through its session ending, for that Shell alone", () => {
      const h = harness();
      h.run("proj", 0, "s1");
      h.run("proj", 1, "s2");
      const enrolled = h.policy.enroll(lane("proj", 0), SHELL_A);
      if (!enrolled.ok) throw new Error("expected enrollment");
      expect(h.policy.enroll(lane("proj", 1), SHELL_B).ok).toBe(true);
      h.policy.bindSender("link-a", "sender-a");
      h.policy.bindSender("link-b", "sender-b");
      expect(h.policy.getEnrollment(lane("proj", 0))?.sender).toBe("sender-a");

      h.policy.releaseLinkSession("link-a");
      // Waiting: no session can admit a message, but the lane still answers what reached it.
      const waiting = h.policy.getEnrollment(lane("proj", 0));
      expect(waiting?.generation).toBe(enrolled.enrollment.generation);
      expect(
        h.policy.checkLane({
          lane: lane("proj", 0),
          generation: enrolled.enrollment.generation,
          shell: SHELL_A2,
          kind: "admit",
        })
      ).toEqual({ ok: false, reason: "wrong-shell" });
      expect(
        h.policy.checkLane({
          lane: lane("proj", 0),
          generation: enrolled.enrollment.generation,
          shell: waiting!.enrolledBy,
          kind: "reply",
        }).ok
      ).toBe(true);

      // Another Shell proving itself takes nothing.
      expect(h.policy.bindSender("link-x", "sender-c")).toEqual([]);
      expect(h.policy.getEnrollment(lane("proj", 0))?.enrolledBy).toEqual(SHELL_A);

      // The same Shell on a later session takes its lanes back, generation unchanged.
      expect(h.policy.bindSender("link-a2", "sender-a")).toEqual([
        { from: "link-a", to: "link-a2" },
      ]);
      expect(h.policy.getEnrollment(lane("proj", 0))?.enrolledBy).toEqual(SHELL_A2);
      expect(
        h.policy.checkLane({
          lane: lane("proj", 0),
          generation: enrolled.enrollment.generation,
          shell: SHELL_A2,
          kind: "admit",
        }).ok
      ).toBe(true);
      expect(h.policy.listEnrollments(SHELL_A2).map((e) => e.slot)).toEqual([0]);
      expect(h.policy.getEnrollment(lane("proj", 1))?.enrolledBy).toEqual(SHELL_B);
    });

    it("records the sender of a session that proved itself before enrolling", () => {
      const h = harness();
      h.run("proj", 0, "s1");
      h.policy.bindSender("link-a", "sender-a");
      const enrolled = h.policy.enroll(lane("proj", 0), SHELL_A);
      expect(enrolled.ok && enrolled.enrollment.sender).toBe("sender-a");
      h.policy.releaseLinkSession("link-a");
      expect(h.policy.getEnrollment(lane("proj", 0))).not.toBeNull();
    });

    it("still ends an unproven Shell's enrollments with its session, and never moves them", () => {
      const h = harness();
      h.run("proj", 0, "s1");
      expect(h.policy.enroll(lane("proj", 0), SHELL_A).ok).toBe(true);
      h.policy.releaseLinkSession("link-a");
      expect(h.policy.getEnrollment(lane("proj", 0))).toBeNull();
      expect(h.policy.getEnded(lane("proj", 0))?.reason).toBe("shell-gone");
      expect(h.policy.bindSender("link-a2", "sender-a")).toEqual([]);
      expect(h.policy.getEnrollment(lane("proj", 0))).toBeNull();
    });

    it("never lets a session prove a second sender, resumes included", () => {
      const h = harness();
      h.run("proj", 0, "s1");
      h.policy.bindSender("link-a", "sender-a");
      expect(h.policy.enroll(lane("proj", 0), SHELL_A).ok).toBe(true);
      expect(h.policy.bindSender("link-a", "sender-b")).toEqual([]);
      expect(h.policy.sessionSender("link-a")).toBe("sender-a");
      expect(h.policy.getEnrollment(lane("proj", 0))?.sender).toBe("sender-a");
    });

    it("lets a waiting lane be turned off or taken over, never a connected Shell's", () => {
      const h = harness();
      h.run("proj", 0, "s1");
      const first = h.policy.enroll(lane("proj", 0), SHELL_A);
      if (!first.ok) throw new Error("expected enrollment");
      h.policy.bindSender("link-a", "sender-a");
      expect(h.policy.isWaiting(lane("proj", 0))).toBe(false);
      expect(h.policy.enroll(lane("proj", 0), SHELL_B)).toEqual({
        ok: false,
        reason: "wrong-shell",
      });
      expect(h.policy.unenroll(lane("proj", 0), SHELL_B, first.enrollment.generation)).toBe(false);

      h.policy.releaseLinkSession("link-a");
      expect(h.policy.isWaiting(lane("proj", 0))).toBe(true);
      expect(h.policy.unenroll(lane("proj", 0), LOCAL, first.enrollment.generation)).toBe(true);
      expect(h.policy.getEnrollment(lane("proj", 0))).toBeNull();

      const again = h.policy.enroll(lane("proj", 0), { kind: "remote", linkSessionId: "link-a3" });
      if (!again.ok) throw new Error("expected enrollment");
      h.policy.bindSender("link-a3", "sender-a");
      h.policy.releaseLinkSession("link-a3");
      const taken = h.policy.enroll(lane("proj", 0), SHELL_B);
      expect(taken.ok && taken.enrollment.enrolledBy).toEqual(SHELL_B);
      // The Shell that was away finds nothing to take back.
      expect(h.policy.bindSender("link-a4", "sender-a")).toEqual([]);
    });

    it("keeps waiting consent when a takeover is refused, and announces the wait", () => {
      const h = harness();
      h.run("hub", 0, "s-hub");
      h.run("proj", 0, "s1");
      expect(h.policy.enroll(lane("hub", 0), LOCAL).ok).toBe(true);
      const remote = h.policy.enroll(lane("proj", 0), SHELL_A);
      if (!remote.ok) throw new Error("expected enrollment");
      h.policy.bindSender("link-a", "sender-a");
      let changes = 0;
      const off = h.policy.onChange(() => changes++);
      h.policy.releaseLinkSession("link-a");
      expect(changes).toBe(1);
      off();

      // This machine already has its hub, so the lane can't be taken as another.
      expect(h.policy.enroll(lane("proj", 0), LOCAL)).toEqual({ ok: false, reason: "hub-taken" });
      expect(h.policy.getEnrollment(lane("proj", 0))?.generation).toBe(
        remote.enrollment.generation
      );
      expect(h.policy.bindSender("link-a2", "sender-a")).toEqual([
        { from: "link-a", to: "link-a2" },
      ]);
    });

    it("ends a waiting enrollment with its run, and when the host stops listening", () => {
      const h = harness();
      h.run("proj", 0, "s1");
      h.run("proj", 1, "s2");
      expect(h.policy.enroll(lane("proj", 0), SHELL_A).ok).toBe(true);
      expect(h.policy.enroll(lane("proj", 1), SHELL_A).ok).toBe(true);
      h.policy.bindSender("link-a", "sender-a");
      h.policy.releaseLinkSession("link-a");
      h.end("proj", 0, "s1");
      expect(h.policy.getEnrollment(lane("proj", 0))).toBeNull();
      h.policy.releaseRemoteShells();
      expect(h.policy.getEnrollment(lane("proj", 1))).toBeNull();
      expect(h.policy.bindSender("link-a2", "sender-a")).toEqual([]);
    });
  });

  it("releases every remote Shell's lanes when this host stops listening, keeping the hub", () => {
    const h = harness();
    h.run("proj", 0, "s1");
    h.run("proj", 1, "s2");
    h.run("hub", 0, "s3");
    expect(h.policy.enroll(lane("proj", 0), SHELL_A).ok).toBe(true);
    expect(h.policy.enroll(lane("proj", 1), SHELL_B).ok).toBe(true);
    expect(h.policy.enroll(lane("hub", 0), LOCAL).ok).toBe(true);
    h.policy.releaseRemoteShells();
    expect(h.policy.getEnrollment(lane("proj", 0))).toBeNull();
    expect(h.policy.getEnrollment(lane("proj", 1))).toBeNull();
    expect(h.policy.getHub()?.projectId).toBe("hub");
    // A Shell connecting afresh may now take the lane.
    expect(h.policy.enroll(lane("proj", 0), SHELL_B).ok).toBe(true);
  });

  it("a replaced run frees its lane for inspection, another Shell and another hub without a delivery check first", () => {
    const h = harness();
    h.run("proj", 0, "s1");
    h.run("proj", 1, "s2");
    const enrolled = h.policy.enroll(lane("proj", 0), SHELL_A);
    const hub = h.policy.enroll(lane("proj", 1), LOCAL);
    if (!enrolled.ok || !hub.ok) throw new Error("expected enrollments");

    h.launchGenerations.set("t-s1", 99);
    expect(
      h.policy.checkLane({
        lane: lane("proj", 0),
        generation: enrolled.enrollment.generation,
        shell: SHELL_A,
        kind: "inspect",
      })
    ).toEqual({ ok: false, reason: "not-enrolled" });
    expect(h.policy.enroll(lane("proj", 0), SHELL_B).ok).toBe(true);

    h.run("proj", 1, "s2-relaunched");
    expect(h.policy.enroll(lane("proj", 0), LOCAL)).toEqual({ ok: false, reason: "wrong-shell" });
    h.run("proj", 2, "s3");
    expect(h.policy.enroll(lane("proj", 2), LOCAL).ok).toBe(true);
    expect(h.policy.getHub()?.slot).toBe(2);
  });

  it("keeps the enrollment of a PTY that isn't running, until a different one runs in its place", () => {
    const h = harness();
    h.run("proj", 0, "s1");
    const enrolled = h.policy.enroll(lane(), SHELL_A);
    if (!enrolled.ok) throw new Error("expected enrollment");
    const base = { lane: lane(), generation: enrolled.enrollment.generation, shell: SHELL_A };
    h.launchGenerations.delete("t-s1");
    expect(h.policy.checkLane({ ...base, kind: "wake" })).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(h.policy.checkLane({ ...base, kind: "inspect" }).ok).toBe(true);
    expect(h.policy.enroll(lane(), SHELL_A)).toEqual({ ok: false, reason: "unavailable" });
    h.launchGenerations.set("t-s1", 7);
    expect(h.policy.checkLane({ ...base, kind: "inspect" })).toEqual({
      ok: false,
      reason: "not-enrolled",
    });
  });

  it.each([
    ["an empty project id", { projectId: "", slot: 0 }, SHELL_A],
    ["a remote Shell with no link session", lane(), { kind: "remote", linkSessionId: "" }],
    ["an unknown Shell kind", lane(), { kind: "peer" }],
    ["a missing Shell", lane(), null],
  ])("refuses %s without recording consent", (_label, ref, shell) => {
    const h = harness();
    h.run("proj", 0, "s1");
    h.run("", 0, "s0");
    expect(h.policy.enroll(ref, shell as MessagingShell)).toEqual({
      ok: false,
      reason: "invalid-lane",
    });
    expect(h.policy.getEnrollment(lane())).toBeNull();
    expect(h.policy.getHub()).toBeNull();
  });

  it("a lane withdrawn by its Shell can be enrolled again, under a new generation", () => {
    const h = harness();
    h.run("proj", 0, "s1");
    const first = h.policy.enroll(lane(), SHELL_A);
    if (!first.ok) throw new Error("expected enrollment");
    expect(h.policy.unenroll(lane(), SHELL_A, first.enrollment.generation)).toBe(true);
    const second = h.policy.enroll(lane(), SHELL_A);
    if (!second.ok) throw new Error("expected enrollment");
    expect(second.enrollment.generation).not.toBe(first.enrollment.generation);
    expect(h.policy.unenroll(lane(), SHELL_A, first.enrollment.generation)).toBe(false);
    expect(
      h.policy.checkLane({
        lane: lane(),
        generation: first.enrollment.generation,
        shell: SHELL_A,
        kind: "admit",
      })
    ).toEqual({ ok: false, reason: "stale-generation" });
  });

  it("lists only the lanes a Shell enrolled, dropping one whose run was replaced", () => {
    const h = harness();
    h.run("proj", 0, "s1");
    h.run("proj", 1, "s2");
    h.run("other", 0, "s3");
    h.policy.enroll(lane("proj", 0), SHELL_A);
    h.policy.enroll(lane("proj", 1), SHELL_B);
    h.policy.enroll(lane("other", 0), SHELL_A);

    const listed = (shell: MessagingShell) =>
      h.policy.listEnrollments(shell).map((e) => [e.projectId, e.slot, e.generation]);
    expect(listed(SHELL_A)).toEqual([
      ["proj", 0, "gen-1"],
      ["other", 0, "gen-3"],
    ]);
    expect(listed(SHELL_B)).toEqual([["proj", 1, "gen-2"]]);
    expect(listed(LOCAL)).toEqual([]);

    // Relaunched in place: consent given to the old run is not listed.
    h.run("other", 0, "s4");
    expect(listed(SHELL_A)).toEqual([["proj", 0, "gen-1"]]);

    // Copies: rewriting one changes nothing the policy holds.
    h.policy.listEnrollments(SHELL_A)[0]!.enrolledBy = SHELL_B;
    expect(listed(SHELL_B)).toEqual([["proj", 1, "gen-2"]]);
  });

  it("hands out copies, so a caller can't rewrite who a lane answers to", () => {
    const h = harness();
    h.run("proj", 0, "s1");
    const enrolled = h.policy.enroll(lane(), SHELL_A);
    if (!enrolled.ok) throw new Error("expected enrollment");
    (enrolled.enrollment.enrolledBy as { linkSessionId: string }).linkSessionId = "link-b";
    const snapshot = h.policy.getEnrollment(lane());
    if (!snapshot) throw new Error("expected enrollment");
    snapshot.generation = "forged";
    expect(h.policy.getEnrollment(lane())).toMatchObject({
      generation: enrolled.enrollment.generation,
      enrolledBy: SHELL_A,
    });
  });

  it("tells change listeners when an enrollment begins or ends, however it ends (#13335)", () => {
    const h = harness();
    let changes = 0;
    const off = h.policy.onChange(() => changes++);
    h.run("proj", 0, "s1");
    const enrolled = h.policy.enroll(lane(), SHELL_A);
    if (!enrolled.ok) throw new Error("expected enrollment");
    expect(changes).toBe(1);
    h.policy.releaseLinkSession("link-other");
    expect(changes).toBe(1);
    h.policy.releaseLinkSession("link-a");
    expect(changes).toBe(2);

    h.policy.enroll(lane(), SHELL_A);
    h.end("proj", 0, "s1");
    expect(changes).toBe(4);

    h.policy.enroll(lane(), SHELL_A);
    // Relaunched in place: the next read drops the stale enrollment and says so.
    h.run("proj", 0, "s2");
    expect(h.policy.getEnrollment(lane())).toBeNull();
    expect(changes).toBe(6);

    off();
    h.policy.enroll(lane(), SHELL_A);
    expect(changes).toBe(6);
  });

  it("carries none of this on Windows", () => {
    const h = harness({ platform: "win32" });
    h.run("proj", 0, "s1");
    h.enabledHosts.add("studio");
    expect(h.policy.enroll(lane(), LOCAL)).toEqual({ ok: false, reason: "unsupported-platform" });
    expect(h.policy.checkHost({ hostId: "studio", kind: "inspect" })).toEqual({
      ok: false,
      reason: "unsupported-platform",
    });
  });

  it("disposes once: unsubscribes from session events and forgets every enrollment and the pause", () => {
    const h = harness();
    h.run("proj", 0, "s1");
    expect(h.policy.enroll(lane(), SHELL_A).ok).toBe(true);
    h.policy.setPaused(true);
    expect(h.listeners.size).toBe(1);
    h.policy.dispose();
    h.policy.dispose();
    expect(h.listeners.size).toBe(0);
    expect(h.policy.getEnrollment(lane())).toBeNull();
    expect(h.policy.isPaused()).toBe(false);
  });

  describe("how an enrollment ended", () => {
    it.each([
      ["revoked", "revoked"],
      ["displaced", "displaced"],
      ["relaunched", "relaunched"],
      ["probe-failed", "stopped"],
      ["discarded", "stopped"],
    ] as const)("records a %s session as %s", (sessionReason, reason) => {
      const h = harness();
      h.run("proj", 0, "s1");
      h.policy.enroll(lane(), SHELL_A);
      h.end("proj", 0, "s1", sessionReason);
      expect(h.policy.getEnrollment(lane())).toBeNull();
      expect(h.policy.getEnded(lane())).toEqual({ reason, at: 1_000, enrolledBy: SHELL_A });
    });

    it("records a run replaced in place as relaunched, even without a session event", () => {
      const h = harness();
      h.run("proj", 0, "s1", "term");
      h.policy.enroll(lane(), LOCAL);
      h.run("proj", 0, "s1", "term");
      expect(h.policy.getEnded(lane())?.reason).toBe("relaunched");
      expect(h.policy.getHub()).toBeNull();
    });

    it("reconcile ends a run replaced in place and tells listeners, without anyone reading", () => {
      const h = harness();
      let heard = 0;
      h.run("proj", 0, "s1", "term");
      h.run("proj", 1, "s2");
      h.policy.enroll(lane("proj", 0), SHELL_A);
      h.policy.enroll(lane("proj", 1), SHELL_A);
      h.policy.onChange(() => heard++);
      h.policy.reconcile();
      expect(heard).toBe(0);
      h.run("proj", 0, "s1", "term");
      h.policy.reconcile();
      expect(heard).toBe(1);
      expect(h.policy.getEnded(lane("proj", 0))?.reason).toBe("relaunched");
      expect(h.policy.getEnrollment(lane("proj", 1))).not.toBeNull();
    });

    it("records a remote Shell that is gone for good, and leaves the hub alone", () => {
      const h = harness();
      h.run("proj", 0, "s1");
      h.run("proj", 1, "s2");
      h.policy.enroll(lane("proj", 0), SHELL_A);
      h.policy.enroll(lane("proj", 1), LOCAL);
      h.policy.releaseLinkSession("link-a");
      expect(h.policy.getEnded(lane("proj", 0))?.reason).toBe("shell-gone");
      expect(h.policy.getEnded(lane("proj", 1))).toBeNull();
    });

    it("records nothing when the person withdraws, and forgets an ending once enrolled again", () => {
      const h = harness();
      h.run("proj", 0, "s1");
      const first = h.policy.enroll(lane(), SHELL_A);
      if (!first.ok) throw new Error("expected enrollment");
      h.policy.unenroll(lane(), SHELL_A, first.enrollment.generation);
      expect(h.policy.getEnded(lane())).toBeNull();

      h.policy.enroll(lane(), SHELL_A);
      h.end("proj", 0, "s1", "displaced");
      expect(h.policy.getEnded(lane())?.reason).toBe("displaced");
      h.run("proj", 0, "s2");
      expect(h.policy.enroll(lane(), SHELL_A).ok).toBe(true);
      expect(h.policy.getEnded(lane())).toBeNull();
    });

    it("an old session's end leaves a newer enrollment and its record alone", () => {
      const h = harness();
      h.run("proj", 0, "s2");
      h.policy.enroll(lane(), SHELL_A);
      h.end("proj", 0, "s1", "revoked");
      expect(h.policy.getEnrollment(lane())).not.toBeNull();
      expect(h.policy.getEnded(lane())).toBeNull();
    });
  });

  describe("change notifications", () => {
    it("tells listeners about every real change and bumps the revision", () => {
      const h = harness();
      let heard = 0;
      h.policy.onChange(() => heard++);
      h.run("proj", 0, "s1");
      const enrolled = h.policy.enroll(lane(), SHELL_A);
      expect(heard).toBe(1);
      h.policy.setPaused(true);
      expect(heard).toBe(2);
      h.policy.setPaused(true);
      expect(heard).toBe(2);
      if (!enrolled.ok) throw new Error("expected enrollment");
      h.policy.unenroll(lane(), SHELL_A, enrolled.enrollment.generation);
      expect(heard).toBe(3);
      expect(h.policy.getRevision()).toBe(3);
    });

    it("stays quiet for refusals and releases that release nothing", () => {
      const h = harness();
      let heard = 0;
      h.policy.onChange(() => heard++);
      h.policy.enroll(lane(), SHELL_A);
      h.policy.unenroll(lane(), SHELL_A, "gen-unknown");
      h.policy.releaseLinkSession("link-a");
      h.policy.releaseRemoteShells();
      expect(heard).toBe(0);
    });

    it("tells listeners when a session ends an enrollment or a Shell's lanes are released", () => {
      const h = harness();
      let heard = 0;
      h.run("proj", 0, "s1");
      h.run("proj", 1, "s2");
      h.policy.enroll(lane("proj", 0), SHELL_A);
      h.policy.enroll(lane("proj", 1), SHELL_B);
      h.policy.onChange(() => heard++);
      h.end("proj", 0, "s1", "revoked");
      expect(heard).toBe(1);
      h.policy.releaseRemoteShells();
      expect(heard).toBe(2);
    });

    it("keeps notifying the rest when one listener throws, and stops after unsubscribe or dispose", () => {
      const h = harness();
      let heard = 0;
      h.policy.onChange(() => {
        throw new Error("boom");
      });
      const off = h.policy.onChange(() => heard++);
      h.policy.setPaused(true);
      expect(heard).toBe(1);
      off();
      h.policy.setPaused(false);
      expect(heard).toBe(1);
      h.policy.onChange(() => heard++);
      h.policy.dispose();
      h.policy.setPaused(true);
      expect(heard).toBe(1);
    });
  });

  describe("enrolling a run a hub started (#13392)", () => {
    it("enrolls only the run it names, and only while nobody holds the lane", () => {
      const h = harness();
      h.run("proj", 0, "s1");
      h.startedBy.set("s1", "link-a");
      expect(h.policy.enrollStarted(lane("proj", 0), SHELL_A, "someone-else")).toEqual({
        ok: false,
        reason: "wrong-session",
      });
      expect(h.policy.enrollStarted(lane("proj", 1), SHELL_A, "s2")).toEqual({
        ok: false,
        reason: "unavailable",
      });
      // Knowing the session id isn't enough: the run has to have come through this Shell's view.
      expect(h.policy.enrollStarted(lane("proj", 0), SHELL_B, "s1")).toEqual({
        ok: false,
        reason: "wrong-session",
      });
      const enrolled = h.policy.enrollStarted(lane("proj", 0), SHELL_A, "s1");
      if (!enrolled.ok) throw new Error("expected enrollment");
      // Asked again for the same run: the same enrollment, not a new generation.
      const again = h.policy.enrollStarted(lane("proj", 0), SHELL_A, "s1");
      expect(again.ok && again.enrollment.generation).toBe(enrolled.enrollment.generation);
    });

    it("never takes a lane another Shell holds, not even while that Shell is away", () => {
      const h = harness();
      h.run("proj", 0, "s1");
      h.startedBy.set("s1", "link-a");
      expect(h.policy.enroll(lane("proj", 0), SHELL_B).ok).toBe(true);
      expect(h.policy.enrollStarted(lane("proj", 0), SHELL_A, "s1")).toEqual({
        ok: false,
        reason: "occupied",
      });
      h.policy.bindSender("link-b", "sender-b");
      h.policy.releaseLinkSession("link-b");
      expect(h.policy.isWaiting(lane("proj", 0))).toBe(true);
      expect(h.policy.enrollStarted(lane("proj", 0), SHELL_A, "s1")).toEqual({
        ok: false,
        reason: "occupied",
      });
      // The person's own toggle keeps its rules: a Shell that's here may take a waiting lane.
      expect(h.policy.enroll(lane("proj", 0), SHELL_A).ok).toBe(true);
    });
  });

  describe("enrolling by the saved default (#13441)", () => {
    it("makes the first running lane this Shell's hub, and never a second one", () => {
      const h = harness();
      h.run("proj", 0, "s1");
      h.run("proj", 1, "s2");
      const hub = h.policy.enrollByDefault(lane("proj", 0), LOCAL);
      expect(hub.ok).toBe(true);
      expect(h.policy.getHub()).toMatchObject({ projectId: "proj", slot: 0, enrolledBy: LOCAL });
      expect(h.policy.enrollByDefault(lane("proj", 1), LOCAL)).toEqual({
        ok: false,
        reason: "hub-taken",
      });
      // Asked again for the hub itself: left as it is, generation and all.
      expect(h.policy.enrollByDefault(lane("proj", 0), LOCAL)).toEqual({
        ok: false,
        reason: "occupied",
      });
      expect(h.policy.getHub()?.generation).toBe(hub.ok && hub.enrollment.generation);
    });

    it("waits for a run rather than starting one", () => {
      const h = harness();
      expect(h.policy.enrollByDefault(lane(), LOCAL)).toEqual({ ok: false, reason: "unavailable" });
      // Bound to a lane but not spawned yet: no PTY incarnation to give consent to.
      h.running.set(laneKey("proj", 0), {
        sessionId: "s1",
        terminalId: "t-s1",
        projectViewWebContentsId: 1,
      });
      expect(h.policy.enrollByDefault(lane(), LOCAL)).toEqual({ ok: false, reason: "unavailable" });
      expect(h.policy.getEnrollment(lane())).toBeNull();
    });

    it("never takes a lane another Shell holds, not even while that Shell is away", () => {
      const h = harness();
      h.run("proj", 0, "s1");
      h.startedBy.set("s1", "link-a");
      h.policy.bindSender("link-a", "sender-a");
      h.policy.bindSender("link-b", "sender-b");
      const held = h.policy.enroll(lane(), SHELL_B);
      if (!held.ok) throw new Error("expected enrollment");
      expect(h.policy.enrollByDefault(lane(), SHELL_A)).toEqual({ ok: false, reason: "occupied" });
      h.policy.releaseLinkSession("link-b");
      expect(h.policy.isWaiting(lane())).toBe(true);
      expect(h.policy.enrollByDefault(lane(), SHELL_A)).toEqual({ ok: false, reason: "occupied" });
      expect(h.policy.enrollByDefault(lane(), LOCAL)).toEqual({ ok: false, reason: "occupied" });
      expect(h.policy.getEnrollment(lane())).toMatchObject({
        generation: held.enrollment.generation,
        enrolledBy: SHELL_B,
      });
    });

    it("enrolls a remote Shell only once it proved its sender, and only for a run in its own view", () => {
      const h = harness();
      h.run("proj", 0, "s1");
      h.startedBy.set("s1", "link-a");
      expect(h.policy.enrollByDefault(lane(), SHELL_A)).toEqual({ ok: false, reason: "unproven" });
      h.policy.bindSender("link-b", "sender-b");
      expect(h.policy.enrollByDefault(lane(), SHELL_B)).toEqual({
        ok: false,
        reason: "wrong-session",
      });
      h.policy.bindSender("link-a", "sender-a");
      const enrolled = h.policy.enrollByDefault(lane(), SHELL_A);
      expect(enrolled.ok && enrolled.enrollment).toMatchObject({
        enrolledBy: SHELL_A,
        sender: "sender-a",
      });
    });

    it("tells listeners the first time a session proves its sender, and only then", () => {
      const h = harness();
      let changes = 0;
      h.policy.onChange(() => changes++);
      h.policy.bindSender("link-a", "sender-a");
      expect(changes).toBe(1);
      h.policy.bindSender("link-a", "sender-a");
      h.policy.bindSender("link-a", "sender-other");
      expect(changes).toBe(1);
    });

    it("keeps a run the person turned off from being enrolled again until it's replaced", () => {
      const h = harness();
      h.run("proj", 0, "s1");
      const first = h.policy.enrollByDefault(lane(), LOCAL);
      if (!first.ok) throw new Error("expected enrollment");
      let enrolledWhenHeard: boolean | null = null;
      const off = h.policy.onChange(() => {
        // Whatever the change sets off finds the decline already in place.
        enrolledWhenHeard = h.policy.enrollByDefault(lane(), LOCAL).ok;
      });
      expect(h.policy.unenroll(lane(), LOCAL, first.enrollment.generation, { decline: true })).toBe(
        true
      );
      off();
      expect(enrolledWhenHeard).toBe(false);
      expect(h.policy.enrollByDefault(lane(), LOCAL)).toEqual({ ok: false, reason: "declined" });

      // A relaunch onto a new PTY incarnation is a new run.
      h.run("proj", 0, "s1");
      expect(h.policy.enrollByDefault(lane(), LOCAL).ok).toBe(true);
    });

    it("lets a decline lapse with its session", () => {
      const h = harness();
      h.run("proj", 0, "s1");
      const first = h.policy.enrollByDefault(lane(), LOCAL);
      if (!first.ok) throw new Error("expected enrollment");
      h.policy.unenroll(lane(), LOCAL, first.enrollment.generation, { decline: true });
      h.end("proj", 0, "s1");
      h.run("proj", 0, "s2");
      expect(h.policy.enrollByDefault(lane(), LOCAL).ok).toBe(true);
    });

    it("lifts a decline when the person turns the lane on again", () => {
      const h = harness();
      h.run("proj", 0, "s1");
      const first = h.policy.enrollByDefault(lane(), LOCAL);
      if (!first.ok) throw new Error("expected enrollment");
      h.policy.unenroll(lane(), LOCAL, first.enrollment.generation, { decline: true });
      const manual = h.policy.enroll(lane(), LOCAL);
      if (!manual.ok) throw new Error("expected enrollment");
      h.policy.unenroll(lane(), LOCAL, manual.enrollment.generation);
      expect(h.policy.enrollByDefault(lane(), LOCAL).ok).toBe(true);
    });

    it("leaves a plain withdrawal to the default", () => {
      const h = harness();
      h.run("proj", 0, "s1");
      const first = h.policy.enrollByDefault(lane(), LOCAL);
      if (!first.ok) throw new Error("expected enrollment");
      h.policy.unenroll(lane(), LOCAL, first.enrollment.generation);
      expect(h.policy.enrollByDefault(lane(), LOCAL).ok).toBe(true);
    });

    it("doesn't move the hub to a sibling while the hub the person turned off still runs", () => {
      const h = harness();
      h.run("proj", 0, "s1");
      h.run("proj", 1, "s2");
      const hub = h.policy.enrollByDefault(lane("proj", 0), LOCAL);
      if (!hub.ok) throw new Error("expected enrollment");
      h.policy.unenroll(lane("proj", 0), LOCAL, hub.enrollment.generation, { decline: true });
      expect(h.policy.enrollByDefault(lane("proj", 1), LOCAL)).toEqual({
        ok: false,
        reason: "declined",
      });
      // The person may still pick another hub themselves.
      expect(h.policy.enroll(lane("proj", 1), LOCAL).ok).toBe(true);
      h.policy.unenroll(lane("proj", 1), LOCAL, h.policy.getHub()!.generation);

      // Once the declined hub stops, the next running lane may become the hub.
      h.running.delete(laneKey("proj", 0));
      h.end("proj", 0, "s1");
      expect(h.policy.enrollByDefault(lane("proj", 1), LOCAL).ok).toBe(true);
    });

    it("lets a declined remote run keep its decline without holding back this Shell's hub", () => {
      const h = harness();
      h.run("proj", 0, "s1");
      h.run("hub", 0, "s-hub");
      h.startedBy.set("s1", "link-a");
      h.policy.bindSender("link-a", "sender-a");
      const remote = h.policy.enrollByDefault(lane("proj", 0), SHELL_A);
      if (!remote.ok) throw new Error("expected enrollment");
      h.policy.unenroll(lane("proj", 0), SHELL_A, remote.enrollment.generation, { decline: true });
      expect(h.policy.enrollByDefault(lane("proj", 0), SHELL_A)).toEqual({
        ok: false,
        reason: "declined",
      });
      expect(h.policy.enrollByDefault(lane("hub", 0), LOCAL).ok).toBe(true);
    });

    it("refuses a hub's late start for a run the person turned off", () => {
      const h = harness();
      h.run("proj", 0, "s1");
      h.startedBy.set("s1", "link-a");
      h.policy.bindSender("link-a", "sender-a");
      const enrolled = h.policy.enrollByDefault(lane(), SHELL_A);
      if (!enrolled.ok) throw new Error("expected enrollment");
      h.policy.unenroll(lane(), SHELL_A, enrolled.enrollment.generation, { decline: true });
      expect(h.policy.enrollStarted(lane(), SHELL_A, "s1")).toEqual({
        ok: false,
        reason: "declined",
      });
      expect(h.policy.getEnrollment(lane())).toBeNull();
    });

    it("gives a run whose consent ended back to the Shell that gave it, never to another", () => {
      const h = harness();
      h.run("proj", 0, "s1");
      h.startedBy.set("s1", "link-a");
      h.policy.bindSender("link-a", "sender-a");
      expect(h.policy.enrollByDefault(lane(), SHELL_A).ok).toBe(true);
      // The host stopped listening; another Shell's view then took the assistant over.
      h.policy.releaseRemoteShells();
      h.startedBy.set("s1", "link-b");
      h.policy.bindSender("link-b", "sender-b");
      expect(h.policy.enrollByDefault(lane(), SHELL_B)).toEqual({
        ok: false,
        reason: "wrong-shell",
      });
      expect(h.policy.enrollByDefault(lane(), LOCAL)).toEqual({ ok: false, reason: "wrong-shell" });
      // The person there may still turn it on themselves.
      expect(h.policy.getEnded(lane())).toEqual({
        reason: "shell-gone",
        at: 1_000,
        enrolledBy: SHELL_A,
      });

      // The Shell that gave it, back on a new session, gets it again.
      h.startedBy.set("s1", "link-a2");
      h.policy.bindSender("link-a2", "sender-a");
      expect(
        h.policy.enrollByDefault(lane(), { kind: "remote", linkSessionId: "link-a2" }).ok
      ).toBe(true);
    });

    it("lets a new run go to whichever Shell's view it runs in", () => {
      const h = harness();
      h.run("proj", 0, "s1");
      h.startedBy.set("s1", "link-a");
      h.policy.bindSender("link-a", "sender-a");
      expect(h.policy.enrollByDefault(lane(), SHELL_A).ok).toBe(true);
      h.policy.releaseRemoteShells();
      h.run("proj", 0, "s2");
      h.startedBy.set("s2", "link-b");
      h.policy.bindSender("link-b", "sender-b");
      expect(h.policy.enrollByDefault(lane(), SHELL_B).ok).toBe(true);
    });

    it("waits for a spawn to succeed, so a spawn that fails never holds the hub", () => {
      const confirmed = new Set<string>();
      const h = harness({ spawnConfirmed: (terminalId) => confirmed.has(terminalId) });
      h.run("proj", 0, "s1");
      expect(h.policy.enrollByDefault(lane(), LOCAL)).toEqual({ ok: false, reason: "unavailable" });
      // The person's own toggle doesn't wait.
      expect(h.policy.enroll(lane(), LOCAL).ok).toBe(true);
      h.policy.unenroll(lane(), LOCAL, h.policy.getHub()!.generation);
      confirmed.add("t-s1");
      expect(h.policy.enrollByDefault(lane(), LOCAL).ok).toBe(true);
    });

    it("enrolls nothing on Windows", () => {
      const h = harness({ platform: "win32" });
      h.run("proj", 0, "s1");
      expect(h.policy.enrollByDefault(lane(), LOCAL)).toEqual({
        ok: false,
        reason: "unsupported-platform",
      });
    });
  });

  describe("lanes open to every Shell (#13467)", () => {
    const accepting = () => {
      let accepts = true;
      const h = harness({ acceptsRemoteMessages: () => accepts });
      return {
        ...h,
        setAccepts: (value: boolean) => {
          accepts = value;
        },
      };
    };

    it("lets any Shell reach a running lane with nobody enrolling it, wherever it runs", () => {
      const h = accepting();
      h.run("proj", 0, "s1");
      // Its own window's hub, or another Shell's route, takes nothing away from the rest.
      expect(h.policy.enroll(lane(), LOCAL).ok).toBe(true);
      expect(h.policy.checkOpen(lane(), "admit")).toEqual({
        ok: true,
        run: {
          projectId: "proj",
          slot: 0,
          sessionId: "s1",
          terminalId: "t-s1",
          launchGeneration: 1,
        },
      });
      expect(h.policy.getHub()?.slot).toBe(0);
      expect(h.policy.checkOpen(lane("proj", 1), "admit")).toEqual({
        ok: false,
        reason: "unavailable",
      });
    });

    it("answers with the run there now, so a relaunch is reached at the same address", () => {
      const h = accepting();
      h.run("proj", 0, "s1");
      h.run("proj", 0, "s1");
      const relaunched = h.policy.checkOpen(lane(), "wake");
      expect(relaunched.ok && relaunched.run.launchGeneration).toBe(2);
      h.run("proj", 0, "s2");
      const replaced = h.policy.checkOpen(lane(), "wake");
      expect(replaced.ok && replaced.run.sessionId).toBe("s2");
    });

    it("closes to new messages with the machine's setting, but never to answering", () => {
      const h = accepting();
      h.run("proj", 0, "s1");
      h.setAccepts(false);
      for (const kind of ["admit", "wake", "inspect"] as const) {
        expect(h.policy.checkOpen(lane(), kind)).toEqual({ ok: false, reason: "not-accepting" });
      }
      expect(h.policy.checkOpen(lane(), "reply").ok).toBe(true);
      expect(harness().policy.checkOpen(lane(), "admit")).toEqual({
        ok: false,
        reason: "not-accepting",
      });
    });

    it("holds new messages while paused, but still lists the lane and lets it answer", () => {
      const h = accepting();
      h.run("proj", 0, "s1");
      h.policy.setPaused(true);
      expect(h.policy.checkOpen(lane(), "admit")).toEqual({ ok: false, reason: "paused" });
      expect(h.policy.checkOpen(lane(), "inspect").ok).toBe(true);
      expect(h.policy.checkOpen(lane(), "reply").ok).toBe(true);
    });

    it("turns off only the run the person turned off, ending what it was enrolled as", () => {
      const h = accepting();
      h.run("proj", 0, "s1");
      expect(h.policy.enroll(lane(), SHELL_A).ok).toBe(true);
      const changes: number[] = [];
      h.policy.onChange(() => changes.push(h.policy.getRevision()));
      expect(h.policy.declineRun(lane(), SHELL_B)).toBe(true);
      expect(changes).toHaveLength(1);
      expect(h.policy.checkOpen(lane(), "admit")).toEqual({ ok: false, reason: "declined" });
      expect(h.policy.checkOpen(lane(), "reply").ok).toBe(true);
      expect(h.policy.isRunDeclined(lane())).toBe(true);
      expect(h.policy.getEnrollment(lane())).toBeNull();
      // Nor does a default or a Shell's start give it back for this run.
      h.startedBy.set("s1", "link-a");
      expect(h.policy.enrollStarted(lane(), SHELL_A, "s1")).toEqual({
        ok: false,
        reason: "declined",
      });

      h.policy.acceptRun(lane());
      expect(h.policy.checkOpen(lane(), "admit").ok).toBe(true);
      h.policy.declineRun(lane(), SHELL_B);
      h.run("proj", 0, "s2");
      expect(h.policy.checkOpen(lane(), "admit").ok).toBe(true);
      expect(h.policy.declineRun(lane("proj", 3), SHELL_B)).toBe(false);
    });

    it("keeps a hub turned off here from passing to a sibling by default while it runs, however often", () => {
      const h = accepting();
      h.run("proj", 0, "s1");
      h.run("proj", 1, "s2");
      expect(h.policy.enrollByDefault(lane(), LOCAL).ok).toBe(true);
      h.policy.declineRun(lane(), LOCAL);
      expect(h.policy.getHub()).toBeNull();
      // A second off, from another view say, still knows it was the hub.
      h.policy.declineRun(lane(), LOCAL);
      expect(h.policy.enrollByDefault(lane("proj", 1), LOCAL)).toEqual({
        ok: false,
        reason: "declined",
      });
    });

    it("never ends this machine's hub for a remote view's off", () => {
      const h = accepting();
      h.run("proj", 0, "s1");
      expect(h.policy.enroll(lane(), LOCAL).ok).toBe(true);
      expect(h.policy.declineRun(lane(), SHELL_A)).toBe(true);
      expect(h.policy.checkOpen(lane(), "admit")).toEqual({ ok: false, reason: "declined" });
      expect(h.policy.getHub()?.slot).toBe(0);
    });

    it("lists every lane open to other machines, paused or not", () => {
      const running = [
        { projectId: "proj", slot: 0, agentId: "claude" },
        { projectId: "proj", slot: 1, agentId: "codex" },
        { projectId: "other", slot: 0, agentId: "claude" },
      ];
      const h = harness({ acceptsRemoteMessages: () => true, listRunningLanes: () => running });
      h.run("proj", 0, "s1");
      h.run("proj", 1, "s2");
      h.policy.declineRun(lane("proj", 1), SHELL_A);
      h.policy.setPaused(true);
      expect(h.policy.listOpen().map((run) => run.sessionId)).toEqual(["s1"]);
    });
  });
});
