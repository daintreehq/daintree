import { beforeEach, describe, expect, it, vi } from "vitest";

const notify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify }));

import { describeHostPreviousEnd, noticeUncleanHostRestart } from "../hostRestartNotice";

beforeEach(() => notify.mockClear());

describe("describeHostPreviousEnd", () => {
  it("quotes the watchdog's missed beats and its own note on why it waited", () => {
    expect(
      describeHostPreviousEnd({
        crashCause: "external-kill",
        cause: "watchdog-deadlock",
        watchdogKillReason: "unresponsive-under-pressure",
        missedBeats: 12,
        pressureEvidence: "main reported memory pressure",
        at: 1,
      })
    ).toBe(
      "Its watchdog stopped Daintree after 12 missed heartbeats. It had waited longer because main reported memory pressure."
    );
  });

  it("never claims memory pressure from the kill reason alone", () => {
    const said = describeHostPreviousEnd({
      crashCause: "external-kill",
      cause: "watchdog-deadlock",
      watchdogKillReason: "unresponsive-under-pressure",
      at: 1,
    });
    expect(said).toBe("Its watchdog stopped Daintree.");
    expect(describeHostPreviousEnd({ crashCause: "external-kill", at: 1 })).not.toMatch(/memory/);
  });

  it("names each other recorded cause apart from the watchdog's", () => {
    const causes = [
      "uncaught-exception",
      "native-crash",
      "power-loss",
      "suspended-then-lost",
      "external-kill",
      "unknown",
    ] as const;
    const said = causes.map((crashCause) => describeHostPreviousEnd({ crashCause, at: 1 }));
    expect(new Set(said).size).toBe(causes.length);
    for (const line of said) expect(line).not.toMatch(/watchdog/);
  });
});

describe("noticeUncleanHostRestart", () => {
  const end = {
    crashCause: "external-kill" as const,
    cause: "watchdog-deadlock" as const,
    pressureEvidence: "main reported memory pressure",
    at: 1,
  };

  it("attributes the end to the host and counts what came back", () => {
    noticeUncleanHostRestart({ hostId: "h-3", hostName: "studio-03" }, "proj-1", end, {
      relaunched: 1,
      held: 10,
    });

    expect(notify).toHaveBeenCalledTimes(1);
    const payload = notify.mock.calls[0]![0];
    expect(payload.title).toContain("studio-03");
    expect(payload.message).toBe(
      "Its watchdog stopped Daintree. It had waited longer because main reported memory pressure. Relaunched 1 agent. 10 agents wait to be resumed."
    );
    expect(payload.placement).toBe("grid-bar");
    expect(payload.context).toMatchObject({ projectId: "proj-1" });
  });

  it("says only what came back, and nothing when nothing did", () => {
    const host = { hostId: "h-3", hostName: "studio-03" };
    noticeUncleanHostRestart(
      host,
      "proj-1",
      { crashCause: "native-crash", at: 1 },
      {
        relaunched: 0,
        held: 1,
      }
    );
    noticeUncleanHostRestart(
      host,
      "proj-1",
      { crashCause: "native-crash", at: 1 },
      {
        relaunched: 0,
        held: 0,
      }
    );
    expect(notify.mock.calls[0]![0].message).toMatch(/\. 1 agent waits to be resumed\.$/);
    expect(notify.mock.calls[0]![0].message).not.toMatch(/Relaunched/);
    expect(notify.mock.calls[1]![0].message).not.toMatch(/agent/);
  });

  it("keeps one notice per host, so a later restart replaces the last one's and another host's stays", () => {
    const counts = { relaunched: 0, held: 0 };
    noticeUncleanHostRestart({ hostId: "h-3", hostName: "studio-03" }, "proj-1", end, counts);
    noticeUncleanHostRestart({ hostId: "h-3", hostName: "studio-03" }, "proj-2", end, counts);
    noticeUncleanHostRestart({ hostId: "h-4", hostName: "studio-04" }, "proj-3", end, counts);
    const keys = notify.mock.calls.map((call) => call[0].supersedeKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });
});
