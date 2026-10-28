import { describe, expect, it } from "vitest";
import type { HostDriverObservation } from "@shared/types/remoteHosts";
import { formatHostTime } from "@/components/Hosts/hostTime";
import {
  describeAttachedShell,
  describeDriverRow,
  describeLinkEvent,
  shellName,
} from "../hostSessionsModel";

const NOW = new Date(2026, 9, 22, 11, 33, 0).getTime();
const at = (h: number, m: number, s: number) => new Date(2026, 9, 22, h, m, s).getTime();
const SELF = { clientId: "launch-2", clientName: "Greg's Mac Studio" };
const time = (ms: number) => formatHostTime(ms, NOW);

function driver(overrides: Partial<HostDriverObservation> = {}): HostDriverObservation {
  return {
    projectId: "p1",
    projectName: "daintree",
    holder: {
      leaseId: 1,
      endpointId: "s1:e1",
      clientId: "launch-1",
      clientName: "Greg's Mac Studio",
      isHostLocal: false,
      acquiredAt: at(11, 27, 2),
    },
    state: "away",
    awayUntil: at(11, 32, 53),
    ...overrides,
  };
}

describe("shellName", () => {
  it("marks this launch, and tells another launch under the same name apart from it", () => {
    expect(shellName("launch-2", "Greg's Mac Studio", SELF)).toBe(
      "Greg's Mac Studio (this launch)"
    );
    expect(shellName("launch-1", "Greg's Mac Studio", SELF)).toBe(
      "Greg's Mac Studio (another launch)"
    );
    expect(shellName("other", "studio-02", SELF)).toBe("studio-02");
    expect(shellName("launch-1", "Greg's Mac Studio", null)).toBe("Greg's Mac Studio");
  });
});

describe("describeDriverRow", () => {
  it("says an earlier launch still holds a project, and until when", () => {
    expect(describeDriverRow(driver(), "studio-01", SELF, NOW)).toEqual({
      label: "daintree",
      description: `Greg's Mac Studio (another launch) · away · held for it until ${time(at(11, 32, 53))}`,
    });
  });

  it("says when a live holder took control, and names the host's own screen", () => {
    const live = driver({
      state: "live",
      awayUntil: null,
      holder: { ...driver().holder, clientId: "local", clientName: "studio-01", isHostLocal: true },
    });
    expect(describeDriverRow(live, "studio-01", SELF, NOW).description).toBe(
      `studio-01's own screen · in control since ${time(at(11, 27, 2))}`
    );
    expect(
      describeDriverRow(driver({ projectName: null, awayUntil: null }), "studio-01", SELF, NOW)
    ).toEqual({
      label: "Unknown project",
      description: "Greg's Mac Studio (another launch) · away",
    });
  });
});

describe("describeAttachedShell", () => {
  it("says when a launch's session started, which a resume keeps, and what it drives", () => {
    const shell = {
      sessionId: "s2",
      clientId: "launch-2",
      clientName: "Greg's Mac Studio",
      platform: "darwin" as const,
      connectedAt: at(11, 32, 41),
      drivingProjectIds: ["p1"],
    };
    expect(describeAttachedShell(shell, [driver()], SELF, NOW)).toEqual({
      label: "Greg's Mac Studio (this launch)",
      description: `Session started ${time(at(11, 32, 41))} · driving daintree`,
    });
    const many = { ...shell, drivingProjectIds: ["a", "b", "c", "d"] };
    expect(describeAttachedShell(many, [], SELF, NOW).description).toContain("driving 4 projects");
    const none = { ...shell, drivingProjectIds: [] };
    expect(describeAttachedShell(none, [], SELF, NOW).description).toContain(
      "not driving a project"
    );
  });
});

describe("describeLinkEvent", () => {
  const seen = { at: at(11, 27, 5), clientId: "launch-1", clientName: "Greg's Mac Studio" };

  it("says a new session's previous one wasn't resumed, and what the host said about it", () => {
    expect(
      describeLinkEvent(
        {
          ...seen,
          kind: "session-started",
          sessionId: "s2",
          previousNotResumed: "session-unknown",
        },
        SELF,
        NOW
      )
    ).toEqual({
      label: "New session; the previous one wasn't resumed: the host didn't know it",
      description: `Greg's Mac Studio (another launch) · ${time(seen.at)}`,
    });
  });

  it("words drops, resumes and ends as the host saw them", () => {
    const label = (event: Parameters<typeof describeLinkEvent>[0]) =>
      describeLinkEvent(event, SELF, NOW).label;
    expect(
      label({
        ...seen,
        kind: "link-dropped",
        sessionId: "s1",
        reason: "socket closed",
        by: "transport",
      })
    ).toBe("Link dropped: socket closed");
    expect(label({ ...seen, kind: "session-resumed", sessionId: "s1", overLiveLink: true })).toBe(
      "Session resumed over a new link"
    );
    expect(
      label({
        ...seen,
        kind: "session-ended",
        sessionId: "s1",
        cause: "grace-expired",
        reason: null,
      })
    ).toBe("Session ended: not resumed in time");
    expect(
      label({
        ...seen,
        kind: "session-ended",
        sessionId: "s1",
        cause: "goodbye",
        reason: "app quit",
      })
    ).toBe("Session ended: closed by the Shell (app quit)");
  });

  it("counts a retried refusal and says when it last happened", () => {
    expect(
      describeLinkEvent(
        {
          ...seen,
          kind: "refused",
          reason: "version-mismatch",
          detail: "version 0.45.0 does not match 0.46.0",
          count: 3,
          lastAt: at(11, 28, 0),
        },
        SELF,
        NOW
      )
    ).toEqual({
      label: "Refused: different build (3 times)",
      description: `Greg's Mac Studio (another launch) · ${time(seen.at)}, last at ${time(at(11, 28, 0))} · version 0.45.0 does not match 0.46.0`,
    });
  });
});
