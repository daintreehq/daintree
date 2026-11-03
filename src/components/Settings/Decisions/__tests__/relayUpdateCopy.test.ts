import { describe, expect, it } from "vitest";
import type { DecisionsRelayCheck } from "@shared/types/decisions";
import { describeRelayUpdateOutcome, relayVersionAfter } from "../relayUpdateCopy";

const ORIGIN = "https://decisions.example.workers.dev";

describe("relay update outcome", () => {
  it("reads the relay's version from a check that saw one, and none otherwise", () => {
    const claimed: DecisionsRelayCheck = {
      result: "claimed",
      origin: ORIGIN,
      compatibility: {
        relay: { protocolMin: 1, protocolMax: 1, workerVersion: "0.3.0" },
        daintree: { protocolMin: 1, protocolMax: 1, workerVersion: "0.2.0" },
        diverges: true,
      },
    };

    expect(relayVersionAfter(claimed)).toBe("0.3.0");
    expect(
      relayVersionAfter({ result: "unreachable", origin: ORIGIN, endpoint: "health", reason: "dns" })
    ).toBeNull();
    expect(relayVersionAfter(null)).toBeNull();
  });

  it("names the new version when a clean exit left the relay on another", () => {
    const outcome = describeRelayUpdateOutcome({ reason: "exited", exitCode: 0 }, "0.2.0", "0.3.0");

    expect(outcome.severity).toBe("success");
    expect(outcome.label).toContain("0.3.0");
    expect(outcome.detail).toContain("0.2.0");
  });

  it("claims no cause when a clean exit left the relay where it was", () => {
    const outcome = describeRelayUpdateOutcome({ reason: "exited", exitCode: 0 }, "0.2.0", "0.2.0");

    expect(outcome.severity).toBe("info");
    expect(outcome.detail).toMatch(/still runs 0\.2\.0/);
    expect(outcome.detail).toMatch(/terminal/);
  });

  it("says a failure failed, with its code and the version the relay answers with now", () => {
    const unchanged = describeRelayUpdateOutcome(
      { reason: "exited", exitCode: 1 },
      "0.2.0",
      "0.2.0"
    );
    const moved = describeRelayUpdateOutcome({ reason: "exited", exitCode: 1 }, "0.2.0", "0.3.0");

    expect(unchanged.severity).toBe("error");
    expect(unchanged.detail).toMatch(/still runs 0\.2\.0/);
    expect(unchanged.detail).toMatch(/exit code 1/);
    expect(moved.severity).toBe("error");
    expect(moved.detail).toMatch(/now runs 0\.3\.0/);
  });

  it("tells a stopped update from a failed one", () => {
    const stopped = describeRelayUpdateOutcome(
      { reason: "exited", exitCode: 130 },
      "0.2.0",
      "0.2.0"
    );

    expect(stopped.severity).toBe("warning");
    expect(stopped.label).not.toBe(
      describeRelayUpdateOutcome({ reason: "exited", exitCode: 1 }, "0.2.0", "0.2.0").label
    );
  });

  it("says the version couldn't be read rather than guessing at one", () => {
    for (const end of [
      { reason: "exited", exitCode: 0 },
      { reason: "exited", exitCode: 1 },
      { reason: "closed" },
    ] as const) {
      const outcome = describeRelayUpdateOutcome(end, "0.2.0", null);
      expect(outcome.detail).toMatch(/couldn't read the relay's version/);
      expect(outcome.severity).not.toBe("success");
    }
  });

  it("says nothing changed when the update's terminal never started", () => {
    const outcome = describeRelayUpdateOutcome({ reason: "not-started" }, "0.2.0", "0.2.0");

    expect(outcome.severity).toBe("error");
    expect(outcome.detail).toMatch(/nothing on the relay changed/);
  });
});
