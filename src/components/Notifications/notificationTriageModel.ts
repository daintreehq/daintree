import type { NotificationHistoryEntry } from "@/store/slices/notificationHistorySlice";
import { getWorstSeverity, SEVERITY_WEIGHTS } from "@/lib/notificationSeverity";

// Three, not five. Even as compact previews, five pinned rows took three
// quarters of a laptop-height list, so the first screen held one row of what
// had actually arrived. Overflow is still counted and still in the list below.
const NEEDS_ATTENTION_CAP = 3;
const CONTEXT_NONE_KEY = "__none__";

export type NotificationFilter = "all" | "unread" | "archived" | "snoozed";

function isUnreadGroup(group: ThreadGroup): boolean {
  return group.entries.some((e) => !e.seenAsToast);
}

/** An agent asking for input outranks anything that has merely gone wrong. */
function isAskingGroup(group: ThreadGroup): boolean {
  return group.entries.some((e) => !e.seenAsToast && e.context?.eventKind === "waiting");
}

function getGroupContextKey(group: ThreadGroup): string {
  // Another host's ids can collide with nothing here, but its rows still
  // belong under that host's name, not this machine's projects.
  const host = group.entries.find((e) => e.context?.hostName)?.context?.hostName;
  const prefix = host ? `host:${host}\0` : "";
  for (const e of group.entries) {
    const wt = e.context?.worktreeId;
    if (wt) return `${prefix}wt:${wt}`;
    const proj = e.context?.projectId;
    if (proj) return `${prefix}proj:${proj}`;
  }
  return host ? `${prefix}none` : CONTEXT_NONE_KEY;
}

export interface ThreadGroup {
  correlationId: string | undefined;
  entries: NotificationHistoryEntry[];
  latestTimestamp: number;
}

export interface ContextSection {
  key: string;
  worktreeId?: string;
  projectId?: string;
  hostName?: string;
  groups: ThreadGroup[];
}

export type NotificationAction = NonNullable<NotificationHistoryEntry["actions"]>[number];

export interface FlatRow {
  key: string;
  isThread: boolean;
  correlationId: string | undefined;
  entryId: string;
  primaryAction: NotificationAction | undefined;
  /** The displayed entry's address — what Enter goes to, like a click. */
  context: NotificationHistoryEntry["context"];
}

export function buildFlatRow(group: ThreadGroup): FlatRow {
  const isThread = !!group.correlationId && group.entries.length > 1;
  const latest = group.entries[0]!;
  return {
    key: group.correlationId ?? latest.id,
    isThread,
    correlationId: group.correlationId,
    entryId: latest.id,
    primaryAction: latest.actions?.[0],
    context: latest.context,
  };
}

export function groupByCorrelationId(entries: NotificationHistoryEntry[]): ThreadGroup[] {
  const groups = new Map<string, { entries: NotificationHistoryEntry[]; isSolo: boolean }>();
  const order: string[] = [];

  for (const entry of entries) {
    if (entry.correlationId) {
      if (!groups.has(entry.correlationId)) {
        groups.set(entry.correlationId, { entries: [], isSolo: false });
        order.push(entry.correlationId);
      }
      groups.get(entry.correlationId)!.entries.push(entry);
    } else {
      groups.set(entry.id, { entries: [entry], isSolo: true });
      order.push(entry.id);
    }
  }

  return order.map((key) => {
    const { entries: groupEntries, isSolo } = groups.get(key)!;
    return {
      correlationId: isSolo ? undefined : key,
      entries: groupEntries,
      latestTimestamp: Math.max(...groupEntries.map((e) => e.timestamp)),
    };
  });
}

function partitionByContext(groups: ThreadGroup[]): ContextSection[] {
  const sections = new Map<string, ContextSection>();
  const order: string[] = [];

  for (const g of groups) {
    const key = getGroupContextKey(g);
    if (!sections.has(key)) {
      const first = g.entries.find((e) => e.context?.worktreeId || e.context?.projectId);
      sections.set(key, {
        key,
        worktreeId: first?.context?.worktreeId,
        projectId: first?.context?.projectId,
        hostName: g.entries.find((e) => e.context?.hostName)?.context?.hostName,
        groups: [],
      });
      order.push(key);
    }
    sections.get(key)!.groups.push(g);
  }

  return order.map((k) => sections.get(k)!);
}

