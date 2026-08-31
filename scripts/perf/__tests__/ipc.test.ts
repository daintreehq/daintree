import { describe, expect, it } from "vitest";
import {
  countDeliveredLines,
  liveUtilityHostCount,
  nonceRequestId,
  serializedBytes,
} from "../lib/ipcFixture";
import { ipcScenarios } from "../scenarios/ipc";

/**
 * Unit coverage for the accounting helpers only. The scenarios themselves fork
 * real utility hosts and are exercised by `npm run perf`, not by vitest — a
 * test suite that boots the workspace-host and the pty-host per shard would
 * cost more than it proves.
 */
describe("ipc fixture accounting", () => {
  it("reports a finite byte size for anything, including values v8 cannot clone", () => {
    expect(serializedBytes({ type: "ready" })).toBeGreaterThan(0);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    // v8.serialize handles cycles; a function does not survive JSON either.
    expect(Number.isFinite(serializedBytes(circular))).toBe(true);
    expect(Number.isFinite(serializedBytes(() => undefined))).toBe(true);
    expect(Number.isFinite(serializedBytes(undefined))).toBe(true);
  });

  it("byte size grows with payload size", () => {
    const small = serializedBytes({ type: "data", id: "t", data: "x".repeat(10) });
    const large = serializedBytes({ type: "data", id: "t", data: "x".repeat(10_000) });
    expect(large).toBeGreaterThan(small + 9_000);
  });

  it("counts only the distinct expected line indices, healing chunk splits", () => {
    const lines = Array.from({ length: 5 }, (_, i) => `PERFLINE-${i + 1}-xxxx\n`);
    expect(countDeliveredLines(lines.join(""), 5)).toBe(5);

    // A marker split across two chunks is healed by concatenating first.
    const split = ["PERFLINE-1-xxxx\nPERFL", "INE-2-xxxx\n"].join("");
    expect(countDeliveredLines(split, 2)).toBe(2);

    // Duplicates are not extra lines, and out-of-range indices are not ours.
    expect(countDeliveredLines("PERFLINE-1-a PERFLINE-1-a PERFLINE-99-a", 2)).toBe(1);
    expect(countDeliveredLines("", 2000)).toBe(0);
  });

  it("mints request nonces long enough to be a real payload check", () => {
    const a = nonceRequestId("perf-044-0");
    const b = nonceRequestId("perf-044-0");
    expect(a).not.toBe(b);
    expect(a.startsWith("perf-044-0-")).toBe(true);
    expect(a.length).toBe("perf-044-0-".length + 64);
  });
});

describe("ipc scenario family", () => {
  it("no longer ships the in-process broker scenarios", () => {
    const ids = ipcScenarios.map((scenario) => scenario.id);
    // PERF-040/041 drove a RequestResponseBroker inside this process and were
    // named as though they crossed a boundary. PERF-044 replaced them.
    expect(ids).not.toContain("PERF-040");
    expect(ids).not.toContain("PERF-041");
    expect(ids).toEqual(["PERF-042", "PERF-043", "PERF-044", "PERF-045", "PERF-046"]);
  });

  it("importing the family forks no host processes", () => {
    // Lazy-fixture rule: a host is forked inside run(), never at import time.
    expect(liveUtilityHostCount()).toBe(0);
  });
});
