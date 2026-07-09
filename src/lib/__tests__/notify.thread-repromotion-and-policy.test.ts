// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  notify,
  TOAST_DURATION,
  EVENT_POLICY,
  EVENT_KIND_LABEL,
  EVENT_KIND_TO_SETTING_KEY,
  type NotificationEventKind,
  _resetCoalesceMap,
  _getActiveCoalescedSizeForTest,
  _resetEscalationTrackers,
  _resetRateLimitBuckets,
  _resetOverflowAnnouncements,
  _setQuietUntil,
  _resetActiveContextAccessorsForTest,
  _resetPendingSuppressedForTest,
} from "../notify";
import { useNotificationStore } from "../../store/notificationStore";
import {
  useNotificationHistoryStore,
  type NotificationHistoryEntry,
} from "../../store/slices/notificationHistorySlice";
import { useNotificationSettingsStore } from "../../store/notificationSettingsStore";

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
describe("notify() — thread re-promotion (#9008)", () => {
  let entrySeq = 0;

  function seedEntry(
    overrides: Partial<NotificationHistoryEntry> & Pick<NotificationHistoryEntry, "type">
  ): NotificationHistoryEntry {
    return {
      id: `seed-${entrySeq++}`,
      type: overrides.type,
      title: overrides.title,
      message: overrides.message ?? "seeded",
      timestamp: overrides.timestamp ?? Date.now() - 1000,
      correlationId: overrides.correlationId,
      seenAsToast: overrides.seenAsToast ?? true,
      summarized: overrides.summarized ?? false,
      countable: overrides.countable ?? true,
      archivedAt: overrides.archivedAt ?? null,
      supersedeKey: overrides.supersedeKey,
      context: overrides.context,
      actions: overrides.actions,
    };
  }

  function seedThread(entries: NotificationHistoryEntry[]): void {
    useNotificationHistoryStore.setState({
      entries,
      unreadCount: entries.filter((e) => !e.seenAsToast && e.countable && !e.archivedAt).length,
    });
  }

  beforeEach(() => {
    entrySeq = 0;
    useNotificationStore.setState({ notifications: [] });
    useNotificationHistoryStore.setState({ entries: [], unreadCount: 0 });
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
    _setQuietUntil(0);
    // priority "low" routes inbox-only by default, so re-promotion is the only
    // path to a toast — isolates the predicate from focus/origin logic.
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("re-toasts when severity escalates above the thread's worst (info → warning)", () => {
    seedThread([seedEntry({ type: "info", correlationId: "build" })]);
    notify({ type: "warning", correlationId: "build", message: "Build degraded", priority: "low" });
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
  });

  it("re-toasts on escalation to error (warning → error)", () => {
    seedThread([seedEntry({ type: "warning", correlationId: "build" })]);
    notify({ type: "error", correlationId: "build", message: "Build failed", priority: "low" });
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
  });

  it("re-toasts at the success → info boundary (weight 0 → 1)", () => {
    seedThread([seedEntry({ type: "success", correlationId: "build" })]);
    notify({ type: "info", correlationId: "build", message: "Rebuilding", priority: "low" });
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
  });

  it("stays inbox-only on same severity (info → info)", () => {
    seedThread([seedEntry({ type: "info", correlationId: "build" })]);
    notify({ type: "info", correlationId: "build", message: "Still building", priority: "low" });
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
    // but the inbox row is still written
    expect(useNotificationHistoryStore.getState().entries).toHaveLength(2);
  });

  it("stays inbox-only on de-escalation (error → warning)", () => {
    seedThread([seedEntry({ type: "error", correlationId: "build" })]);
    notify({ type: "warning", correlationId: "build", message: "Recovering", priority: "low" });
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });

  it("re-toasts when the entire thread is archived (un-snooze)", () => {
    seedThread([
      seedEntry({ type: "info", correlationId: "build", archivedAt: Date.now() - 5000 }),
      seedEntry({ type: "info", correlationId: "build", archivedAt: Date.now() - 4000 }),
    ]);
    notify({ type: "info", correlationId: "build", message: "New activity", priority: "low" });
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
  });

  it("does not re-toast a partially-archived thread on same severity", () => {
    seedThread([
      seedEntry({ type: "info", correlationId: "build", archivedAt: Date.now() - 5000 }),
      seedEntry({ type: "info", correlationId: "build", archivedAt: null }),
    ]);
    notify({ type: "info", correlationId: "build", message: "Still active", priority: "low" });
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });

  it("leaves the standard toast gate untouched when no thread exists", () => {
    notify({ type: "warning", correlationId: "fresh", message: "First", priority: "low" });
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });

  it("re-toasts an urgent same-severity thread child", () => {
    seedThread([seedEntry({ type: "info", correlationId: "build" })]);
    notify({
      type: "info",
      correlationId: "build",
      message: "Urgent update",
      priority: "low",
      urgent: true,
    });
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
  });

  it("stays inbox-only with seenAsToast=false when escalating while blurred (#10056)", () => {
    // A re-promotion fired into a blurred window would render unseen,
    // auto-dismiss, and be marked read — invisible to both the unread badge
    // and the re-entry summary. Blurred escalations must stay inbox-only.
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    seedThread([seedEntry({ type: "info", correlationId: "build" })]);
    notify({ type: "warning", correlationId: "build", message: "Build degraded", priority: "low" });
    expect(useNotificationStore.getState().notifications).toHaveLength(0);

    const entries = useNotificationHistoryStore.getState().entries;
    expect(entries).toHaveLength(2);
    const escalation = entries.find((e) => e.message === "Build degraded");
    expect(escalation?.seenAsToast).toBe(false);
    expect(useNotificationHistoryStore.getState().unreadCount).toBe(1);
  });

  it("urgent escalation while blurred also stays inbox-only (urgent bypasses quiet hours, not focus)", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    seedThread([seedEntry({ type: "info", correlationId: "build" })]);
    notify({
      type: "info",
      correlationId: "build",
      message: "Urgent update",
      priority: "low",
      urgent: true,
    });
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
    const urgentEntry = useNotificationHistoryStore
      .getState()
      .entries.find((e) => e.message === "Urgent update");
    expect(urgentEntry?.seenAsToast).toBe(false);
  });

  it("excludes archived entries from the escalation baseline", () => {
    // Active worst is "info"; an old archived "error" must not block escalation.
    seedThread([
      seedEntry({ type: "error", correlationId: "build", archivedAt: Date.now() - 5000 }),
      seedEntry({ type: "info", correlationId: "build", archivedAt: null }),
    ]);
    notify({ type: "warning", correlationId: "build", message: "Degraded", priority: "low" });
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
  });

  it("compares against the worst active entry in a mixed-severity thread", () => {
    seedThread([
      seedEntry({ type: "warning", correlationId: "build", archivedAt: null }),
      seedEntry({ type: "info", correlationId: "build", archivedAt: null }),
    ]);
    // Same as active worst → no re-toast.
    notify({ type: "warning", correlationId: "build", message: "Still warning", priority: "low" });
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });

  it("escalation re-toast still consumes the rate-limit bucket", () => {
    // Drain the per-source bucket with toasting notifications first.
    for (let i = 0; i < 4; i++) {
      notify({ type: "error", message: `m${i}`, rateLimitKey: "thread-rl" });
    }
    const toastsBefore = useNotificationStore.getState().notifications.length;
    seedThread([seedEntry({ type: "info", correlationId: "rl" })]);
    notify({
      type: "warning",
      correlationId: "rl",
      message: "escalated",
      priority: "low",
      rateLimitKey: "thread-rl",
    });
    // The bucket is exhausted, so the re-promoted toast is suppressed (routed
    // to the summary row) rather than bypassing the rate limiter.
    expect(useNotificationStore.getState().notifications.length).toBe(toastsBefore);
  });

  describe("snooze auto-resurface (#9200)", () => {
    it("clears the snooze when a thread escalates", () => {
      seedThread([seedEntry({ type: "info", correlationId: "build" })]);
      useNotificationHistoryStore.setState({
        snoozedThreads: { build: Date.now() + 60_000 },
      });
      notify({
        type: "warning",
        correlationId: "build",
        message: "Build degraded",
        priority: "low",
      });
      expect(useNotificationHistoryStore.getState().snoozedThreads["build"]).toBeUndefined();
    });

    it("keeps the snooze when a same-severity update lands on a snoozed thread", () => {
      seedThread([seedEntry({ type: "info", correlationId: "build" })]);
      const until = Date.now() + 60_000;
      useNotificationHistoryStore.setState({ snoozedThreads: { build: until } });
      notify({
        type: "info",
        correlationId: "build",
        message: "Still building",
        priority: "low",
      });
      expect(useNotificationHistoryStore.getState().snoozedThreads["build"]).toBe(until);
    });

    it("clears the snooze on an urgent payload regardless of severity", () => {
      seedThread([seedEntry({ type: "info", correlationId: "build" })]);
      useNotificationHistoryStore.setState({
        snoozedThreads: { build: Date.now() + 60_000 },
      });
      notify({
        type: "info",
        correlationId: "build",
        message: "Urgent ping",
        priority: "low",
        urgent: true,
      });
      expect(useNotificationHistoryStore.getState().snoozedThreads["build"]).toBeUndefined();
    });

    it("leaves snoozes on other correlationIds untouched", () => {
      seedThread([seedEntry({ type: "info", correlationId: "build" })]);
      const otherUntil = Date.now() + 60_000;
      useNotificationHistoryStore.setState({
        snoozedThreads: {
          build: Date.now() + 60_000,
          unrelated: otherUntil,
        },
      });
      notify({
        type: "warning",
        correlationId: "build",
        message: "Escalated",
        priority: "low",
      });
      const after = useNotificationHistoryStore.getState().snoozedThreads;
      expect(after["build"]).toBeUndefined();
      expect(after["unrelated"]).toBe(otherUntil);
    });

    it("does nothing when the incoming notify has no correlationId", () => {
      useNotificationHistoryStore.setState({
        snoozedThreads: { build: Date.now() + 60_000 },
      });
      notify({ type: "error", message: "Lone error", priority: "low" });
      expect(useNotificationHistoryStore.getState().snoozedThreads["build"]).toBeDefined();
    });

    it("clears the snooze when a snoozed thread escalates while blurred (no toast)", () => {
      // The toast stays focus-gated (#10056), but the escalation must still
      // un-snooze the thread: otherwise an error lands hidden behind a snooze
      // the user set on a milder thread and never reaches the unread badge.
      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      seedThread([seedEntry({ type: "info", correlationId: "build" })]);
      useNotificationHistoryStore.setState({
        snoozedThreads: { build: Date.now() + 60_000 },
      });
      notify({
        type: "error",
        correlationId: "build",
        message: "Build failed",
        priority: "low",
      });
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
      expect(useNotificationHistoryStore.getState().snoozedThreads["build"]).toBeUndefined();
      const escalation = useNotificationHistoryStore
        .getState()
        .entries.find((e) => e.message === "Build failed");
      expect(escalation?.seenAsToast).toBe(false);
      expect(useNotificationHistoryStore.getState().unreadCount).toBe(1);
    });

    it("keeps the snooze on a routine same-severity update while blurred", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      seedThread([seedEntry({ type: "info", correlationId: "build" })]);
      const until = Date.now() + 60_000;
      useNotificationHistoryStore.setState({ snoozedThreads: { build: until } });
      notify({
        type: "info",
        correlationId: "build",
        message: "Still building",
        priority: "low",
      });
      expect(useNotificationHistoryStore.getState().snoozedThreads["build"]).toBe(until);
    });

    it("watch-priority update on a snoozed thread clears the snooze even while blurred", () => {
      // `watch` bypasses the focus gate entirely, so the thread is actively
      // toasting — keeping its inbox rows hidden behind the snooze would
      // contradict the visible toast.
      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      seedThread([seedEntry({ type: "info", correlationId: "build" })]);
      useNotificationHistoryStore.setState({
        snoozedThreads: { build: Date.now() + 60_000 },
      });
      notify({
        type: "info",
        correlationId: "build",
        message: "Watch update",
        priority: "watch",
      });
      expect(useNotificationStore.getState().notifications).toHaveLength(1);
      expect(useNotificationHistoryStore.getState().snoozedThreads["build"]).toBeUndefined();
    });

    it("grid-bar path clears the snooze when the same predicate would re-promote", () => {
      seedThread([seedEntry({ type: "info", correlationId: "build" })]);
      useNotificationHistoryStore.setState({
        snoozedThreads: { build: Date.now() + 60_000 },
      });
      notify({
        type: "warning",
        correlationId: "build",
        message: "Inline status escalation",
        priority: "low",
        placement: "grid-bar",
      });
      expect(useNotificationHistoryStore.getState().snoozedThreads["build"]).toBeUndefined();
    });

    it("grid-bar path keeps the snooze on a routine same-severity update", () => {
      seedThread([seedEntry({ type: "info", correlationId: "build" })]);
      const until = Date.now() + 60_000;
      useNotificationHistoryStore.setState({ snoozedThreads: { build: until } });
      notify({
        type: "info",
        correlationId: "build",
        message: "Inline status routine update",
        priority: "low",
        placement: "grid-bar",
      });
      expect(useNotificationHistoryStore.getState().snoozedThreads["build"]).toBe(until);
    });
  });
});

