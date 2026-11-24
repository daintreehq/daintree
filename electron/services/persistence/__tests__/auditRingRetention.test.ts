import { describe, expect, it } from "vitest";
import { AUDIT_RING_RETENTION, normalizeAuditRingMaxRecords } from "../auditRingRetention.js";
import type { AuditRingName } from "../auditRingStore.js";

const RINGS = Object.keys(AUDIT_RING_RETENTION) as AuditRingName[];

describe("normalizeAuditRingMaxRecords", () => {
  it.each(RINGS)("keeps %s within its bounds", (ring) => {
    const { min, max } = AUDIT_RING_RETENTION[ring];
    expect(normalizeAuditRingMaxRecords(ring, min - 1)).toBe(min);
    expect(normalizeAuditRingMaxRecords(ring, -5)).toBe(min);
    expect(normalizeAuditRingMaxRecords(ring, max + 1)).toBe(max);
  });

  it.each(RINGS)("uses %s's fallback for a missing or non-finite setting", (ring) => {
    const { fallback } = AUDIT_RING_RETENTION[ring];
    for (const value of [undefined, null, "750", NaN, Infinity, -Infinity]) {
      expect(normalizeAuditRingMaxRecords(ring, value), String(value)).toBe(fallback);
    }
  });

  it("rounds a fractional setting down", () => {
    expect(normalizeAuditRingMaxRecords("pluginAuditLog", 750.9)).toBe(750);
    expect(normalizeAuditRingMaxRecords("mcpAuditLog", 1234.5)).toBe(1234);
  });

  it("holds run history to one fixed length whatever is configured", () => {
    const fixed = normalizeAuditRingMaxRecords("runHistoryRecords", undefined);
    expect(normalizeAuditRingMaxRecords("runHistoryRecords", 1)).toBe(fixed);
    expect(normalizeAuditRingMaxRecords("runHistoryRecords", 10_000)).toBe(fixed);
  });
});
