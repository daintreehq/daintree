import { beforeEach, describe, expect, it, vi } from "vitest";

const notify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify }));

import { describeHostPreviousEnd, noticeUncleanHostRestart } from "../hostRestartNotice";

beforeEach(() => notify.mockClear());

describe("describeHostPreviousEnd", () => {
  it("quotes the watchdog's pressure evidence and missed beats when it recorded them", () => {
    expect(
      describeHostPreviousEnd({
        crashCause: "external-kill",
        cause: "watchdog-deadlock",
        watchdogKillReason: "unresponsive-under-pressure",
        missedBeats: 12,
        at: 1,
      })
    ).toBe("Its watchdog stopped Daintree under memory pressure after 12 missed heartbeats.");
    expect(
      describeHostPreviousEnd({
        crashCause: "external-kill",
        cause: "watchdog-deadlock",
        watchdogKillReason: "unresponsive",
        at: 1,
      })
    ).toBe("Its watchdog stopped Daintree.");
  });

  it("never claims memory pressure the record didn't see", () => {
    expect(describeHostPreviousEnd({ crashCause: "external-kill", at: 1 })).not.toMatch(/memory/);
    expect(describeHostPreviousEnd({ crashCause: "native-crash", at: 1 })).not.toMatch(/memory/);
  });
});

describe("noticeUncleanHostRestart", () => {
  const end = {
    crashCause: "external-kill" as const,
    cause: "watchdog-deadlock" as const,
    watchdogKillReason: "unresponsive-under-pressure" as const,
    at: 1,
  };

  it("attributes the end to the host and counts what came back, one notice per host", () => {
    noticeUncleanHostRestart({ hostId: "h-3", hostName: "studio-03" }, "proj-1", end, {
      relaunched: 1,
      held: 10,
    });

    expect(notify).toHaveBeenCalledTimes(1);
    const payload = notify.mock.calls[0]![0];
    expect(payload.title).toContain("studio-03");
    expect(payload.message).toBe(
      "Its watchdog stopped Daintree under memory pressure. Relaunched 1 agent. 10 agents wait to be resumed."
    );
    expect(payload.placement).toBe("grid-bar");
    expect(payload.context).toMatchObject({ projectId: "proj-1" });

    noticeUncleanHostRestart({ hostId: "h-3", hostName: "studio-03" }, "proj-2", end, {
      relaunched: 0,
      held: 0,
    });
    expect(notify.mock.calls[1]![0].supersedeKey).toBe(payload.supersedeKey);
    expect(notify.mock.calls[1]![0].message).toBe(
      "Its watchdog stopped Daintree under memory pressure."
    );
  });
});
