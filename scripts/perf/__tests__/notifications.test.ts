import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";

import {
  buildFleet,
  buildIdleCorpus,
  buildRoutingScript,
  gradeIdleSweep,
  gradeRoutingCase,
  NotificationClock,
  waitingReasonFor,
  type StubNativeNotification,
} from "../lib/notificationFixture";
import { notificationScenarios } from "../scenarios/notifications";
import { classifyMetric } from "../lib/comparability";

/**
 * Unit coverage for the ORACLES, not the scenarios.
 *
 * PERF-320..325 load the real main-process notification graph behind module
 * hooks that Vitest does not fire (Vite resolves imports itself), and they are
 * exercised by `npm run perf`. What is worth testing here is the thing the
 * perf run cannot check for itself: every predicate in this family compares
 * what the subject produced against a declaration held in the fixture, so a
 * declaration that quietly stops describing the corpus turns six miss counts
 * into decoration that reports zero forever.
 */

function notification(title: string, body: string): StubNativeNotification {
  return { title, body, silent: true, click: () => undefined };
}

describe("routing expectation table", () => {
  const fleet = buildFleet(48);
  const cases = buildRoutingScript(fleet);

  it("covers both locations for both watch states", () => {
    // Escalation is gated on the dock and NOT on the watch set, so the gate
    // battery needs an unwatched docked panel to grade that pair at all.
    const combos = new Set(fleet.map((t) => `${t.location}:${t.watched}`));
    expect([...combos].sort()).toEqual(["dock:false", "dock:true", "grid:false", "grid:true"]);
  });

  it("declares eight transitions per terminal", () => {
    expect(cases).toHaveLength(fleet.length * 8);
  });

  it("expects a notification only where the product routes one", () => {
    const expectingCases = cases.filter((c) => c.expected !== null);
    // Three notified transitions per watched panel: waiting, completed, exited.
    expect(expectingCases).toHaveLength(fleet.filter((t) => t.watched).length * 3);

    const unwatchedIds = new Set(fleet.filter((t) => !t.watched).map((t) => t.id));
    const unwatchedExpectations = cases
      .filter((c) => unwatchedIds.has(c.input.terminalId))
      .filter((c) => c.expected !== null);
    expect(unwatchedExpectations).toEqual([]);
  });

  it("gives every case a stated reason", () => {
    expect(cases.filter((c) => c.reason.trim().length === 0)).toEqual([]);
  });

  it("names the waiting reason in the copy rather than collapsing to the generic body", () => {
    const bodies = new Map<string, string>();
    for (const routingCase of cases) {
      if (routingCase.expected?.title !== "Agent waiting") continue;
      bodies.set(routingCase.input.waitingReason ?? "none", routingCase.expected.body);
    }
    expect(bodies.get("approval")).toMatch(/is waiting for approval$/);
    expect(bodies.get("question")).toMatch(/asked a question$/);
    expect(bodies.get("error")).toMatch(/is blocked by an error$/);
    // `prompt` is the classifier's evidence-free fallback and must stay generic.
    expect(bodies.get("prompt")).toMatch(/is waiting for input$/);
    expect(waitingReasonFor(0)).toBe("approval");
  });
});

describe("routing grader", () => {
  const expected = { title: "Agent waiting", body: "claude is waiting for approval" };

  it("scores a healthy case at zero", () => {
    expect(gradeRoutingCase(expected, [notification(expected.title, expected.body)])).toEqual({
      missed: 0,
      spurious: 0,
      bodyMismatch: 0,
    });
    expect(gradeRoutingCase(null, [])).toEqual({ missed: 0, spurious: 0, bodyMismatch: 0 });
  });

  it("catches the notify-nothing direction", () => {
    expect(gradeRoutingCase(expected, []).missed).toBe(1);
  });

  it("catches the notify-everything direction", () => {
    expect(gradeRoutingCase(null, [notification("Agent waiting", "anything")]).spurious).toBe(1);
    expect(
      gradeRoutingCase(expected, [
        notification(expected.title, expected.body),
        notification(expected.title, expected.body),
      ]).spurious
    ).toBe(1);
  });

  it("catches a right decision with the wrong copy", () => {
    const grade = gradeRoutingCase(expected, [
      notification("Agent waiting", "gemini is waiting for input"),
    ]);
    expect(grade.bodyMismatch).toBe(1);
    expect(grade.missed).toBe(0);
  });
});

