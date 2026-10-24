import { describe, expect, it } from "vitest";
import type { NotificationHistoryEntry } from "@/store/slices/notificationHistorySlice";
import {
  buildFlatRows,
  deriveTriageView,
  filterTriageEntries,
  groupByCorrelationId,
  type NotificationFilter,
} from "../notificationTriageModel";

let counter = 0;
function entry(overrides: Partial<NotificationHistoryEntry> = {}): NotificationHistoryEntry {
  return {
    id: `e-${++counter}`,
    type: "info",
    message: "m",
    timestamp: 1_000,
    seenAsToast: true,
    summarized: false,
    countable: true,
    archivedAt: null,
    ...overrides,
  };
}

function view(
  entries: NotificationHistoryEntry[],
  opts: {
    filter?: NotificationFilter;
    groupByContext?: boolean;
    lastClosedAt?: number;
    snoozedThreads?: Record<string, number>;
  } = {}
) {
  const filter = opts.filter ?? "all";
  const snoozedThreads = opts.snoozedThreads ?? {};
  const filteredEntries = filterTriageEntries(entries, filter, null, snoozedThreads);
  return deriveTriageView({
    entries,
    filteredEntries,
    filter,
    groupByContext: opts.groupByContext ?? false,
    lastClosedAt: opts.lastClosedAt ?? 0,
    snoozedThreads,
  });
}

describe("notificationTriageModel", () => {
  it("threads entries by correlation id in first-seen order", () => {
    const a1 = entry({ correlationId: "a", timestamp: 30 });
    const solo = entry({ timestamp: 20 });
    const a2 = entry({ correlationId: "a", timestamp: 10 });
    const groups = groupByCorrelationId([a1, solo, a2]);
    expect(groups.map((g) => g.correlationId)).toEqual(["a", undefined]);
    expect(groups[0]!.entries).toEqual([a1, a2]);
    expect(groups[0]!.latestTimestamp).toBe(30);
  });

  it("pins asking threads first, then severity, then recency, capped with overflow", () => {
    const now = Date.now();
    const oldError = entry({ type: "error", seenAsToast: false, timestamp: now - 5_000 });
    const newError = entry({ type: "error", seenAsToast: false, timestamp: now - 1_000 });
    const warning = entry({ type: "warning", seenAsToast: false, timestamp: now });
    const asking = entry({
      type: "warning",
      seenAsToast: false,
      timestamp: now - 9_000,
      context: { eventKind: "waiting" },
    });
    const result = view([oldError, newError, warning, asking]);
    expect(result.needsAttentionGroups.map((g) => g.entries[0]!.id)).toEqual([
      asking.id,
      newError.id,
      oldError.id,
    ]);
    expect(result.needsAttentionOverflow).toBe(1);
  });

  it("keeps the pinned rail out of Archived and Snoozed", () => {
    const err = entry({ type: "error", seenAsToast: false });
    expect(view([err], { filter: "archived" }).needsAttentionGroups).toEqual([]);
    expect(view([err], { filter: "snoozed" }).needsAttentionGroups).toEqual([]);
  });

  it("marks the first group newer than the last look, ungrouped only", () => {
    const older = entry({ timestamp: 100 });
    const newer = entry({ correlationId: "t", timestamp: 300 });
    const entries = [newer, older];
    expect(view(entries, { lastClosedAt: 200 }).dividerGroupId).toBe("t");
    expect(view(entries, { lastClosedAt: 200, groupByContext: true }).dividerGroupId).toBeNull();
    expect(view(entries, { lastClosedAt: 200, filter: "archived" }).dividerGroupId).toBeNull();
  });

  it("hides snoozed threads from All and shows them only in Snoozed", () => {
    const snoozed = entry({ correlationId: "s" });
    const plain = entry();
    const snoozedThreads = { s: Date.now() + 60_000 };
    expect(filterTriageEntries([snoozed, plain], "all", null, snoozedThreads)).toEqual([plain]);
    expect(filterTriageEntries([snoozed, plain], "snoozed", null, snoozedThreads)).toEqual([
      snoozed,
    ]);
  });

  it("keeps rows frozen into Unread after they are read", () => {
    const read = entry({ seenAsToast: true });
    const unread = entry({ seenAsToast: false });
    expect(filterTriageEntries([read, unread], "unread", null, {})).toEqual([unread]);
    expect(filterTriageEntries([read, unread], "unread", new Set([read.id]), {})).toEqual([
      read,
      unread,
    ]);
  });

  it("orders flat rows as the rail followed by every section's groups", () => {
    const err = entry({ type: "error", seenAsToast: false, correlationId: "x" });
    const errTail = entry({ type: "error", seenAsToast: false, correlationId: "x" });
    const p1 = entry({ context: { projectId: "p1" } });
    const p2 = entry({ context: { projectId: "p2" } });
    const result = view([err, errTail, p1, p2], { groupByContext: true });
    const rows = buildFlatRows(result.needsAttentionGroups, result.chronoSections);
    expect(rows.map((r) => r.key)).toEqual(["x", "x", p1.id, p2.id]);
    expect(rows[0]!.isThread).toBe(true);
    expect(rows[0]!.entryId).toBe(err.id);
  });
});
