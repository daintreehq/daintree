import { describe, expect, it } from "vitest";
import type { HostRestartImpact } from "@shared/types/ipc/remoteHosts";
import {
  canWaitForIdle,
  connectionLabel,
  defaultHostName,
  localNameSuggestion,
  removeHostOutcome,
  restartConfirmLabel,
  restartImpactLines,
  restartTerminalCount,
} from "../hostLabels";

const unresolved = (name: string) =>
  `ssh: Could not resolve hostname ${name}: nodename nor servname provided, or not known`;

describe("localNameSuggestion", () => {
  it("suggests the .local name when ssh couldn't resolve the bare name that was entered", () => {
    expect(localNameSuggestion("greg@studio", unresolved("studio"))).toBe("greg@studio.local");
    expect(localNameSuggestion("studio", unresolved("studio"))).toBe("studio.local");
  });

  it("stays quiet when ssh failed on a different name: an alias's HostName or a jump host", () => {
    expect(localNameSuggestion("studio", unresolved("missing.internal"))).toBeNull();
    expect(localNameSuggestion("greg@studio", unresolved("bastion"))).toBeNull();
  });

  it("stays quiet for names with a domain, addresses, and other ssh failures", () => {
    expect(localNameSuggestion("greg@studio.lan", unresolved("studio.lan"))).toBeNull();
    expect(localNameSuggestion("[fe80::1]", unresolved("fe80::1"))).toBeNull();
    expect(
      localNameSuggestion("greg@studio", "ssh: connect to host studio port 22: Connection refused")
    ).toBeNull();
    expect(localNameSuggestion("greg@studio", null)).toBeNull();
  });
});

describe("defaultHostName", () => {
  it("names a machine by its first label, but keeps an address whole", () => {
    expect(defaultHostName("greg@studio.local")).toBe("studio");
    expect(defaultHostName("devbox")).toBe("devbox");
    expect(defaultHostName("greg@192.168.1.20")).toBe("192.168.1.20");
    expect(defaultHostName("100.64.0.3")).toBe("100.64.0.3");
  });
});

describe("connectionLabel", () => {
  it("says when an unreachable host was last seen relative to now, as the rest of the app does", () => {
    const now = Date.UTC(2026, 0, 10, 12);
    expect(
      connectionLabel({ status: "unreachable", lastSeenAt: now - 3 * 3_600_000, detail: null }, now)
    ).toBe("Unreachable · last seen 3 hours ago");
  });

  it("gives an unreachable host ssh's own words for why, and says Host mode is off when ssh got in", () => {
    expect(
      connectionLabel({
        status: "unreachable",
        lastSeenAt: null,
        detail: "ssh: connect to host studio port 22: Operation timed out",
      })
    ).toBe("Unreachable · never seen · ssh: connect to host studio port 22: Operation timed out");
    expect(connectionLabel({ status: "unreachable", lastSeenAt: null, detail: null })).toBe(
      "Unreachable · never seen"
    );
    expect(
      connectionLabel({
        status: "unreachable",
        lastSeenAt: null,
        detail: "Daintree isn't running in Host mode there (no host.json).",
        hostModeOff: true,
      })
    ).toBe("Daintree isn't running in Host mode there");
  });

  it("says when a link has stopped retrying until the user connects", () => {
    expect(
      connectionLabel({
        status: "unreachable",
        lastSeenAt: null,
        detail: "greg@studio: Permission denied (publickey).",
        stoppedRetrying: true,
      })
    ).toBe(
      "Unreachable · never seen · not retrying until you connect · greg@studio: Permission denied (publickey)."
    );
  });
});

describe("restart impact", () => {
  const detail = {
    projects: [
      { projectName: "api", terminals: 3, working: 1, waiting: 2 },
      { projectName: null, terminals: 1, working: 0, waiting: 0 },
    ],
    complete: false,
    operations: 2,
    otherShells: ["greg-air", "ci-box"],
    terminalIds: ["a", "b", "c", "d"],
    shellIds: ["1", "2"],
  };

  it("lists what a restart ends from the host's own inventory", () => {
    const impact = { detail, agents: null };
    expect(restartImpactLines(impact)).toEqual([
      "api: 3 terminals (agents 1 working, 2 waiting)",
      "Outside any project: 1 terminal",
      "Possibly more terminals: the host couldn't list them all",
      "2 operations still running",
      "Sessions from greg-air, ci-box",
    ]);
    expect(restartTerminalCount(impact)).toBe(4);
    expect(canWaitForIdle(impact)).toBe(true);
    expect(restartConfirmLabel(impact)).toBe("Update and end 4 terminals");
  });

  it("names what ends on the confirm button, never a zero terminal count", () => {
    const none: NonNullable<HostRestartImpact["detail"]> = {
      projects: [],
      complete: true,
      operations: 0,
      otherShells: [],
      terminalIds: [],
      shellIds: [],
    };
    const label = (over: Partial<typeof none>) =>
      restartConfirmLabel({ detail: { ...none, ...over }, agents: null });

    expect(label({ operations: 2 })).toBe("Update and end 2 operations");
    expect(label({ otherShells: ["greg-air"], shellIds: ["1"] })).toBe("Update and end 1 session");
    expect(label({ operations: 1, otherShells: ["greg-air", "ci-box"] })).toBe(
      "Update and end 1 operation and 2 sessions"
    );
    // Unlisted terminals may still be there, so it says terminals without a count.
    expect(label({ complete: false, operations: 1 })).toBe("Update and end terminals");
    expect(label({})).toBe("Update now");
    expect(restartConfirmLabel({ detail: null, agents: { working: 1, waiting: 0 } })).toBe(
      "Update and end terminals"
    );
  });

  it("falls back to an older host's counts, naming what it can't see", () => {
    const counts = { detail: null, agents: { working: 2, waiting: 1 } };
    expect(restartImpactLines(counts)[0]).toBe("2 agents working, 1 agent waiting");
    expect(restartTerminalCount(counts)).toBeNull();
    expect(canWaitForIdle(counts)).toBe(true);

    const refusal = { detail: null, agents: { working: 1, waiting: null } };
    expect(restartImpactLines(refusal)[0]).toBe(
      "1 agent working, whether any agents are waiting can't be seen"
    );
    // Waiting can't be seen, so "idle" can't be either.
    expect(canWaitForIdle(refusal)).toBe(false);

    const unknown = { detail: null, agents: null };
    expect(restartImpactLines(unknown)).toEqual([
      "Every terminal there: the host couldn't say what is running",
    ]);
    expect(canWaitForIdle(unknown)).toBe(false);
  });
});

describe("removeHostOutcome", () => {
  it("promises a remote machine keeps running", () => {
    const outcome = removeHostOutcome({ kind: "ssh", target: "studio" }, "studio-01");
    expect(outcome.label).toBe("Projects and Daintree on studio-01 keep running");
    expect(outcome.sentence).toBe("Projects and Daintree on studio-01 keep running.");
  });

  it("says a WSL distro's terminals and agents end once WSL stops it", () => {
    const outcome = removeHostOutcome({ kind: "wsl", distro: "Ubuntu-24.04" }, "Ubuntu");
    expect(outcome.label).toBe("Terminals and agents in Ubuntu end once WSL stops it");
    expect(outcome.sentence).toContain("Daintree stops keeping Ubuntu running");
    expect(outcome.sentence).not.toContain("keep running.");
  });
});