describe("EVENT_POLICY manifest routing", () => {
  const ALL_EVENT_KINDS: NotificationEventKind[] = [
    "completed",
    "waiting",
    "workingPulse",
    "uiFeedback",
    "agent",
    "git",
    "host",
    "recovery",
    "settings",
    "connectivity",
  ];

  beforeEach(() => {
    useNotificationStore.setState({ notifications: [] });
    useNotificationHistoryStore.setState({ entries: [], unreadCount: 0 });
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
    _setQuietUntil(0);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("completeness", () => {
    it("defines a policy and label for every event kind", () => {
      for (const kind of ALL_EVENT_KINDS) {
        expect(EVENT_POLICY[kind]).toBeDefined();
        expect(EVENT_KIND_LABEL[kind]).toBeTruthy();
      }
    });

    it("maps only the silenceable kinds to a settings key", () => {
      expect(EVENT_KIND_TO_SETTING_KEY.completed).toBe("completedEnabled");
      expect(EVENT_KIND_TO_SETTING_KEY.waiting).toBe("waitingEnabled");
      expect(EVENT_KIND_TO_SETTING_KEY.workingPulse).toBe("workingPulseEnabled");
      expect(EVENT_KIND_TO_SETTING_KEY.uiFeedback).toBe("uiFeedbackSoundEnabled");
      // Routing-only kinds have no persisted silence toggle.
      expect(EVENT_KIND_TO_SETTING_KEY.host).toBeUndefined();
      expect(EVENT_KIND_TO_SETTING_KEY.git).toBeUndefined();
      expect(EVENT_KIND_TO_SETTING_KEY.recovery).toBeUndefined();
      expect(EVENT_KIND_TO_SETTING_KEY.connectivity).toBeUndefined();
    });
  });

  describe("priority resolution", () => {
    it("resolves an active kind to a high-priority toast when none supplied", () => {
      notify({ type: "info", message: "Git push done", context: { eventKind: "git" } });
      const active = useNotificationStore.getState().notifications;
      expect(active).toHaveLength(1);
      expect(active[0]!.priority).toBe("high");
    });

    it("resolves a passive kind to inbox-only (low priority)", () => {
      notify({ type: "info", message: "Setting saved", context: { eventKind: "settings" } });
      // Low priority routes to the inbox only — no active toast.
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
      expect(useNotificationHistoryStore.getState().entries).toHaveLength(1);
    });

    it.each(["workingPulse", "uiFeedback"] as const)(
      "keeps passive sound kind %s inbox-only when no priority supplied",
      (eventKind) => {
        // Guards against a passive→active regression that would start toasting.
        notify({ type: "info", message: "x", context: { eventKind } });
        expect(useNotificationStore.getState().notifications).toHaveLength(0);
        expect(useNotificationHistoryStore.getState().entries).toHaveLength(1);
      }
    );

    it("lets an explicit caller priority win over the policy default", () => {
      // git policy → high, but the caller pins low, so it must route to inbox only.
      notify({
        type: "info",
        message: "Quiet git note",
        priority: "low",
        context: { eventKind: "git" },
      });
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
      expect(useNotificationHistoryStore.getState().entries).toHaveLength(1);
    });

    it.each(["uiFeedback", "settings", "workingPulse"] as const)(
      "warns when a passive kind %s + transient resolves to a silent no-op",
      (eventKind) => {
        // No explicit priority → policy fills "low"; transient skips the inbox.
        // Low priority skips the toast. The notification fires nowhere, so the
        // policy-resolved case must warn (distinct from the explicit-low warn).
        vi.spyOn(document, "hasFocus").mockReturnValue(true);
        const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        notify({ type: "info", message: "x", transient: true, context: { eventKind } });
        expect(useNotificationStore.getState().notifications).toHaveLength(0);
        expect(useNotificationHistoryStore.getState().entries).toHaveLength(0);
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining("passive eventKind resolved to priority: 'low'")
        );
        consoleSpy.mockRestore();
      }
    );

    it("explicit priority: 'high' overrides the passive default so the transient toast fires", () => {
      // The call-site fix: passive kind + transient + explicit high → toast
      // shows, no inbox row, and the passive-policy no-op warn does not fire.
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      notify({
        type: "success",
        message: "Removed 3 worktrees",
        transient: true,
        priority: "high",
        context: { eventKind: "uiFeedback" },
      });
      expect(useNotificationStore.getState().notifications).toHaveLength(1);
      expect(useNotificationHistoryStore.getState().entries).toHaveLength(0);
      expect(consoleSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("passive eventKind resolved to priority: 'low'")
      );
      consoleSpy.mockRestore();
    });
  });

  describe("urgent / quiet-gate resolution", () => {
    it("bypasses the quiet gate for a time-sensitive kind", () => {
      _setQuietUntil(Date.now() + 60_000);
      notify({ type: "warning", message: "Disk low", context: { eventKind: "host" } });
      // host → time-sensitive → urgent, so the toast fires despite quiet.
      expect(useNotificationStore.getState().notifications).toHaveLength(1);
    });

    it("suppresses a non-time-sensitive kind during quiet", () => {
      _setQuietUntil(Date.now() + 60_000);
      notify({ type: "info", message: "Git note", context: { eventKind: "git" } });
      // git → active (no urgent), so quiet suppresses the toast.
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
    });
  });

  describe("duration resolution", () => {
    it("applies a policy defaultDurationMs when the caller omits duration", () => {
      notify({ type: "info", message: "Git push done", context: { eventKind: "git" } });
      const active = useNotificationStore.getState().notifications;
      expect(active[0]!.duration).toBe(EVENT_POLICY.git.defaultDurationMs);
    });

    it("lets an explicit caller duration win over the policy default", () => {
      notify({
        type: "info",
        message: "Git push done",
        duration: 9999,
        context: { eventKind: "git" },
      });
      expect(useNotificationStore.getState().notifications[0]!.duration).toBe(9999);
    });

    it("keeps action-bearing toasts sticky over the policy default", () => {
      notify({
        type: "info",
        message: "Git push done",
        context: { eventKind: "git" },
        action: { label: "View", onClick: () => {} },
      });
      // Sticky-action default (0) must win over git's defaultDurationMs.
      expect(useNotificationStore.getState().notifications[0]!.duration).toBe(0);
    });

    it("falls through to the per-type default for kinds without a policy duration", () => {
      // recovery has no defaultDurationMs → per-type warning default applies.
      notify({ type: "warning", message: "Settings reset", context: { eventKind: "recovery" } });
      expect(useNotificationStore.getState().notifications[0]!.duration).toBe(
        TOAST_DURATION.warning
      );
    });
  });

  describe("placement resolution", () => {
    it("leaves placement unset for auto-surface kinds", () => {
      notify({ type: "info", message: "Git push done", context: { eventKind: "git" } });
      expect(useNotificationStore.getState().notifications[0]!.placement).toBeUndefined();
    });
  });

  describe("no eventKind is unchanged", () => {
    it("uses the legacy defaults when no eventKind is present", () => {
      notify({ type: "info", message: "Plain note" });
      const active = useNotificationStore.getState().notifications;
      expect(active).toHaveLength(1);
      expect(active[0]!.priority).toBe("high");
      expect(active[0]!.duration).toBe(TOAST_DURATION.info);
    });
  });
});
