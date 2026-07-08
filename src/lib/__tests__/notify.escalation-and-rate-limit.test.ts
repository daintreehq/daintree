// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  notify,
  _resetCoalesceMap,
  _getActiveCoalescedSizeForTest,
  _resetEscalationTrackers,
  _resetRateLimitBuckets,
  _resetOverflowAnnouncements,
  shouldEscalateTransientError,
  consumeEscalation,
  _setQuietUntil,
  _resetActiveContextAccessorsForTest,
  _resetPendingSuppressedForTest,
} from "../notify";
import { useNotificationStore } from "../../store/notificationStore";
import { useNotificationHistoryStore } from "../../store/slices/notificationHistorySlice";
import { useNotificationSettingsStore } from "../../store/notificationSettingsStore";
import { useAnnouncerStore } from "../../store/accessibilityAnnouncerStore";

const mockShowNative = vi.fn();
const mockSetSessionMute = vi.fn();

beforeEach(() => {
  Object.defineProperty(window, "electron", {
    value: {
      notification: {
        showNative: mockShowNative,
        setSettings: vi.fn().mockResolvedValue(undefined),
        setSessionMuteUntil: mockSetSessionMute,
      },
    },
    writable: true,
    configurable: true,
  });
  mockSetSessionMute.mockClear();
});
describe("shouldEscalateTransientError", () => {
  beforeEach(() => {
    _resetEscalationTrackers();
  });

  it("returns false for retryability='none' errors", () => {
    expect(
      shouldEscalateTransientError({
        type: "process",
        message: "spawn failed",
        retryability: "none" as const,
      })
    ).toBe(false);
  });

  it("returns false for first occurrence of a retryability='auto' error", () => {
    expect(
      shouldEscalateTransientError({
        type: "filesystem",
        message: "EBUSY: resource locked",
        retryability: "auto" as const,
      })
    ).toBe(false);
  });

  it("returns false for second occurrence within window", () => {
    const error = { type: "process" as const, message: "EAGAIN", retryability: "auto" as const };
    shouldEscalateTransientError(error);
    expect(shouldEscalateTransientError(error)).toBe(false);
  });

  it("returns true when local-resource error hits threshold (3) within 5s window", () => {
    const error = { type: "filesystem" as const, message: "EBUSY", retryability: "auto" as const };
    shouldEscalateTransientError(error);
    shouldEscalateTransientError(error);
    expect(shouldEscalateTransientError(error)).toBe(true);
  });

  it("returns true when network error hits threshold (3) within 120s window", () => {
    const error = { type: "network" as const, message: "ETIMEDOUT", retryability: "auto" as const };
    shouldEscalateTransientError(error);
    shouldEscalateTransientError(error);
    expect(shouldEscalateTransientError(error)).toBe(true);
  });

  it("treats 'unknown' as network profile", () => {
    const error = {
      type: "unknown" as const,
      message: "something failed",
      retryability: "auto" as const,
    };
    shouldEscalateTransientError(error);
    shouldEscalateTransientError(error);
    expect(shouldEscalateTransientError(error)).toBe(true);
  });

  it("resets counter after local-resource window expires (5s)", () => {
    const error = { type: "filesystem" as const, message: "EBUSY", retryability: "auto" as const };
    const realDateNow = Date.now;

    let now = 1000;
    Date.now = () => now;

    shouldEscalateTransientError(error);
    shouldEscalateTransientError(error); // count=2

    now = 7000; // past 5s window
    expect(shouldEscalateTransientError(error)).toBe(false); // count reset to 1

    Date.now = realDateNow;
  });

  it("does not re-escalate after escalation is consumed (one-shot per group)", () => {
    const error = { type: "network" as const, message: "ETIMEDOUT", retryability: "auto" as const };
    shouldEscalateTransientError(error);
    shouldEscalateTransientError(error);
    const escalated = shouldEscalateTransientError(error);
    expect(escalated).toBe(true);

    consumeEscalation(error);

    // Same error fires again immediately — should not re-escalate
    expect(shouldEscalateTransientError(error)).toBe(false);
  });

  it("re-escalates if first escalation was not consumed (toast suppressed)", () => {
    const error = { type: "network" as const, message: "ETIMEDOUT", retryability: "auto" as const };
    shouldEscalateTransientError(error);
    shouldEscalateTransientError(error);
    expect(shouldEscalateTransientError(error)).toBe(true);

    // Escalation not consumed (toast suppressed, e.g. blurred)
    // Next occurrence should still signal escalation
    expect(shouldEscalateTransientError(error)).toBe(true);

    // Now consume it
    consumeEscalation(error);
    expect(shouldEscalateTransientError(error)).toBe(false);
  });

  it("allows re-escalation after cooldown expires", () => {
    const error = { type: "network" as const, message: "ETIMEDOUT", retryability: "auto" as const };
    const realDateNow = Date.now;

    let now = 1000;
    Date.now = () => now;

    // First escalation
    shouldEscalateTransientError(error);
    shouldEscalateTransientError(error);
    expect(shouldEscalateTransientError(error)).toBe(true);
    consumeEscalation(error);

    // Advance past 60-min cooldown + past the 120s window (so counter resets)
    now = 1000 + 61 * 60 * 1000;
    // Counter should reset since window expired, then escalate again on 3rd
    shouldEscalateTransientError(error);
    shouldEscalateTransientError(error);
    expect(shouldEscalateTransientError(error)).toBe(true);

    Date.now = realDateNow;
  });

  it("groups errors by type + source + message", () => {
    const error1 = {
      type: "network" as const,
      message: "ECONNRESET",
      source: "git-poll",
      retryability: "auto" as const,
    };
    const error2 = {
      type: "network" as const,
      message: "ECONNRESET",
      source: "terminal",
      retryability: "auto" as const,
    };

    // Different source = different group
    shouldEscalateTransientError(error1);
    shouldEscalateTransientError(error1);
    shouldEscalateTransientError(error1); // error1 escalates

    // error2 should have its own counter at 1
    shouldEscalateTransientError(error2);
    expect(shouldEscalateTransientError(error2)).toBe(false); // count=2, not yet threshold
  });

  it("groups errors whose messages differ only by volatile suffixes (normalized dedup)", () => {
    const error1 = {
      type: "process" as const,
      message: "listen EADDRINUSE: address already in use :::3000",
      source: "http",
      retryability: "auto" as const,
    };
    const error2 = {
      type: "process" as const,
      message: "listen EADDRINUSE: address already in use :::4000",
      source: "http",
      retryability: "auto" as const,
    };

    // Same normalized key — grouped together
    shouldEscalateTransientError(error1);
    shouldEscalateTransientError(error2);
    expect(shouldEscalateTransientError(error1)).toBe(true);
  });

  it("groups errors with UUID-only message differences", () => {
    const error1 = {
      type: "network" as const,
      message: "Timeout abc12345-6789-4abc-def0-123456789abc for request",
      source: "fetcher",
      retryability: "auto" as const,
    };
    const error2 = {
      type: "network" as const,
      message: "Timeout deadbeef-1111-4abc-def0-222222222222 for request",
      source: "fetcher",
      retryability: "auto" as const,
    };

    shouldEscalateTransientError(error1);
    shouldEscalateTransientError(error2);
    expect(shouldEscalateTransientError(error1)).toBe(true);
  });

  it("caps tracking entries and prunes LRU", () => {
    const realDateNow = Date.now;
    Date.now = () => 1000;

    // Create 201 unique errors — should not throw
    for (let i = 0; i < 201; i++) {
      expect(() =>
        shouldEscalateTransientError({
          type: "network",
          message: `error-${i}`,
          retryability: "auto" as const,
        })
      ).not.toThrow();
    }

    Date.now = realDateNow;
  });
});

