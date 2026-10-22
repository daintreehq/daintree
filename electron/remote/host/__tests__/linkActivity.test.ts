import { describe, expect, it } from "vitest";
import type { DriveLeaseObservation } from "../../../../shared/types/remoteHosts.js";
import { composeLinkActivity, nameLeases } from "../linkActivity.js";
import { LinkActivitySchema, MAX_ACTIVITY_DRIVERS } from "../../metrics/linkMethods.js";
import { MAX_PROJECT_NAME_CHARS } from "../../link/schemas.js";

function lease(
  projectId: string,
  clientId: string,
  acquiredAt: number,
  away: number | null = null
): DriveLeaseObservation {
  return {
    projectId,
    holder: {
      leaseId: acquiredAt,
      endpointId: `${clientId}:e1`,
      clientId,
      clientName: "Greg's Mac Studio",
      isHostLocal: false,
      acquiredAt,
    },
    state: away === null ? "live" : "away",
    awayUntil: away,
  };
}

const client = (clientId: string) => ({
  clientId,
  clientName: "Greg's Mac Studio",
  platform: "darwin" as const,
});

const NAMES: Record<string, string> = { p1: "daintree", p2: "site" };

describe("composeLinkActivity", () => {
  it("names each lease, newest control first, and gives each attached launch what it drives", () => {
    const activity = composeLinkActivity({
      now: 5_000,
      listeningSince: 1_000,
      version: "0.46.0",
      commit: "abc",
      history: { events: [], truncated: false },
      // Two launches of one machine: the earlier one is away inside its reservation.
      leases: [lease("p1", "launch-1", 2_000, 6_000), lease("p2", "launch-2", 3_000)],
      projectName: (projectId) => NAMES[projectId] ?? null,
      sessions: [{ sessionId: "s2", client: client("launch-2"), connectedAt: 2_900 }],
    });
    expect(activity.drivers.map((driver) => [driver.projectName, driver.state])).toEqual([
      ["site", "live"],
      ["daintree", "away"],
    ]);
    expect(activity.attached).toEqual([
      {
        sessionId: "s2",
        clientId: "launch-2",
        clientName: "Greg's Mac Studio",
        platform: "darwin",
        connectedAt: 2_900,
        drivingProjectIds: ["p2"],
      },
    ]);
    expect(LinkActivitySchema.safeParse(activity).success).toBe(true);
  });

  it("leaves out a lease a Shell would refuse, rather than costing it the whole answer", () => {
    const restored = lease("p2", "c".repeat(256), 2);
    restored.holder.endpointId = `restored:${restored.holder.clientId}`;
    expect(nameLeases([lease("p1", "c1", 1), restored], () => "x").map((d) => d.projectId)).toEqual(
      ["p1"]
    );
  });

  it("keeps a lease for a project the host no longer has, unnamed", () => {
    expect(nameLeases([lease("gone", "c1", 1)], () => null)[0]).toMatchObject({
      projectId: "gone",
      projectName: null,
    });
  });

  it("stays inside what a Shell's schema accepts, however much the host holds", () => {
    const leases = Array.from({ length: MAX_ACTIVITY_DRIVERS + 5 }, (_, i) =>
      lease(`p${i}`, "c1", i)
    );
    const activity = composeLinkActivity({
      now: 1,
      listeningSince: null,
      version: "0.46.0",
      commit: "abc",
      history: { events: [], truncated: true },
      leases,
      projectName: () => "x".repeat(MAX_PROJECT_NAME_CHARS * 2),
      sessions: [],
    });
    expect(activity.drivers).toHaveLength(MAX_ACTIVITY_DRIVERS);
    expect(LinkActivitySchema.safeParse(activity).success).toBe(true);
  });
});

describe("LinkActivitySchema", () => {
  it("drops an event a newer host names that this Shell doesn't know, and keeps the rest", () => {
    const parsed = LinkActivitySchema.parse({
      observedAt: 1,
      listeningSince: 1,
      version: "0.47.0",
      commit: "def",
      events: [
        { kind: "host-moved", at: 2, clientId: "c1", clientName: "n" },
        {
          kind: "session-started",
          at: 1,
          clientId: "c1",
          clientName: "n",
          sessionId: "s1",
          previousNotResumed: null,
        },
      ],
      eventsTruncated: false,
      drivers: [],
      attached: [],
    });
    expect(parsed.events.map((event) => event.kind)).toEqual(["session-started"]);
  });
});
