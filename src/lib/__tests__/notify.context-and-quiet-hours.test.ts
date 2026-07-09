// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  notify,
  _resetCoalesceMap,
  _getActiveCoalescedSizeForTest,
  _resetEscalationTrackers,
  _resetRateLimitBuckets,
  _resetOverflowAnnouncements,
  _setQuietUntil,
  muteForDuration,
  muteUntilNextMorning,
  isScheduledQuietHours,
  setActiveContextAccessors,
  _resetActiveContextAccessorsForTest,
  _resetPendingSuppressedForTest,
} from "../notify";
import { useNotificationStore } from "../../store/notificationStore";
import { useNotificationHistoryStore } from "../../store/slices/notificationHistorySlice";
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
describe("notify()", () => {
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
    mockShowNative.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("context — propagates projectId through history and toast", () => {
    it("stores context on the history entry", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({
        type: "info",
        message: "Project event",
        priority: "high",
        context: { projectId: "proj-1" },
      });
      const entry = useNotificationHistoryStore.getState().entries[0];
      expect(entry!.context).toEqual({ projectId: "proj-1" });
    });

    it("stores context on the active toast notification", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({
        type: "info",
        message: "Project event",
        priority: "high",
        context: { projectId: "proj-1", worktreeId: "wt-2" },
      });
      const notification = useNotificationStore.getState().notifications[0];
      expect(notification!.context).toEqual({ projectId: "proj-1", worktreeId: "wt-2" });
    });

    it("stores context on grid-bar history entries", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({
        type: "info",
        message: "Inline bar",
        placement: "grid-bar",
        context: { projectId: "proj-2" },
      });
      const entry = useNotificationHistoryStore.getState().entries[0];
      expect(entry!.context).toEqual({ projectId: "proj-2" });
    });

    it("omits context on history entry when none supplied", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "info", message: "No ctx", priority: "high" });
      const entry = useNotificationHistoryStore.getState().entries[0];
      expect(entry!.context).toBeUndefined();
    });

    it("clears context on coalesce when the incoming projectId differs from the existing one", () => {
      // Regression: the combined toast no longer represents a single project,
      // so the "Mute project notifications" affordance must disappear rather
      // than silently dispatch with the first project's ID.
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({
        type: "info",
        message: "Project A hibernated",
        priority: "high",
        context: { projectId: "A" },
        coalesce: {
          key: "hibernation:project",
          windowMs: 10_000,
          buildMessage: (count) => `${count} projects hibernated`,
        },
      });
      notify({
        type: "info",
        message: "Project B hibernated",
        priority: "high",
        context: { projectId: "B" },
        coalesce: {
          key: "hibernation:project",
          windowMs: 10_000,
          buildMessage: (count) => `${count} projects hibernated`,
        },
      });

      const notifications = useNotificationStore.getState().notifications;
      expect(notifications).toHaveLength(1);
      expect(notifications[0]!.context).toBeUndefined();
    });

    it("preserves context on coalesce when the incoming projectId matches", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const payload = {
        type: "info" as const,
        message: "Same project",
        priority: "high" as const,
        context: { projectId: "A" },
        coalesce: {
          key: "same-proj",
          windowMs: 10_000,
          buildMessage: (count: number) => `${count} events`,
        },
      };
      notify(payload);
      notify(payload);

      const notifications = useNotificationStore.getState().notifications;
      expect(notifications).toHaveLength(1);
      expect(notifications[0]!.context).toEqual({ projectId: "A" });
    });
  });

  describe("active-context suppression — surface already on screen", () => {
    let activeWorktreeId: string | null = null;
    let focusedPanelId: string | null = null;
    let listeners: Array<() => void> = [];

    function setActiveWorktree(id: string | null): void {
      activeWorktreeId = id;
      for (const cb of listeners) cb();
    }
    function setFocusedPanel(id: string | null): void {
      focusedPanelId = id;
      for (const cb of listeners) cb();
    }

    beforeEach(() => {
      vi.useFakeTimers();
      activeWorktreeId = null;
      focusedPanelId = null;
      listeners = [];
      setActiveContextAccessors({
        getActiveWorktreeId: () => activeWorktreeId,
        getFocusedPanelId: () => focusedPanelId,
        subscribeActiveContext: (cb) => {
          listeners.push(cb);
          return () => {
            listeners = listeners.filter((fn) => fn !== cb);
          };
        },
      });
      _resetPendingSuppressedForTest();
    });

    afterEach(() => {
      _resetPendingSuppressedForTest();
      _resetActiveContextAccessorsForTest();
      vi.useRealTimers();
    });

    it("suppresses toast when context.worktreeId matches active worktree", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      setActiveWorktree("wt-1");
      notify({
        type: "info",
        message: "Agent done",
        priority: "high",
        context: { worktreeId: "wt-1" },
      });
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
      const entries = useNotificationHistoryStore.getState().entries;
      expect(entries).toHaveLength(1);
      expect(entries[0]!.seenAsToast).toBe(true);
    });

    it("suppresses toast when context.panelId matches focused panel", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      setFocusedPanel("panel-1");
      notify({
        type: "info",
        message: "Panel event",
        priority: "high",
        context: { panelId: "panel-1" },
      });
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
      expect(useNotificationHistoryStore.getState().entries).toHaveLength(1);
    });

    it("does not suppress when only projectId is supplied", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      setActiveWorktree("wt-1");
      notify({
        type: "info",
        message: "Project event",
        priority: "high",
        context: { projectId: "proj-1" },
      });
      expect(useNotificationStore.getState().notifications).toHaveLength(1);
    });

    it("does not suppress when context.worktreeId differs from active", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      setActiveWorktree("wt-1");
      notify({
        type: "info",
        message: "Other worktree",
        priority: "high",
        context: { worktreeId: "wt-2" },
      });
      expect(useNotificationStore.getState().notifications).toHaveLength(1);
    });

    it("does not suppress when window is blurred (no toast either, existing behavior)", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      setActiveWorktree("wt-1");
      notify({
        type: "info",
        message: "Background",
        priority: "high",
        context: { worktreeId: "wt-1" },
      });
      // Blurred + high → no toast, history only — same as without suppression.
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
      const entries = useNotificationHistoryStore.getState().entries;
      expect(entries).toHaveLength(1);
      // Not seen — they will pick it up from the inbox when they refocus.
      expect(entries[0]!.seenAsToast).toBe(false);
    });

    it("does not suppress watch-priority notifications", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      setActiveWorktree("wt-1");
      notify({
        type: "warning",
        message: "Watch event",
        priority: "watch",
        context: { worktreeId: "wt-1" },
      });
      expect(useNotificationStore.getState().notifications).toHaveLength(1);
    });

    it("low priority is unaffected (history only, no grace)", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      setActiveWorktree("wt-1");
      notify({
        type: "info",
        message: "Background only",
        priority: "low",
        context: { worktreeId: "wt-1" },
      });
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
      // Navigating away within 500ms should NOT promote a low-priority event.
      setActiveWorktree("wt-2");
      vi.advanceTimersByTime(500);
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
    });

    it("grid-bar placement bypasses suppression (always inline)", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      setActiveWorktree("wt-1");
      notify({
        type: "info",
        message: "Inline bar",
        placement: "grid-bar",
        context: { worktreeId: "wt-1" },
      });
      expect(useNotificationStore.getState().notifications).toHaveLength(1);
    });

    it("promotes to toast when active worktree changes within 500ms", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      setActiveWorktree("wt-1");
      notify({
        type: "info",
        message: "Should promote",
        priority: "high",
        context: { worktreeId: "wt-1" },
      });
      expect(useNotificationStore.getState().notifications).toHaveLength(0);

      vi.advanceTimersByTime(100);
      setActiveWorktree("wt-2");
      expect(useNotificationStore.getState().notifications).toHaveLength(1);
      expect(useNotificationStore.getState().notifications[0]!.message).toBe("Should promote");
    });

    it("promotes to toast when focused panel changes within 500ms", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      setFocusedPanel("panel-1");
      notify({
        type: "info",
        message: "Panel signal",
        priority: "high",
        context: { panelId: "panel-1" },
      });
      expect(useNotificationStore.getState().notifications).toHaveLength(0);

      setFocusedPanel("panel-2");
      expect(useNotificationStore.getState().notifications).toHaveLength(1);
    });

    it("does not promote when context remains visible through grace window", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      setActiveWorktree("wt-1");
      notify({
        type: "info",
        message: "Stays suppressed",
        priority: "high",
        context: { worktreeId: "wt-1" },
      });
      vi.advanceTimersByTime(600);
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
    });

    it("re-firing into the same surface after grace resets the suppression cleanly", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      setActiveWorktree("wt-1");
      notify({
        type: "info",
        message: "first",
        priority: "high",
        context: { worktreeId: "wt-1" },
      });
      vi.advanceTimersByTime(600);
      notify({
        type: "info",
        message: "second",
        priority: "high",
        context: { worktreeId: "wt-1" },
      });
      vi.advanceTimersByTime(600);
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
      expect(useNotificationHistoryStore.getState().entries).toHaveLength(2);
    });

    it("does not promote if notifications get disabled during the grace window", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      setActiveWorktree("wt-1");
      notify({
        type: "info",
        message: "Will not toast",
        priority: "high",
        context: { worktreeId: "wt-1" },
      });
      useNotificationSettingsStore.setState({ enabled: false });
      setActiveWorktree("wt-2");
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
    });

    it("does not promote if quiet hours start during the grace window", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      setActiveWorktree("wt-1");
      notify({
        type: "info",
        message: "Will not toast",
        priority: "high",
        context: { worktreeId: "wt-1" },
      });
      _setQuietUntil(Date.now() + 60_000);
      setActiveWorktree("wt-2");
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
    });

    it("urgent flag promotes through quiet hours", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      setActiveWorktree("wt-1");
      notify({
        type: "warning",
        message: "Urgent suppressed",
        priority: "high",
        urgent: true,
        context: { worktreeId: "wt-1" },
      });
      _setQuietUntil(Date.now() + 60_000);
      setActiveWorktree("wt-2");
      expect(useNotificationStore.getState().notifications).toHaveLength(1);
    });

    it("falls back to no suppression when no accessors are registered", () => {
      _resetActiveContextAccessorsForTest();
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({
        type: "info",
        message: "No accessors",
        priority: "high",
        context: { worktreeId: "wt-1" },
      });
      expect(useNotificationStore.getState().notifications).toHaveLength(1);
    });

    it("defers blur promotion until refocus instead of toasting into a blurred window (#10056)", () => {
      // Alt-tab without changing worktree/panel doesn't fire a context
      // subscriber. Promoting immediately on blur would fire the toast into
      // a blurred window where it auto-dismisses unseen, so the decision is
      // deferred to a one-shot refocus listener; the grace drop-timer pauses
      // while blurred so the pending entry isn't silently dropped meanwhile.
      const focusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(true);
      setActiveWorktree("wt-1");
      notify({
        type: "info",
        message: "Alt-tab signal",
        priority: "high",
        context: { worktreeId: "wt-1" },
      });
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
      const entryId = useNotificationHistoryStore.getState().entries[0]!.id;

      focusSpy.mockReturnValue(false);
      window.dispatchEvent(new Event("blur"));
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
      // Well past SUPPRESS_GRACE_MS — the paused timer must not drop the entry
      // (the grace entry is written seenAsToast=true for the inline-visible
      // origin, so a drop while blurred would swallow the signal marked-read).
      vi.advanceTimersByTime(5_000);
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
      expect(useNotificationHistoryStore.getState().entries[0]!.seenAsToast).toBe(true);

      // The worktree changed while blurred without a subscriber tick (e.g.
      // restored session state) — origin is no longer visible on refocus, so
      // the missed signal promotes to a toast the user can actually see.
      activeWorktreeId = "wt-2";
      focusSpy.mockReturnValue(true);
      window.dispatchEvent(new Event("focus"));
      const notifications = useNotificationStore.getState().notifications;
      expect(notifications).toHaveLength(1);
      expect(notifications[0]!.message).toBe("Alt-tab signal");
      expect(notifications[0]!.historyEntryId).toBe(entryId);
    });

    it("refocusing onto the still-visible origin surface resumes the grace countdown", () => {
      const focusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(true);
      setActiveWorktree("wt-1");
      notify({
        type: "info",
        message: "Back to same surface",
        priority: "high",
        context: { worktreeId: "wt-1" },
      });
      focusSpy.mockReturnValue(false);
      window.dispatchEvent(new Event("blur"));
      vi.advanceTimersByTime(5_000);

      // User returns to the surface where the signal is visible inline — no
      // toast; the grace countdown restarts instead.
      focusSpy.mockReturnValue(true);
      window.dispatchEvent(new Event("focus"));
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
      vi.advanceTimersByTime(501);
      // Once the restarted grace elapses on the visible surface, the entry is
      // considered seen — a later navigate-away no longer promotes.
      setActiveWorktree("wt-2");
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
    });

    it("repeated blurs arm a single one-shot refocus promotion", () => {
      const focusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(true);
      setActiveWorktree("wt-1");
      notify({
        type: "info",
        message: "One-shot",
        priority: "high",
        context: { worktreeId: "wt-1" },
      });
      focusSpy.mockReturnValue(false);
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("blur"));

      activeWorktreeId = "wt-2";
      focusSpy.mockReturnValue(true);
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
      expect(useNotificationStore.getState().notifications).toHaveLength(1);
    });

    it("context change while blurred defers promotion to refocus instead of toasting blind", () => {
      const focusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(true);
      setActiveWorktree("wt-1");
      notify({
        type: "info",
        message: "Nav while blurred",
        priority: "high",
        context: { worktreeId: "wt-1" },
      });
      focusSpy.mockReturnValue(false);
      window.dispatchEvent(new Event("blur"));
      // A subscriber tick while blurred must not toast into the invisible
      // window — the armed refocus listener owns the promotion.
      setActiveWorktree("wt-2");
      expect(useNotificationStore.getState().notifications).toHaveLength(0);

      focusSpy.mockReturnValue(true);
      window.dispatchEvent(new Event("focus"));
      expect(useNotificationStore.getState().notifications).toHaveLength(1);
      // And only once — cleanup removed the one-shot listener.
      window.dispatchEvent(new Event("focus"));
      expect(useNotificationStore.getState().notifications).toHaveLength(1);
    });

    it("reset clears the deferred refocus listener", () => {
      const focusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(true);
      setActiveWorktree("wt-1");
      notify({
        type: "info",
        message: "Torn down",
        priority: "high",
        context: { worktreeId: "wt-1" },
      });
      focusSpy.mockReturnValue(false);
      window.dispatchEvent(new Event("blur"));
      _resetPendingSuppressedForTest();

      activeWorktreeId = "wt-2";
      focusSpy.mockReturnValue(true);
      window.dispatchEvent(new Event("focus"));
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
    });

    it("promoted toast carries the same historyEntryId as the suppressed entry", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      setActiveWorktree("wt-1");
      notify({
        type: "info",
        message: "linked",
        priority: "high",
        context: { worktreeId: "wt-1" },
      });
      const entryId = useNotificationHistoryStore.getState().entries[0]!.id;
      setActiveWorktree("wt-2");
      const toast = useNotificationStore.getState().notifications[0];
      expect(toast?.historyEntryId).toBe(entryId);
    });

    it("does not promote when subscriber fires after grace expires", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      setActiveWorktree("wt-1");
      notify({
        type: "info",
        message: "Late nav",
        priority: "high",
        context: { worktreeId: "wt-1" },
      });
      vi.advanceTimersByTime(501);
      setActiveWorktree("wt-2");
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
    });

    it("watch priority with matching surface still toasts (no suppression for watch)", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      setActiveWorktree("wt-1");
      notify({
        type: "warning",
        message: "Watch in scope",
        priority: "watch",
        context: { worktreeId: "wt-1" },
      });
      expect(useNotificationStore.getState().notifications).toHaveLength(1);
      expect(mockShowNative).toHaveBeenCalledTimes(1);
    });

    it("_resetPendingSuppressedForTest clears pending grace timers and listeners", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      setActiveWorktree("wt-1");
      notify({
        type: "info",
        message: "cancelled",
        priority: "high",
        context: { worktreeId: "wt-1" },
      });
      _resetPendingSuppressedForTest();
      // Navigating away should NOT promote — the listener was cleaned up.
      setActiveWorktree("wt-2");
      vi.advanceTimersByTime(600);
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
    });
  });

  describe("quiet hours schedule", () => {
    it("isScheduledQuietHours returns false when disabled", () => {
      useNotificationSettingsStore.setState({
        quietHoursEnabled: false,
        quietHoursStartMin: 0,
        quietHoursEndMin: 24 * 60 - 1,
      });
      expect(isScheduledQuietHours(new Date(2024, 0, 1, 12, 0))).toBe(false);
    });

    it("isScheduledQuietHours returns true within the configured window", () => {
      useNotificationSettingsStore.setState({
        quietHoursEnabled: true,
        quietHoursStartMin: 22 * 60,
        quietHoursEndMin: 6 * 60,
        quietHoursWeekdays: [],
      });
      expect(isScheduledQuietHours(new Date(2024, 0, 1, 23, 0))).toBe(true);
    });

    it("suppresses non-urgent toast during scheduled quiet hours", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      useNotificationSettingsStore.setState({
        quietHoursEnabled: true,
        quietHoursStartMin: 22 * 60,
        quietHoursEndMin: 6 * 60,
      });
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2024, 0, 1, 23, 0));

      notify({ type: "success", message: "Scheduled quiet", priority: "high" });

      expect(useNotificationStore.getState().notifications).toHaveLength(0);
      expect(useNotificationHistoryStore.getState().entries).toHaveLength(1);
      expect(useNotificationHistoryStore.getState().entries[0]!.seenAsToast).toBe(false);

      vi.useRealTimers();
    });

    it("allows toast outside the scheduled window", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      useNotificationSettingsStore.setState({
        quietHoursEnabled: true,
        quietHoursStartMin: 22 * 60,
        quietHoursEndMin: 6 * 60,
      });
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2024, 0, 1, 14, 0));

      notify({ type: "success", message: "Afternoon", priority: "high" });

      expect(useNotificationStore.getState().notifications).toHaveLength(1);
      vi.useRealTimers();
    });

    it("urgent: true bypasses the scheduled window", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      useNotificationSettingsStore.setState({
        quietHoursEnabled: true,
        quietHoursStartMin: 22 * 60,
        quietHoursEndMin: 6 * 60,
      });
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2024, 0, 1, 23, 0));

      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({ type: "error", message: "Critical", priority: "high", urgent: true });

      expect(useNotificationStore.getState().notifications).toHaveLength(1);
      vi.useRealTimers();
    });

    it("suppresses OS native notification for watch priority during the window", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      useNotificationSettingsStore.setState({
        quietHoursEnabled: true,
        quietHoursStartMin: 22 * 60,
        quietHoursEndMin: 6 * 60,
      });
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2024, 0, 1, 23, 0));

      notify({ type: "warning", message: "Quiet watch", priority: "watch" });

      expect(mockShowNative).not.toHaveBeenCalled();
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
      vi.useRealTimers();
    });

    it("respects weekday filter — skips days not in the list", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      useNotificationSettingsStore.setState({
        quietHoursEnabled: true,
        quietHoursStartMin: 22 * 60,
        quietHoursEndMin: 23 * 60,
        quietHoursWeekdays: [1, 2, 3, 4, 5], // weekdays only
      });
      vi.useFakeTimers();
      // 2024-01-06 is a Saturday
      vi.setSystemTime(new Date(2024, 0, 6, 22, 30));

      notify({ type: "success", message: "Weekend", priority: "high" });

      expect(useNotificationStore.getState().notifications).toHaveLength(1);
      vi.useRealTimers();
    });

    it("records history during schedule quiet with seenAsToast=false", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      useNotificationSettingsStore.setState({
        quietHoursEnabled: true,
        quietHoursStartMin: 22 * 60,
        quietHoursEndMin: 6 * 60,
      });
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2024, 0, 1, 23, 0));

      notify({ type: "success", message: "Inbox only", priority: "high" });

      const entries = useNotificationHistoryStore.getState().entries;
      expect(entries).toHaveLength(1);
      expect(entries[0]!.seenAsToast).toBe(false);
      vi.useRealTimers();
    });
  });

  describe("session mute helpers", () => {
    afterEach(() => {
      _setQuietUntil(0);
    });

    it("muteForDuration sets _quietUntil to now + duration", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2024, 0, 1, 12, 0));
      const until = muteForDuration(60 * 60 * 1000);
      expect(until).toBe(Date.now() + 60 * 60 * 1000);

      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "info", message: "Muted", priority: "high" });
      expect(useNotificationStore.getState().notifications).toHaveLength(0);

      vi.useRealTimers();
    });

    it("muteForDuration mirrors the timestamp to the main process", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2024, 0, 1, 12, 0));
      const until = muteForDuration(60 * 60 * 1000);
      expect(mockSetSessionMute).toHaveBeenCalledWith(until);
      vi.useRealTimers();
    });

    it("muteForDuration mirrors the timestamp into the settings store", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2024, 0, 1, 12, 0));
      const until = muteForDuration(30 * 60 * 1000);
      expect(useNotificationSettingsStore.getState().quietUntil).toBe(until);
      vi.useRealTimers();
    });

    it("muteUntilNextMorning mirrors the timestamp into the settings store", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2024, 0, 1, 23, 0));
      const until = muteUntilNextMorning();
      expect(useNotificationSettingsStore.getState().quietUntil).toBe(until);
      vi.useRealTimers();
    });

    it("_setQuietUntil (startup path) does NOT mirror to the settings store", () => {
      // Startup quiet windows must not flip the toolbar to BellOff during boot.
      useNotificationSettingsStore.setState({ quietUntil: 0 });
      _setQuietUntil(Date.now() + 5_000);
      expect(useNotificationSettingsStore.getState().quietUntil).toBe(0);
    });

    it("muteUntilNextMorning mirrors the timestamp to the main process", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2024, 0, 1, 23, 0));
      const until = muteUntilNextMorning();
      expect(mockSetSessionMute).toHaveBeenCalledWith(until);
      vi.useRealTimers();
    });

    it("muteUntilNextMorning mutes until next 08:00", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2024, 0, 1, 23, 0));
      const until = muteUntilNextMorning();
      expect(new Date(until).getHours()).toBe(8);
      expect(new Date(until).getDate()).toBe(2);
      vi.useRealTimers();
    });

    it("muteUntilNextMorning picks tomorrow when already past 08:00", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2024, 0, 1, 10, 0));
      const until = muteUntilNextMorning();
      expect(new Date(until).getHours()).toBe(8);
      expect(new Date(until).getDate()).toBe(2);
      vi.useRealTimers();
    });
  });
});
