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

  describe("badge count — unreadCount only increments for missed notifications", () => {
    it("does not increment unreadCount when focused + high (toast was shown)", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "success", message: "Done", priority: "high" });
      expect(useNotificationHistoryStore.getState().unreadCount).toBe(0);
    });

    it("increments unreadCount when blurred + high (notification missed)", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({ type: "error", message: "Failed", priority: "high" });
      expect(useNotificationHistoryStore.getState().unreadCount).toBe(1);
    });

    it("increments unreadCount for low priority (never toasted)", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "info", message: "Silent", priority: "low" });
      expect(useNotificationHistoryStore.getState().unreadCount).toBe(1);
    });

    it("does not increment unreadCount for watch priority (always toasts)", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      notify({ type: "warning", message: "Agent waiting", priority: "watch" });
      expect(useNotificationHistoryStore.getState().unreadCount).toBe(0);
    });

    it("does not increment unreadCount when countable is false", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "success", message: "Silent success", priority: "low", countable: false });
      expect(useNotificationHistoryStore.getState().entries).toHaveLength(1);
      expect(useNotificationHistoryStore.getState().unreadCount).toBe(0);
    });

    it("does not increment unreadCount for grid-bar notifications (shown inline)", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      notify({ type: "info", message: "Inline", priority: "low", placement: "grid-bar" });
      expect(useNotificationHistoryStore.getState().unreadCount).toBe(0);
    });

    it("counts only blurred notifications across mixed session", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "success", message: "Seen 1", priority: "high" });
      notify({ type: "info", message: "Low 1", priority: "low" });

      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({ type: "error", message: "Missed 1", priority: "high" });
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({ type: "error", message: "Missed 2", priority: "high" });

      expect(useNotificationHistoryStore.getState().unreadCount).toBe(3);
    });
  });

  describe("toast cap — displaced notifications become unread in history", () => {
    // The 4 notifications below carry distinct `rateLimitKey` values so the
    // toaster-cap displacement path is exercised — same-source bursts are
    // now caught by the per-source rate-limiter (#8249) before reaching the
    // toaster cap.

    it("caps visible toasts at 3 when adding 4 focused high-priority notifications", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "info", message: "toast-1", priority: "high", rateLimitKey: "s1" });
      notify({ type: "info", message: "toast-2", priority: "high", rateLimitKey: "s2" });
      notify({ type: "info", message: "toast-3", priority: "high", rateLimitKey: "s3" });
      notify({ type: "info", message: "toast-4", priority: "high", rateLimitKey: "s4" });

      const notifications = useNotificationStore.getState().notifications;
      const active = notifications.filter((n) => !n.dismissed);
      expect(active).toHaveLength(3);
    });

    it("marks displaced toast's history entry as unread", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "info", message: "toast-1", priority: "high", rateLimitKey: "s1" });

      const firstEntry = useNotificationHistoryStore.getState().entries[0];
      expect(firstEntry!.seenAsToast).toBe(true);

      notify({ type: "info", message: "toast-2", priority: "high", rateLimitKey: "s2" });
      notify({ type: "info", message: "toast-3", priority: "high", rateLimitKey: "s3" });
      notify({ type: "info", message: "toast-4", priority: "high", rateLimitKey: "s4" });

      const updatedEntry = useNotificationHistoryStore
        .getState()
        .entries.find((e) => e.id === firstEntry!.id);
      expect(updatedEntry?.seenAsToast).toBe(false);
    });

    it("increments unreadCount when a toast is displaced", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "info", message: "toast-1", priority: "high", rateLimitKey: "s1" });
      notify({ type: "info", message: "toast-2", priority: "high", rateLimitKey: "s2" });
      notify({ type: "info", message: "toast-3", priority: "high", rateLimitKey: "s3" });
      expect(useNotificationHistoryStore.getState().unreadCount).toBe(0);

      notify({ type: "info", message: "toast-4", priority: "high", rateLimitKey: "s4" });
      expect(useNotificationHistoryStore.getState().unreadCount).toBe(1);
    });

    it("does not cap grid-bar notifications", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      for (let i = 0; i < 5; i++) {
        notify({ type: "info", message: `grid-${i}`, placement: "grid-bar" });
      }
      const active = useNotificationStore.getState().notifications.filter((n) => !n.dismissed);
      expect(active).toHaveLength(5);
    });
  });

  describe("master toggle — disabled suppresses toasts and native but keeps history", () => {
    beforeEach(() => {
      useNotificationSettingsStore.setState({ enabled: false });
    });

    it("still records to history when disabled", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "success", message: "Task done", priority: "high" });
      expect(useNotificationHistoryStore.getState().entries).toHaveLength(1);
      expect(useNotificationHistoryStore.getState().entries[0]!.message).toBe("Task done");
    });

    it("does not create toast when disabled and focused + high", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "success", message: "Done", priority: "high" });
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
    });

    it("does not show native notification when disabled and watch priority", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "warning", message: "Agent waiting", priority: "watch" });
      expect(mockShowNative).not.toHaveBeenCalled();
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
    });

    it("records history for grid-bar but skips toast when disabled", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const id = notify({ type: "info", message: "Inline bar", placement: "grid-bar" });
      expect(useNotificationHistoryStore.getState().entries).toHaveLength(1);
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
      expect(id).toBe("");
      expect(useNotificationHistoryStore.getState().entries[0]!.seenAsToast).toBe(false);
      expect(useNotificationHistoryStore.getState().unreadCount).toBe(1);
    });

    it("records urgent grid-bar as unread when disabled (bypasses quiet)", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const id = notify({
        type: "error",
        message: "Urgent bar",
        placement: "grid-bar",
        urgent: true,
      });
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
      expect(id).toBe("");
      expect(useNotificationHistoryStore.getState().entries[0]!.seenAsToast).toBe(false);
      expect(useNotificationHistoryStore.getState().unreadCount).toBe(1);
    });

    it("returns empty string when disabled", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const id = notify({ type: "success", message: "Done", priority: "high" });
      expect(id).toBe("");
    });

    it("marks history entries as not seen when disabled (increments unread)", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "success", message: "Task done", priority: "high" });
      const entry = useNotificationHistoryStore.getState().entries[0];
      expect(entry!.seenAsToast).toBe(false);
      expect(useNotificationHistoryStore.getState().unreadCount).toBe(1);
    });

    it("resumes normal routing when re-enabled", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "success", message: "Suppressed", priority: "high" });
      expect(useNotificationStore.getState().notifications).toHaveLength(0);

      useNotificationSettingsStore.setState({ enabled: true });
      notify({ type: "success", message: "Visible", priority: "high" });
      expect(useNotificationStore.getState().notifications).toHaveLength(1);
    });
  });

  describe("coalescing — merges rapid toasts with the same key", () => {
    const makeCoalescePayload = (key = "agent:completed", message = "Agent done") => ({
      type: "success" as const,
      message,
      priority: "high" as const,
      title: "Agent task completed",
      duration: 5000,
      coalesce: {
        key,
        windowMs: 15000,
        buildMessage: (count: number) => `${count} agents finished`,
        buildTitle: () => "Agent tasks completed",
        buildAction: (count: number) =>
          count > 1
            ? { label: "View all", onClick: () => {} }
            : { label: "Go to terminal", onClick: () => {} },
      },
    });

    it("coalesces two calls with same key into one toast", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const id1 = notify(makeCoalescePayload());
      const id2 = notify(makeCoalescePayload());

      expect(id1).toBe(id2);
      expect(useNotificationStore.getState().notifications).toHaveLength(1);
    });

    it("records each event individually in history with distinct messages", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify(makeCoalescePayload("agent:completed", "Agent 1 done"));
      notify(makeCoalescePayload("agent:completed", "Agent 2 done"));

      const entries = useNotificationHistoryStore.getState().entries;
      expect(entries).toHaveLength(2);
      expect(entries[0]!.message).toBe("Agent 2 done");
      expect(entries[1]!.message).toBe("Agent 1 done");
    });

    it("updates toast message and title on coalesce", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify(makeCoalescePayload());
      notify(makeCoalescePayload());

      const notification = useNotificationStore.getState().notifications[0];
      expect(notification!.message).toBe("2 agents finished");
      expect(notification!.title).toBe("Agent tasks completed");
    });

    it("updates action to multi-agent on coalesce", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify(makeCoalescePayload());
      notify(makeCoalescePayload());

      const notification = useNotificationStore.getState().notifications[0];
      expect(notification!.action?.label).toBe("View all");
    });

    it("clears stale per-item actions on coalesce when buildAction is provided", () => {
      // Regression: if the initial toast had `actions: [closeProj1, dismissProj1]`
      // and a second notification coalesced into it, the toaster kept rendering
      // the stale per-project buttons because the coalesce patch only updated
      // `action` (singular). When `buildAction` is defined, the caller owns the
      // action slot and `actions` must be cleared.
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const closeFn = vi.fn();
      const dismissFn = vi.fn();

      notify({
        type: "info",
        message: "proj-1 idle",
        priority: "high",
        actions: [
          { label: "Close Them", onClick: closeFn },
          { label: "Mute project", onClick: dismissFn },
        ],
        coalesce: {
          key: "idle-like",
          windowMs: 30_000,
          buildMessage: (count) => `${count} projects idle`,
          buildAction: (count) => (count > 1 ? { label: "View", onClick: vi.fn() } : undefined),
        },
      });

      // Same coalesce key — triggers the coalesce path.
      notify({
        type: "info",
        message: "proj-2 idle",
        priority: "high",
        actions: [
          { label: "Close Them", onClick: vi.fn() },
          { label: "Mute project", onClick: vi.fn() },
        ],
        coalesce: {
          key: "idle-like",
          windowMs: 30_000,
          buildMessage: (count) => `${count} projects idle`,
          buildAction: (count) => (count > 1 ? { label: "View", onClick: vi.fn() } : undefined),
        },
      });

      const notification = useNotificationStore.getState().notifications[0];
      expect(notification!.actions).toBeUndefined();
      expect(notification!.action?.label).toBe("View");
    });

    it("creates fresh toast after coalescing window expires", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const realDateNow = Date.now;

      let now = 1000;
      Date.now = () => now;

      const id1 = notify(makeCoalescePayload());

      now = 17000; // 16s later, past the 15s window
      const id2 = notify(makeCoalescePayload());

      expect(id1).not.toBe(id2);
      expect(useNotificationStore.getState().notifications).toHaveLength(2);

      Date.now = realDateNow;
    });

    it("refreshes window on each coalesced update", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const realDateNow = Date.now;

      let now = 1000;
      Date.now = () => now;

      const id1 = notify(makeCoalescePayload());

      now = 8000; // 7s later, within 15s window
      const id2 = notify(makeCoalescePayload());
      expect(id1).toBe(id2);

      now = 14000; // 6s after last update, still within refreshed window
      const id3 = notify(makeCoalescePayload());
      expect(id1).toBe(id3);

      expect(useNotificationStore.getState().notifications).toHaveLength(1);

      Date.now = realDateNow;
    });

    it("does not coalesce across different keys", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const id1 = notify(makeCoalescePayload("agent:completed"));
      const id2 = notify(makeCoalescePayload("agent:failed"));

      expect(id1).not.toBe(id2);
      expect(useNotificationStore.getState().notifications).toHaveLength(2);
    });

    it("starts fresh toast when existing toast is dismissed", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const id1 = notify(makeCoalescePayload());

      // Dismiss the toast
      useNotificationStore.getState().dismissNotification(id1);

      const id2 = notify(makeCoalescePayload());
      expect(id1).not.toBe(id2);
      expect(useNotificationStore.getState().notifications).toHaveLength(2);
    });

    it("does not coalesce when no coalesce option is provided", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "warning", message: "Waiting 1", priority: "high" });
      notify({ type: "warning", message: "Waiting 2", priority: "high" });

      expect(useNotificationStore.getState().notifications).toHaveLength(2);
    });

    it("sets updatedAt on coalesced notification", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify(makeCoalescePayload());
      const firstUpdatedAt = useNotificationStore.getState().notifications[0]!.updatedAt;

      notify(makeCoalescePayload());
      const secondUpdatedAt = useNotificationStore.getState().notifications[0]!.updatedAt;

      expect(secondUpdatedAt).toBeDefined();
      expect(secondUpdatedAt).toBeGreaterThanOrEqual(firstUpdatedAt!);
    });

    it("bounds the coalesce map at 200 entries under unique-key churn (#10842)", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const realDateNow = Date.now;
      Date.now = () => 1000; // freeze so no entry expires during the fill

      // 250 distinct keys would otherwise leave 250 add-only entries.
      for (let i = 0; i < 250; i++) {
        notify(makeCoalescePayload(`overflow:${i}`));
      }

      expect(_getActiveCoalescedSizeForTest()).toBe(200);

      Date.now = realDateNow;
    });

    it("does not self-evict a freshly created short-window entry at the cap (#10842)", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const realDateNow = Date.now;
      Date.now = () => 1000; // freeze so nothing expires mid-test

      // Saturate the cap with long-window entries.
      for (let i = 0; i < 200; i++) {
        notify(makeCoalescePayload(`bg:${i}`)); // windowMs 15000
      }

      // A new entry with the SMALLEST expiresAt must survive its own prune pass
      // — otherwise the eviction-by-expiresAt would drop the entry just set.
      const shortPayload = {
        type: "success" as const,
        message: "Short",
        priority: "high" as const,
        title: "Short",
        duration: 5000,
        coalesce: {
          key: "short-window",
          windowMs: 100,
          buildMessage: (count: number) => `${count} short`,
        },
      };
      const id1 = notify(shortPayload);
      // The immediate follow-up must coalesce into id1, proving the entry was
      // retained (a duplicate id would mean it was evicted then recreated).
      const id2 = notify(shortPayload);
      expect(id1).toBe(id2);

      Date.now = realDateNow;
    });

    it("drops expired coalesce entries on the next create (#10842)", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const realDateNow = Date.now;

      let now = 1000;
      Date.now = () => now;

      notify(makeCoalescePayload("expiring")); // expiresAt = 1000 + 15000
      expect(_getActiveCoalescedSizeForTest()).toBe(1);

      now = 20000; // past the 15s window
      notify(makeCoalescePayload("fresh"));

      // The expired "expiring" entry is swept; only "fresh" remains.
      expect(_getActiveCoalescedSizeForTest()).toBe(1);

      Date.now = realDateNow;
    });
  });

  describe("startup quiet period — suppresses toasts and native during boot", () => {
    it("suppresses toast for focused + high during quiet period", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const realDateNow = Date.now;
      const now = 1000;
      Date.now = () => now;
      _setQuietUntil(6000);

      notify({ type: "success", message: "Suppressed", priority: "high" });

      expect(useNotificationStore.getState().notifications).toHaveLength(0);
      Date.now = realDateNow;
    });

    it("suppresses OS native notification for watch during quiet period", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const realDateNow = Date.now;
      Date.now = () => 1000;
      _setQuietUntil(6000);

      notify({ type: "warning", message: "Agent waiting", priority: "watch" });

      expect(mockShowNative).not.toHaveBeenCalled();
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
      Date.now = realDateNow;
    });

    it("still adds history entry during quiet period", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const realDateNow = Date.now;
      Date.now = () => 1000;
      _setQuietUntil(6000);

      notify({ type: "success", message: "Quiet entry", priority: "high" });

      expect(useNotificationHistoryStore.getState().entries).toHaveLength(1);
      expect(useNotificationHistoryStore.getState().entries[0]!.message).toBe("Quiet entry");
      Date.now = realDateNow;
    });

    it("marks history as seenAsToast: false during quiet period", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const realDateNow = Date.now;
      Date.now = () => 1000;
      _setQuietUntil(6000);

      notify({ type: "success", message: "Unseen", priority: "high" });

      expect(useNotificationHistoryStore.getState().entries[0]!.seenAsToast).toBe(false);
      Date.now = realDateNow;
    });

    it("increments unreadCount during quiet period", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const realDateNow = Date.now;
      Date.now = () => 1000;
      _setQuietUntil(6000);

      notify({ type: "success", message: "Missed", priority: "high" });

      expect(useNotificationHistoryStore.getState().unreadCount).toBe(1);
      Date.now = realDateNow;
    });

    it("urgent: true bypasses the quiet period gate", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const realDateNow = Date.now;
      Date.now = () => 1000;
      _setQuietUntil(6000);

      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({ type: "error", message: "PTY failed", priority: "high", urgent: true });

      expect(useNotificationStore.getState().notifications).toHaveLength(1);
      Date.now = realDateNow;
    });

    it("resumes normal routing after quiet period expires", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const realDateNow = Date.now;

      Date.now = () => 1000;
      _setQuietUntil(6000);
      notify({ type: "success", message: "During quiet", priority: "high" });
      expect(useNotificationStore.getState().notifications).toHaveLength(0);

      Date.now = () => 7000;
      notify({ type: "success", message: "After quiet", priority: "high" });
      expect(useNotificationStore.getState().notifications).toHaveLength(1);

      Date.now = realDateNow;
    });

    it("returns empty string during quiet period", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const realDateNow = Date.now;
      Date.now = () => 1000;
      _setQuietUntil(6000);

      const id = notify({ type: "success", message: "Quiet", priority: "high" });

      expect(id).toBe("");
      Date.now = realDateNow;
    });

    it("suppresses grid-bar placement during quiet period", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const realDateNow = Date.now;
      Date.now = () => 1000;
      _setQuietUntil(6000);

      notify({ type: "info", message: "Grid bar quiet", placement: "grid-bar" });

      expect(useNotificationStore.getState().notifications).toHaveLength(0);
      expect(useNotificationHistoryStore.getState().entries).toHaveLength(1);
      expect(useNotificationHistoryStore.getState().entries[0]!.seenAsToast).toBe(false);
      Date.now = realDateNow;
    });

    it("urgent grid-bar notifications bypass quiet period", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const realDateNow = Date.now;
      Date.now = () => 1000;
      _setQuietUntil(6000);

      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({ type: "error", message: "Urgent bar", placement: "grid-bar", urgent: true });

      expect(useNotificationStore.getState().notifications).toHaveLength(1);
      Date.now = realDateNow;
    });

    it("watch priority with urgent: true shows native during quiet period", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const realDateNow = Date.now;
      Date.now = () => 1000;
      _setQuietUntil(6000);

      notify({ type: "warning", message: "Urgent watch", priority: "watch", urgent: true });

      expect(mockShowNative).toHaveBeenCalledOnce();
      expect(useNotificationStore.getState().notifications).toHaveLength(1);
      Date.now = realDateNow;
    });

    it("does not populate coalesce map during quiet period", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const realDateNow = Date.now;
      Date.now = () => 1000;
      _setQuietUntil(6000);

      notify({
        type: "success",
        message: "Coalesce quiet",
        priority: "high",
        coalesce: {
          key: "test:quiet",
          windowMs: 5000,
          buildMessage: (count: number) => `${count} items`,
        },
      });

      expect(useNotificationStore.getState().notifications).toHaveLength(0);

      Date.now = () => 7000;
      const id = notify({
        type: "success",
        message: "After quiet",
        priority: "high",
        coalesce: {
          key: "test:quiet",
          windowMs: 5000,
          buildMessage: (count: number) => `${count} items`,
        },
      });

      expect(useNotificationStore.getState().notifications).toHaveLength(1);
      expect(useNotificationStore.getState().notifications[0]!.message).toBe("After quiet");
      expect(id.length).toBeGreaterThan(0);
      Date.now = realDateNow;
    });

    it("low priority during quiet period still records to history", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const realDateNow = Date.now;
      Date.now = () => 1000;
      _setQuietUntil(6000);

      notify({ type: "info", message: "Low quiet", priority: "low" });

      expect(useNotificationHistoryStore.getState().entries).toHaveLength(1);
      expect(useNotificationHistoryStore.getState().entries[0]!.seenAsToast).toBe(false);
      Date.now = realDateNow;
    });
  });
});