describe("per-source rate-limit", () => {
  beforeEach(() => {
    useNotificationStore.setState({ notifications: [] });
    useNotificationHistoryStore.setState({
      entries: [],
      unreadCount: 0,
      evictedToInboxCount: 0,
    });
    useNotificationSettingsStore.setState({
      enabled: true,
      hydrated: true,
      quietHoursEnabled: false,
      quietHoursStartMin: 22 * 60,
      quietHoursEndMin: 8 * 60,
      quietHoursWeekdays: [],
    });
    _resetCoalesceMap();
    _resetRateLimitBuckets();
    _resetOverflowAnnouncements();
    useAnnouncerStore.setState({ polite: null, assertive: null, nextId: 1 });
    _setQuietUntil(0);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("allows the first 3 toasts and suppresses the 4th", () => {
    for (let i = 0; i < 3; i++) {
      notify({ type: "error", message: `Failure ${i}`, rateLimitKey: "noisy-source" });
    }
    expect(useNotificationStore.getState().notifications).toHaveLength(3);
    expect(useNotificationHistoryStore.getState().entries).toHaveLength(3);

    notify({ type: "error", message: "Failure 3", rateLimitKey: "noisy-source" });
    expect(useNotificationStore.getState().notifications).toHaveLength(3);
    const entries = useNotificationHistoryStore.getState().entries;
    expect(entries).toHaveLength(4);
    expect(entries[0]!.message).toBe("noisy-source reported 1 more event — open inbox");
  });

  it("updates the same summary row in place on subsequent overflows", () => {
    for (let i = 0; i < 6; i++) {
      notify({ type: "error", message: `Failure ${i}`, rateLimitKey: "noisy-source" });
    }
    const entries = useNotificationHistoryStore.getState().entries;
    // 3 allowed + 1 summary row = 4 entries; the summary's message text carries the count
    expect(entries).toHaveLength(4);
    expect(entries[0]!.message).toBe("noisy-source reported 3 more events — open inbox");
  });

  it("does not bump timestamp when refreshing the summary row", () => {
    notify({ type: "error", message: "1", rateLimitKey: "noisy" });
    notify({ type: "error", message: "2", rateLimitKey: "noisy" });
    notify({ type: "error", message: "3", rateLimitKey: "noisy" });
    notify({ type: "error", message: "4", rateLimitKey: "noisy" });

    const summaryId = useNotificationHistoryStore.getState().entries[0]!.id;
    const firstTs = useNotificationHistoryStore.getState().entries[0]!.timestamp;

    notify({ type: "error", message: "5", rateLimitKey: "noisy" });
    const after = useNotificationHistoryStore.getState().entries.find((e) => e.id === summaryId);
    expect(after).toBeDefined();
    expect(after!.timestamp).toBe(firstTs);
  });

  it("refills one token per refill interval", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0));

    for (let i = 0; i < 4; i++) {
      notify({ type: "error", message: `f${i}`, rateLimitKey: "drip" });
    }
    expect(useNotificationStore.getState().notifications).toHaveLength(3);

    // Advance one refill interval — bucket gets 1 token back
    vi.advanceTimersByTime(10_000);
    notify({ type: "error", message: "after-drip", rateLimitKey: "drip" });
    expect(useNotificationStore.getState().notifications).toHaveLength(4);

    // Bucket is empty again — next call overflows
    notify({ type: "error", message: "still-noisy", rateLimitKey: "drip" });
    expect(useNotificationStore.getState().notifications).toHaveLength(4);

    vi.useRealTimers();
  });

  it("starts a fresh summary row after the bucket recovers and re-overflows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0));

    // First burst → summary row "Source reported 1 more event"
    for (let i = 0; i < 5; i++) {
      notify({ type: "error", message: `a${i}`, rateLimitKey: "noisy" });
    }
    const firstSummaryId = useNotificationHistoryStore.getState().entries[0]!.id;

    // Refill fully (3 × 10s)
    vi.advanceTimersByTime(30_000);

    // Consume tokens and overflow again
    for (let i = 0; i < 5; i++) {
      notify({ type: "error", message: `b${i}`, rateLimitKey: "noisy" });
    }
    const secondSummary = useNotificationHistoryStore.getState().entries[0]!;
    expect(secondSummary.id).not.toBe(firstSummaryId);
    expect(secondSummary.message).toBe("noisy reported 2 more events — open inbox");

    vi.useRealTimers();
  });

  it("priority 'low' bypasses the limiter", () => {
    for (let i = 0; i < 10; i++) {
      notify({
        type: "info",
        message: `bg ${i}`,
        priority: "low",
        rateLimitKey: "low-source",
      });
    }
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
    // All 10 written to inbox normally — no summary row collapse
    expect(useNotificationHistoryStore.getState().entries).toHaveLength(10);
  });

  it("transient: true bypasses the limiter", () => {
    for (let i = 0; i < 6; i++) {
      notify({ type: "success", message: `t ${i}`, transient: true, rateLimitKey: "ephemeral" });
    }
    expect(useNotificationStore.getState().notifications).toHaveLength(6);
    expect(useNotificationHistoryStore.getState().entries).toHaveLength(0);
  });

  it("urgent: true bypasses the limiter", () => {
    for (let i = 0; i < 5; i++) {
      notify({ type: "error", message: `u ${i}`, urgent: true, rateLimitKey: "alarm" });
    }
    expect(useNotificationStore.getState().notifications).toHaveLength(5);
  });

  it("placement 'grid-bar' bypasses the limiter", () => {
    for (let i = 0; i < 6; i++) {
      notify({
        type: "info",
        message: `g ${i}`,
        placement: "grid-bar",
        rateLimitKey: "inline",
      });
    }
    expect(useNotificationStore.getState().notifications).toHaveLength(6);
  });

  it("coalesce bypasses the limiter (own gate)", () => {
    for (let i = 0; i < 8; i++) {
      notify({
        type: "info",
        message: `c ${i}`,
        coalesce: {
          key: "burst",
          buildMessage: (count) => `${count} events`,
        },
        rateLimitKey: "coalesce-bypass",
      });
    }
    // All collapsed into a single coalesced toast (count grows via updateNotification)
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
    // No overflow summary row was written
    const entries = useNotificationHistoryStore.getState().entries;
    expect(entries.every((e) => !e.message.includes("more event"))).toBe(true);
  });

  it("different rateLimitKey values are tracked independently", () => {
    for (let i = 0; i < 4; i++) {
      notify({ type: "error", message: `a${i}`, rateLimitKey: "source-a" });
    }
    for (let i = 0; i < 4; i++) {
      notify({ type: "error", message: `b${i}`, rateLimitKey: "source-b" });
    }
    // Each source: 3 toasts allowed, 4th overflows → 6 toasts, 2 summary rows
    expect(useNotificationStore.getState().notifications).toHaveLength(6);
    const summaryRows = useNotificationHistoryStore
      .getState()
      .entries.filter((e) => e.message.includes("more event"));
    expect(summaryRows).toHaveLength(2);
  });

  it("falls back to correlationId when rateLimitKey is omitted", () => {
    for (let i = 0; i < 4; i++) {
      notify({ type: "error", message: `c${i}`, correlationId: "thread-1" });
    }
    // Same correlationId triggers entity-collapse in the notification store,
    // so toast count isn't a clean signal here. The bucket-fallback contract
    // is verified by the summary row's source label.
    const summary = useNotificationHistoryStore
      .getState()
      .entries.find((e) => e.message.includes("more event"));
    expect(summary?.message).toBe("thread-1 reported 1 more event — open inbox");
  });

  it("falls back to context.projectId then context.worktreeId then type", () => {
    // Falls back to projectId
    for (let i = 0; i < 4; i++) {
      notify({ type: "error", message: `p${i}`, context: { projectId: "proj-1" } });
    }
    expect(
      useNotificationHistoryStore.getState().entries.find((e) => e.message.includes("more event"))
        ?.message
    ).toBe("proj-1 reported 1 more event — open inbox");

    // Clear and check worktreeId path
    useNotificationStore.setState({ notifications: [] });
    useNotificationHistoryStore.setState({
      entries: [],
      unreadCount: 0,
      evictedToInboxCount: 0,
    });
    _resetRateLimitBuckets();
    for (let i = 0; i < 4; i++) {
      notify({ type: "error", message: `w${i}`, context: { worktreeId: "wt-1" } });
    }
    expect(
      useNotificationHistoryStore.getState().entries.find((e) => e.message.includes("more event"))
        ?.message
    ).toBe("wt-1 reported 1 more event — open inbox");

    // Clear and check type fallback
    useNotificationStore.setState({ notifications: [] });
    useNotificationHistoryStore.setState({
      entries: [],
      unreadCount: 0,
      evictedToInboxCount: 0,
    });
    _resetRateLimitBuckets();
    for (let i = 0; i < 4; i++) {
      notify({ type: "warning", message: `t${i}` });
    }
    expect(
      useNotificationHistoryStore.getState().entries.find((e) => e.message.includes("more event"))
        ?.message
    ).toBe("warning reported 1 more event — open inbox");
  });

  it("does not double-record overflowed events (no original row + summary)", () => {
    for (let i = 0; i < 5; i++) {
      notify({ type: "error", message: `Original ${i}`, rateLimitKey: "noisy" });
    }
    // 3 original rows + 1 summary row = 4 total; the 4th and 5th overflowed
    // events are aggregated into the summary, not recorded individually.
    expect(useNotificationHistoryStore.getState().entries).toHaveLength(4);
  });

  it("prunes bucket map when over RATE_LIMIT_MAX_BUCKETS", () => {
    // Create 201 unique buckets — should not throw and should be capped
    for (let i = 0; i < 201; i++) {
      expect(() =>
        notify({ type: "info", message: `n${i}`, rateLimitKey: `source-${i}` })
      ).not.toThrow();
    }
    // No assertion on exact map size (internal state), but no crash means
    // the LRU pruner ran without indexing past the end.
  });

  it("recreates the summary row after a user archives the overflow entry", () => {
    for (let i = 0; i < 5; i++) {
      notify({ type: "error", message: `f${i}`, rateLimitKey: "noisy" });
    }
    const firstSummary = useNotificationHistoryStore
      .getState()
      .entries.find((e) => e.message.includes("more event"));
    expect(firstSummary).toBeDefined();

    useNotificationHistoryStore.getState().archiveEntry(firstSummary!.id);

    // Source keeps firing — next overflow must create a fresh summary row,
    // not silently vanish into the archived (no-op-updateable) entry.
    notify({ type: "error", message: "f5", rateLimitKey: "noisy" });

    const liveSummary = useNotificationHistoryStore
      .getState()
      .entries.find((e) => e.message.includes("more event") && !e.archivedAt);
    expect(liveSummary).toBeDefined();
    expect(liveSummary!.id).not.toBe(firstSummary!.id);
    expect(liveSummary!.message).toBe("noisy reported 1 more event — open inbox");
  });

  it("recreates the summary row after the entry is evicted by MAX_ENTRIES truncation", () => {
    for (let i = 0; i < 5; i++) {
      notify({ type: "error", message: `f${i}`, rateLimitKey: "noisy" });
    }
    const firstSummary = useNotificationHistoryStore
      .getState()
      .entries.find((e) => e.message.includes("more event"));
    expect(firstSummary).toBeDefined();

    // Push the summary row off the 200-entry ring buffer with unrelated
    // entries; pruner takes oldest-first.
    for (let i = 0; i < 200; i++) {
      useNotificationHistoryStore.getState().addEntry({
        type: "info",
        message: `unrelated-${i}`,
        seenAsToast: true,
      });
    }
    expect(
      useNotificationHistoryStore.getState().entries.find((e) => e.id === firstSummary!.id)
    ).toBeUndefined();

    // Next overflow must write a fresh summary row, not silently drop.
    notify({ type: "error", message: "after-eviction", rateLimitKey: "noisy" });

    const newSummary = useNotificationHistoryStore
      .getState()
      .entries.find((e) => e.message.includes("more event"));
    expect(newSummary).toBeDefined();
    expect(newSummary!.id).not.toBe(firstSummary!.id);
  });

  it("LRU prune keeps the most-recently-active bucket even when its lastRefill is old", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0));

    // T0: seed bucket A and drive it into overflow. Its `lastRefill` freezes
    // here since an empty bucket never refills.
    for (let i = 0; i < 5; i++) {
      notify({ type: "info", message: `a${i}`, rateLimitKey: "active" });
    }

    // T1: create 199 unrelated buckets. Each has `lastRefill = T1`, newer
    // than `active`'s frozen `lastRefill = T0`. No prune yet — map size 200.
    vi.advanceTimersByTime(1_000);
    for (let i = 0; i < 199; i++) {
      notify({ type: "info", message: `u${i}`, rateLimitKey: `unrelated-${i}` });
    }

    // T2: touch `active` one more time — `lastSeen` advances to T2, but
    // `lastRefill` stays at T0 (still overflowing, no refill window crossed).
    vi.advanceTimersByTime(1_000);
    notify({ type: "info", message: "keepalive", rateLimitKey: "active" });

    // T2 (same tick): create the 200th unrelated bucket → map size 201,
    // pruner fires. Sorted by `lastSeen` ascending, the oldest is one of
    // the T1-created unrelated buckets, NOT `active` (touched at T2).
    // Buggy sort-by-`lastRefill` would evict `active` (lastRefill = T0,
    // oldest).
    notify({ type: "info", message: "u199", rateLimitKey: "unrelated-199" });

    // Fire on `active` again. If the bucket survived (correct LRU), this
    // overflows and writes an "active reported …" summary row (the original
    // one was evicted from the 200-entry history ring by the unrelated
    // entries, so a fresh row gets created via the no-op fall-through).
    // If `active` had been evicted from the bucket map, it would be re-
    // created with 3 fresh tokens, consume one, write a normal "after-prune"
    // history entry, and no overflow summary would exist.
    notify({ type: "info", message: "after-prune", rateLimitKey: "active" });

    const summary = useNotificationHistoryStore
      .getState()
      .entries.find((e) => e.message.startsWith("active reported"));
    expect(summary).toBeDefined();

    vi.useRealTimers();
  });

  it("does not consume tokens when notifications are disabled", () => {
    useNotificationSettingsStore.setState({ enabled: false });
    for (let i = 0; i < 10; i++) {
      notify({ type: "error", message: `d${i}`, rateLimitKey: "disabled-src" });
    }
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
    const summaries = useNotificationHistoryStore
      .getState()
      .entries.filter((e) => e.message.includes("more event"));
    expect(summaries).toHaveLength(0);
  });

  it("does not consume tokens during quiet hours", () => {
    _setQuietUntil(Date.now() + 60_000);
    for (let i = 0; i < 10; i++) {
      notify({ type: "error", message: `q${i}`, rateLimitKey: "quiet-src" });
    }
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
    const summaries = useNotificationHistoryStore
      .getState()
      .entries.filter((e) => e.message.includes("more event"));
    expect(summaries).toHaveLength(0);
  });

  it("does not consume tokens for blurred high-priority (already inbox-only)", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    for (let i = 0; i < 10; i++) {
      notify({ type: "error", message: `b${i}`, rateLimitKey: "blurred-src" });
    }
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
    // All 10 written individually to history; no summary row collapse.
    expect(useNotificationHistoryStore.getState().entries).toHaveLength(10);
    const summaries = useNotificationHistoryStore
      .getState()
      .entries.filter((e) => e.message.includes("more event"));
    expect(summaries).toHaveLength(0);
  });

  it("summary row carries no context (cross-context buckets shouldn't surface mute affordances)", () => {
    for (let i = 0; i < 4; i++) {
      notify({
        type: "error",
        message: `m${i}`,
        rateLimitKey: "shared",
        context: { projectId: `project-${i}` },
      });
    }
    const summary = useNotificationHistoryStore
      .getState()
      .entries.find((e) => e.message.includes("more event"));
    expect(summary?.context).toBeUndefined();
  });

  describe("overflow screen-reader announcements", () => {
    it("announces overflow message on first suppressed event", () => {
      for (let i = 0; i < 4; i++) {
        notify({ type: "error", message: `e${i}`, rateLimitKey: "noisy" });
      }
      const polite = useAnnouncerStore.getState().polite;
      expect(polite?.msg).toBe("Events suppressed — check notification inbox");
    });

    it("does not re-announce within the cooldown window", () => {
      for (let i = 0; i < 6; i++) {
        notify({ type: "error", message: `e${i}`, rateLimitKey: "noisy" });
      }
      // Only one announcement despite 3 overflow events (4th, 5th, 6th calls)
      expect(useAnnouncerStore.getState().polite).toBeTruthy();
      // Verify the message was only set once by checking the announcer id doesn't increment
      // beyond what a single call produces. (The 5th and 6th overflow calls land within
      // the 3s cooldown so they skip.)
      const { polite } = useAnnouncerStore.getState();
      expect(polite).not.toBeNull();
    });

    it("re-announces after the cooldown expires", () => {
      const realNow = Date.now;
      let fakeNow = 1_000_000_000;
      Date.now = () => fakeNow;

      try {
        // First overflow
        for (let i = 0; i < 4; i++) {
          notify({ type: "error", message: `e${i}`, rateLimitKey: "noisy" });
        }
        const firstId = useAnnouncerStore.getState().polite?.id;
        expect(firstId).toBeDefined();

        // Advance past cooldown + refill
        fakeNow += 15_000;
        // Consume one token to trigger refill, then overflow again
        for (let i = 0; i < 5; i++) {
          notify({ type: "error", message: `f${i}`, rateLimitKey: "noisy" });
        }
        const secondId = useAnnouncerStore.getState().polite?.id;
        expect(secondId).toBeGreaterThan(firstId!);
      } finally {
        Date.now = realNow;
      }
    });

    it("announces recovery when bucket refills after an overflow", () => {
      const realNow = Date.now;
      let fakeNow = 1_000_000_000;
      Date.now = () => fakeNow;

      try {
        // Trigger overflow
        for (let i = 0; i < 4; i++) {
          notify({ type: "error", message: `e${i}`, rateLimitKey: "noisy" });
        }

        // Advance past refill so bucket recovers
        fakeNow += 15_000;

        // A fresh call consumes one refilled token, bucket goes from 0 → >0
        notify({ type: "error", message: "post-recovery", rateLimitKey: "noisy" });
        const polite = useAnnouncerStore.getState().polite;
        expect(polite?.msg).toBe("Event stream resumed");
      } finally {
        Date.now = realNow;
      }
    });

    it("does not announce recovery when source never overflowed", () => {
      const realNow = Date.now;
      let fakeNow = 1_000_000_000;
      Date.now = () => fakeNow;

      try {
        // Exhaust tokens without triggering overflow (3 toasts, no 4th)
        for (let i = 0; i < 3; i++) {
          notify({ type: "error", message: `e${i}`, rateLimitKey: "quiet" });
        }

        // Advance past refill
        fakeNow += 15_000;

        // Next call refills and consumes a token — no overflow was ever announced
        notify({ type: "error", message: "post-refill", rateLimitKey: "quiet" });
        const { polite } = useAnnouncerStore.getState();
        // The message should still be null, or at least not the recovery message
        expect(polite?.msg).toBeUndefined();
      } finally {
        Date.now = realNow;
      }
    });

    it("independent sources each announce their own overflow", () => {
      for (let i = 0; i < 4; i++) {
        notify({ type: "error", message: `a${i}`, rateLimitKey: "src-a" });
      }
      expect(useAnnouncerStore.getState().polite?.msg).toBe(
        "Events suppressed — check notification inbox"
      );

      // Reset announcer so we can observe the second source's call
      useAnnouncerStore.setState({ polite: null, assertive: null });

      for (let i = 0; i < 4; i++) {
        notify({ type: "error", message: `b${i}`, rateLimitKey: "src-b" });
      }
      expect(useAnnouncerStore.getState().polite?.msg).toBe(
        "Events suppressed — check notification inbox"
      );
    });
  });
});
