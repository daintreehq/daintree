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

const ids = (list: NotificationHistoryEntry[]) => list.map((e) => e.id);

describe("notificationTriageModel", () => {
  it("threads entries by correlation id in first-seen order, dated by the newest member", () => {
    const b1 = entry({ correlationId: "b", timestamp: 10 });
    const a1 = entry({ correlationId: "a", timestamp: 20 });
    const solo = entry({ timestamp: 5 });
    const b2 = entry({ correlationId: "b", timestamp: 90 });
    const groups = groupByCorrelationId([b1, a1, solo, b2]);
    expect(groups.map((g) => g.correlationId)).toEqual(["b", "a", undefined]);
    expect(ids(groups[0]!.entries)).toEqual([b1.id, b2.id]);
    expect(groups[0]!.latestTimestamp).toBe(90);
    expect(ids(groups[2]!.entries)).toEqual([solo.id]);
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

  it("pins only unread, unarchived, unsnoozed warning-or-worse threads", () => {
    const pinned = entry({ type: "info", seenAsToast: false, correlationId: "t" });
    const pinnedTail = entry({ type: "error", seenAsToast: true, correlationId: "t" });
    const read = entry({ type: "error", seenAsToast: true });
    const archived = entry({ type: "error", seenAsToast: false, archivedAt: 5 });
    const info = entry({ type: "info", seenAsToast: false });
    const snoozed = entry({ type: "error", seenAsToast: false, correlationId: "s" });
    const result = view([pinned, pinnedTail, read, archived, info, snoozed], {
      snoozedThreads: { s: Date.now() + 60_000 },
    });
    expect(result.needsAttentionGroups.map((g) => g.correlationId)).toEqual(["t"]);
    expect(result.needsAttentionOverflow).toBe(0);
  });

  it("keeps the pinned rail out of Archived and Snoozed", () => {
    const err = entry({ type: "error", seenAsToast: false });
    for (const filter of ["archived", "snoozed"] as const) {
      const result = view([err], { filter });
      expect(result.needsAttentionGroups).toEqual([]);
      expect(result.needsAttentionOverflow).toBe(0);
    }
  });

  it("marks the newest-first group past the last look, ungrouped and in arrival tabs only", () => {
    const newest = entry({ correlationId: "t", timestamp: 300 });
    const newer = entry({ timestamp: 250 });
    const atWatermark = entry({ timestamp: 200 });
    const entries = [newest, newer, atWatermark];
    expect(view(entries, { lastClosedAt: 200 }).dividerGroupId).toBe("t");
    expect(view([newer, atWatermark], { lastClosedAt: 200 }).dividerGroupId).toBe(newer.id);
    expect(view([atWatermark], { lastClosedAt: 200 }).dividerGroupId).toBeNull();
    expect(view(entries, { lastClosedAt: 0 }).dividerGroupId).toBeNull();
    expect(view(entries, { lastClosedAt: 200, groupByContext: true }).dividerGroupId).toBeNull();

    const archivedNew = entry({ timestamp: 300, archivedAt: 400 });
    expect(view([archivedNew], { lastClosedAt: 200, filter: "archived" }).dividerGroupId).toBe(
      null
    );
    const snoozedNew = entry({ correlationId: "s", timestamp: 300 });
    expect(
      view([snoozedNew], {
        lastClosedAt: 200,
        filter: "snoozed",
        snoozedThreads: { s: Date.now() + 60_000 },
      }).dividerGroupId
    ).toBeNull();
  });

  it("sends each entry to exactly one of All, Archived and Snoozed", () => {
    const active = entry({ correlationId: "s" });
    const expired = entry({ correlationId: "x" });
    const plain = entry();
    const archived = entry({ correlationId: "s", archivedAt: 5 });
    const entries = [active, expired, plain, archived];
    const snoozedThreads = { s: Date.now() + 60_000, x: Date.now() - 60_000 };
    expect(ids(filterTriageEntries(entries, "all", null, snoozedThreads))).toEqual([
      expired.id,
      plain.id,
    ]);
    expect(ids(filterTriageEntries(entries, "snoozed", null, snoozedThreads))).toEqual([active.id]);
    expect(ids(filterTriageEntries(entries, "archived", null, snoozedThreads))).toEqual([
      archived.id,
    ]);
  });

  it("keeps only frozen rows in Unread after they are read", () => {
    const frozen = entry({ seenAsToast: true });
    const notFrozen = entry({ seenAsToast: true });
    const unread = entry({ seenAsToast: false });
    const frozenArchived = entry({ seenAsToast: true, archivedAt: 5 });
    const entries = [frozen, notFrozen, unread, frozenArchived];
    expect(ids(filterTriageEntries(entries, "unread", null, {}))).toEqual([unread.id]);
    expect(
      ids(filterTriageEntries(entries, "unread", new Set([frozen.id, frozenArchived.id]), {}))
    ).toEqual([frozen.id, unread.id]);
  });

  it("partitions by context and flattens the rail followed by every section's groups", () => {
    const err = entry({
      type: "error",
      seenAsToast: false,
      correlationId: "x",
      context: { projectId: "p1" },
      actions: [{ label: "Retry", actionId: "app.settings.openTab" }],
    });
    const errTail = entry({ type: "error", seenAsToast: false, correlationId: "x" });
    const p2 = entry({ context: { projectId: "p2" } });
    const p1b = entry({ correlationId: "lone", context: { projectId: "p1" } });
    const result = view([err, errTail, p2, p1b], { groupByContext: true });
    expect(result.chronoSections.map((s) => s.key)).toEqual(["proj:p1", "proj:p2"]);
    expect(result.chronoSections[0]!.groups.map((g) => g.correlationId)).toEqual(["x", "lone"]);

    const rows = buildFlatRows(result.needsAttentionGroups, result.chronoSections);
    expect(rows.map((r) => r.key)).toEqual(["x", "x", "lone", p2.id]);
    expect(rows.map((r) => r.isThread)).toEqual([true, true, false, false]);
    expect(rows[0]).toMatchObject({
      entryId: err.id,
      correlationId: "x",
      context: { projectId: "p1" },
      primaryAction: { actionId: "app.settings.openTab" },
    });
    expect(rows[3]!.correlationId).toBeUndefined();
  });
});