/** The tab's entries. Archived rows live only in Archived, snoozed only in Snoozed. */
export function filterTriageEntries(
  entries: NotificationHistoryEntry[],
  filter: NotificationFilter,
  frozenUnreadIds: Set<string> | null,
  snoozedThreads: Record<string, number>
): NotificationHistoryEntry[] {
  // Recompute "is snoozed?" per entry against the current snooze map.
  // Inlining the check keeps callers from threading `now` everywhere — for
  // the inbox-render path a single timestamp captured per render is fine
  // (the expiry timer will re-render when a snooze actually expires).
  const now = Date.now();
  const isSnoozed = (e: NotificationHistoryEntry): boolean => {
    if (!e.correlationId) return false;
    const until = snoozedThreads[e.correlationId];
    return typeof until === "number" && until > now;
  };
  if (filter === "snoozed") {
    // Snoozed tab shows only actively-snoozed (non-archived) entries.
    // Archived entries that happen to belong to a still-snoozed
    // correlationId stay in Archived, not here — Snoozed is the "deferred
    // commitment" surface, Archived is the "done" surface.
    return entries.filter((e) => e.archivedAt === null && isSnoozed(e));
  }
  if (filter === "archived") {
    return entries.filter((e) => e.archivedAt !== null);
  }
  if (filter === "all") {
    // Archived entries belong to the Archived tab only — they're done.
    // Snoozed threads are intentionally hidden until they un-snooze.
    return entries.filter((e) => e.archivedAt === null && !isSnoozed(e));
  }
  if (frozenUnreadIds) {
    return entries.filter(
      (e) => e.archivedAt === null && !isSnoozed(e) && (!e.seenAsToast || frozenUnreadIds.has(e.id))
    );
  }
  return entries.filter((e) => e.archivedAt === null && !e.seenAsToast && !isSnoozed(e));
}

export interface TriageView {
  needsAttentionGroups: ThreadGroup[];
  needsAttentionOverflow: number;
  chronoSections: ContextSection[];
  dividerGroupId: string | null;
}

export function deriveTriageView({
  entries,
  filteredEntries,
  filter,
  groupByContext,
  lastClosedAt,
  snoozedThreads,
}: {
  entries: NotificationHistoryEntry[];
  filteredEntries: NotificationHistoryEntry[];
  filter: NotificationFilter;
  groupByContext: boolean;
  lastClosedAt: number;
  snoozedThreads: Record<string, number>;
}): TriageView {
  const now = Date.now();
  const isSnoozedGroup = (g: ThreadGroup): boolean => {
    if (!g.correlationId) return false;
    const until = snoozedThreads[g.correlationId];
    return typeof until === "number" && until > now;
  };
  // Pinned reflects the global unread severe-threads set so it stays the
  // same in All and Unread filter views. Hidden in Archived and Snoozed —
  // pinned is for active, attention-required items only. Snoozed threads
  // are an explicit defer so they must drop out of the pinned rail.
  const severeUnread =
    filter === "archived" || filter === "snoozed"
      ? []
      : groupByCorrelationId(entries.filter((e) => e.archivedAt === null))
          .filter((g) => {
            if (isSnoozedGroup(g)) return false;
            if (!isUnreadGroup(g)) return false;
            const sev = getWorstSeverity(g.entries);
            return sev === "error" || sev === "warning";
          })
          .sort((a, b) => {
            // Asking first. The brief's first question is "is anything
            // asking me for something", and a waiting agent is stalled
            // until answered, where a failure has already happened. Sorting
            // on severity alone put a 44-minute-old migration failure
            // ahead of an agent that had been waiting six.
            const askDiff = Number(isAskingGroup(b)) - Number(isAskingGroup(a));
            if (askDiff !== 0) return askDiff;
            const sevDiff =
              SEVERITY_WEIGHTS[getWorstSeverity(b.entries)] -
              SEVERITY_WEIGHTS[getWorstSeverity(a.entries)];
            if (sevDiff !== 0) return sevDiff;
            return b.latestTimestamp - a.latestTimestamp;
          });
  const pinned = severeUnread.slice(0, NEEDS_ATTENTION_CAP);

  const chronoGroups = groupByCorrelationId(filteredEntries);
  const sections: ContextSection[] = groupByContext
    ? partitionByContext(chronoGroups)
    : [{ key: "all", groups: chronoGroups }];

  let divider: string | null = null;
  // Ungrouped only. Grouped, the new rows are spread across sections, and
  // one divider in whichever section held the newest row labelled that
  // section alone while its action reset the watermark for all of them.
  // Each section marks its own boundary instead (see ChronoSection).
  if (!groupByContext && lastClosedAt > 0 && filter !== "archived" && filter !== "snoozed") {
    for (const g of chronoGroups) {
      if (g.latestTimestamp > lastClosedAt) {
        divider = g.correlationId ?? g.entries[0]?.id ?? null;
        break;
      }
    }
  }

  return {
    needsAttentionGroups: pinned,
    needsAttentionOverflow: severeUnread.length - pinned.length,
    chronoSections: sections,
    dividerGroupId: divider,
  };
}

/** One roving-focus stop per rendered row: the pinned rail first, then the list. */
export function buildFlatRows(
  needsAttentionGroups: ThreadGroup[],
  chronoSections: ContextSection[]
): FlatRow[] {
  const rows: FlatRow[] = [];
  for (const g of needsAttentionGroups) {
    rows.push(buildFlatRow(g));
  }
  for (const section of chronoSections) {
    for (const g of section.groups) {
      rows.push(buildFlatRow(g));
    }
  }
  return rows;
}