describe("idle corpus", () => {
  const nowMs = 1_800_000_000_000;
  const corpus = buildIdleCorpus(40, 6, nowMs, 60);

  it("expects exactly the eligible projects and nothing else", () => {
    expect(corpus.expectedNotifiedIds.length).toBe(5);
    for (const id of corpus.expectedNotifiedIds) {
      const entry = corpus.cases.find((c) => c.projectId === id);
      expect(entry?.kind).toBe("eligible");
    }
    expect(corpus.cases.filter((c) => c.expectNotified && c.kind !== "eligible")).toEqual([]);
  });

  it("writes the disqualifying condition each verdict claims", () => {
    // Read back off the produced rows, not off the spec: an oracle derived from
    // the same object it grades proves nothing.
    const rowsFor = (kind: string) => {
      const ids = new Set(corpus.cases.filter((c) => c.kind === kind).map((c) => c.projectId));
      return corpus.terminals.filter((row) => ids.has(row.projectId));
    };

    expect(rowsFor("no-terminals")).toEqual([]);
    expect(rowsFor("pty-less").every((row) => row.hasPty === false)).toBe(true);
    expect(
      rowsFor("unknown-activity").every(
        (row) => row.lastInputTime === undefined && row.lastOutputTime === undefined
      )
    ).toBe(true);
    expect(rowsFor("active-agent").some((row) => row.agentState === "working")).toBe(true);
    expect(
      rowsFor("recently-active").some((row) => nowMs - (row.lastOutputTime ?? 0) < 3_600_000)
    ).toBe(true);
    expect(rowsFor("eligible").every((row) => nowMs - (row.lastOutputTime ?? 0) >= 3_600_000)).toBe(
      true
    );
  });

  it("names the on-screen and dismissed projects it expects the sweep to skip", () => {
    expect(corpus.onScreenProjectIds.length).toBe(5);
    expect(corpus.dismissedProjectIds.length).toBe(5);
    for (const id of [...corpus.onScreenProjectIds, ...corpus.dismissedProjectIds]) {
      expect(corpus.expectedNotifiedIds).not.toContain(id);
    }
  });

  it("gives every project a stated reason", () => {
    expect(corpus.cases.filter((c) => c.reason.trim().length === 0)).toEqual([]);
  });
});

describe("idle sweep grader", () => {
  it("catches a sweep that nudged nothing", () => {
    expect(gradeIdleSweep(["a", "b"], new Set()).missed).toBe(2);
  });

  it("catches a sweep that nudged everything", () => {
    const grade = gradeIdleSweep(["a"], new Set(["a", "b", "c"]));
    expect(grade.spurious).toBe(2);
    expect(grade.missed).toBe(0);
  });

  it("scores an exact sweep at zero", () => {
    expect(gradeIdleSweep(["a", "b"], new Set(["b", "a"]))).toEqual({ missed: 0, spurious: 0 });
  });
});

describe("notification clock", () => {
  it("fires timers in schedule order and leaves performance.now alone", async () => {
    const clock = new NotificationClock();
    const realNow = performance.now();
    clock.install();
    try {
      const fired: string[] = [];
      setTimeout(() => fired.push("late"), 2_000);
      setTimeout(() => fired.push("early"), 200);
      const cancelled = setTimeout(() => fired.push("cancelled"), 100);
      clearTimeout(cancelled);

      await clock.tick(300);
      expect(fired).toEqual(["early"]);
      expect(clock.pendingTimers()).toBe(1);

      await clock.tick(2_000);
      expect(fired).toEqual(["early", "late"]);
      expect(clock.pendingTimers()).toBe(0);

      // Virtual time moved 2.3 virtual seconds; the measuring clock must not
      // have followed it, or every duration this family reports is fiction.
      expect(performance.now() - realNow).toBeLessThan(2_000);
      expect(Date.now()).toBeGreaterThanOrEqual(1_800_000_000_000);
    } finally {
      clock.uninstall();
    }
    expect(Date.now()).toBeLessThan(1_800_000_000_000);
  });
});

describe("notification scenario declarations", () => {
  it("implements the six declared ids", () => {
    expect(notificationScenarios.map((scenario) => scenario.id)).toEqual([
      "PERF-320",
      "PERF-321",
      "PERF-322",
      "PERF-323",
      "PERF-324",
      "PERF-325",
    ]);
  });

  it("declares a correctness predicate of count-class metrics on every scenario", () => {
    for (const scenario of notificationScenarios) {
      expect(scenario.correctness?.length ?? 0).toBeGreaterThan(0);
      for (const metric of scenario.correctness ?? []) {
        expect(`${scenario.id}:${metric}:${classifyMetric(metric)}`).toBe(
          `${scenario.id}:${metric}:count`
        );
      }
    }
  });

  it("states that no OS notification is sent", () => {
    const family = notificationScenarios.map((s) => s.description).join(" ");
    expect(family).toMatch(/No OS notification is ever sent|macOS-only/);
  });
});
