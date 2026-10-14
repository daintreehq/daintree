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
  let nextGeneration = 0;
  const policy = new AssistantMessagingPolicy({
    getRunningLaneSession: (projectId, slot) => running.get(laneKey(projectId, slot)) ?? null,
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
  const end = (projectId: string, slot: number, sessionId: string) => {
    for (const listener of [...listeners]) {
      listener({ projectId, slot, sessionId, reason: "revoked" });
    }
  };
  return { policy, running, launchGenerations, enabledHosts, listeners, run, end };
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
});
