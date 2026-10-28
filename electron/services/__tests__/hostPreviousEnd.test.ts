import { describe, expect, it } from "vitest";
import type { CrashLogEntry, PendingCrash } from "../../../shared/types/ipc/crashRecovery.js";
import {
  captureHostPreviousEnd,
  getHostPreviousEnd,
  readHostPreviousEnd,
} from "../hostPreviousEnd.js";

function pending(entry: Partial<CrashLogEntry>): PendingCrash {
  return {
    logPath: "/crashes/crash-1.json",
    hasBackup: false,
    entry: {
      id: "crash-1",
      timestamp: 5_000,
      appVersion: "1.0.0",
      platform: "linux",
      osVersion: "6",
      arch: "x64",
      errorStack: "secret stack",
      ...entry,
    },
  };
}

describe("readHostPreviousEnd", () => {
  it("says nothing when the previous process left no crash record, as a planned quit does", () => {
    expect(readHostPreviousEnd(null)).toBeUndefined();
  });

  it("takes the watchdog's own kill time, reason and missed beats, and nothing else of the record", () => {
    expect(
      readHostPreviousEnd(
        pending({
          crashCause: "external-kill",
          cause: "watchdog-deadlock",
          watchdogKilledAt: 4_200,
          watchdogKillReason: "unresponsive-under-pressure",
          watchdogMissedBeats: 12,
          watchdogPressureEvidence: "  main had no memory-pressure reading ",
        })
      )
    ).toEqual({
      crashCause: "external-kill",
      cause: "watchdog-deadlock",
      watchdogKillReason: "unresponsive-under-pressure",
      missedBeats: 12,
      pressureEvidence: "main had no memory-pressure reading",
      at: 4_200,
    });
  });

  it("takes a watchdog kill with no heuristic cause as an external kill, and cuts a long note to the schema's bound", () => {
    const end = readHostPreviousEnd(
      pending({ cause: "watchdog-deadlock", watchdogPressureEvidence: "x".repeat(400) })
    );
    expect(end?.crashCause).toBe("external-kill");
    expect(end?.pressureEvidence).toHaveLength(256);
  });

  it("says nothing it can't date", () => {
    expect(readHostPreviousEnd(pending({ timestamp: Number.NaN }))).toBeUndefined();
  });

  it("reports an end the hold policy doesn't hold for, so a crash never reads as a planned restart", () => {
    expect(
      readHostPreviousEnd(
        pending({ crashCause: "native-crash", watchdogKillReason: "unresponsive" })
      )
    ).toEqual({ crashCause: "native-crash", at: 5_000 });
    expect(readHostPreviousEnd(pending({}))).toEqual({ crashCause: "unknown", at: 5_000 });
  });

  it("is kept for the process's lifetime once captured at boot", () => {
    captureHostPreviousEnd(pending({ crashCause: "power-loss" }));
    expect(getHostPreviousEnd()).toEqual({ crashCause: "power-loss", at: 5_000 });
    captureHostPreviousEnd(null);
    expect(getHostPreviousEnd()).toBeUndefined();
  });
});
