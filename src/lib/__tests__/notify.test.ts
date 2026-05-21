// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  notify,
  TOAST_DURATION,
  _resetCoalesceMap,
  _resetEscalationTrackers,
  _resetRateLimitBuckets,
  shouldEscalateTransientError,
  consumeEscalation,
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

  describe("history — always adds to inbox", () => {
    it("adds string message to history for high priority", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "success", message: "Task done", priority: "high" });
      expect(useNotificationHistoryStore.getState().entries).toHaveLength(1);
      expect(useNotificationHistoryStore.getState().entries[0]!.message).toBe("Task done");
    });

    it("adds string message to history for low priority", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "info", message: "Background update", priority: "low" });
      expect(useNotificationHistoryStore.getState().entries).toHaveLength(1);
    });

    it("adds string message to history for watch priority", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "warning", message: "Agent waiting", priority: "watch" });
      expect(useNotificationHistoryStore.getState().entries).toHaveLength(1);
    });

    it("uses inboxMessage for history when provided", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({
        type: "info",
        message: "rich content",
        inboxMessage: "plain text for history",
        priority: "low",
      });
      expect(useNotificationHistoryStore.getState().entries[0]!.message).toBe(
        "plain text for history"
      );
    });

    it("prefers inboxMessage over message for history", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({
        type: "info",
        message: "display message",
        inboxMessage: "inbox message",
        priority: "high",
      });
      expect(useNotificationHistoryStore.getState().entries[0]!.message).toBe("inbox message");
    });

    it("skips history entry if ReactNode message and no inboxMessage", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const jsxElement = React.createElement("span", null, "test");
      notify({
        type: "info",
        message: jsxElement,
        priority: "low",
      } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(useNotificationHistoryStore.getState().entries).toHaveLength(0);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("[notify] ReactNode message without inboxMessage")
      );
      consoleSpy.mockRestore();
    });

    it("creates history entry when ReactNode message provides inboxMessage", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const jsxElement = React.createElement("span", null, "rich");
      notify({
        type: "info",
        message: jsxElement,
        inboxMessage: "Plain text fallback",
        priority: "low",
      });
      expect(useNotificationHistoryStore.getState().entries).toHaveLength(1);
      expect(useNotificationHistoryStore.getState().entries[0]!.message).toBe(
        "Plain text fallback"
      );
    });

    it("does NOT log dev guard for string message without inboxMessage", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      notify({ type: "info", message: "Just a string", priority: "low" });
      expect(consoleSpy).not.toHaveBeenCalled();
      expect(useNotificationHistoryStore.getState().entries).toHaveLength(1);
      consoleSpy.mockRestore();
    });

    it("logs dev guard when ReactNode message has empty-string inboxMessage", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const jsxElement = React.createElement("span", null, "test");
      notify({
        type: "info",
        message: jsxElement,
        inboxMessage: "",
        priority: "low",
      });
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("[notify] ReactNode message without inboxMessage")
      );
      consoleSpy.mockRestore();
    });

    it("stores correlationId in history entry", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({
        type: "success",
        message: "Agent done",
        priority: "high",
        correlationId: "panel-abc",
      });
      expect(useNotificationHistoryStore.getState().entries[0]!.correlationId).toBe("panel-abc");
    });

    it("forwards supersedeKey to the history entry", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({
        type: "error",
        message: "Disconnected",
        priority: "high",
        supersedeKey: "host.conn",
      });
      expect(useNotificationHistoryStore.getState().entries[0]!.supersedeKey).toBe("host.conn");
    });

    it("supersedeKey on a later notify archives the prior matching entry", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({
        type: "error",
        message: "Disconnected",
        priority: "high",
        supersedeKey: "host.conn",
      });
      const errId = useNotificationHistoryStore.getState().entries[0]!.id;
      notify({
        type: "success",
        message: "Reconnected",
        priority: "high",
        supersedeKey: "host.conn",
      });
      const entries = useNotificationHistoryStore.getState().entries;
      expect(entries.find((e) => e.id === errId)!.archivedAt).not.toBeNull();
    });

    it("supersedes (exact id) on a later notify archives the named entry", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({
        type: "error",
        message: "Disconnected",
        priority: "high",
      });
      const errId = useNotificationHistoryStore.getState().entries[0]!.id;
      notify({
        type: "success",
        message: "Recovered",
        priority: "high",
        supersedes: errId,
      });
      expect(
        useNotificationHistoryStore.getState().entries.find((e) => e.id === errId)!.archivedAt
      ).not.toBeNull();
    });

    it("supersede has no effect when fields are absent (existing callers unchanged)", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "info", message: "a", priority: "high" });
      notify({ type: "info", message: "b", priority: "high" });
      const entries = useNotificationHistoryStore.getState().entries;
      expect(entries.every((e) => e.archivedAt === null)).toBe(true);
    });
  });

  describe("history actions — forwards serializable descriptors", () => {
    it("stores actions in history when action has actionId", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({
        type: "success",
        message: "Agent done",
        priority: "high",
        action: {
          label: "Go to terminal",
          onClick: () => {},
          actionId: "panel.focus",
          actionArgs: { panelId: "p1" },
        },
      });
      const entry = useNotificationHistoryStore.getState().entries[0];
      expect(entry!.actions).toHaveLength(1);
      expect(entry!.actions![0]).toEqual({
        label: "Go to terminal",
        actionId: "panel.focus",
        actionArgs: { panelId: "p1" },
        variant: undefined,
      });
    });

    it("does not store actions when action has only onClick (no actionId)", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({
        type: "info",
        message: "No descriptor",
        priority: "high",
        action: { label: "Click me", onClick: () => {} },
      });
      const entry = useNotificationHistoryStore.getState().entries[0];
      expect(entry!.actions).toBeUndefined();
    });

    it("filters mixed actions array to only descriptor-backed ones", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({
        type: "info",
        message: "Mixed",
        priority: "high",
        actions: [
          { label: "No ID", onClick: () => {} },
          {
            label: "Has ID",
            onClick: () => {},
            actionId: "panel.focus",
            actionArgs: { panelId: "p2" },
          },
        ],
      });
      const entry = useNotificationHistoryStore.getState().entries[0];
      expect(entry!.actions).toHaveLength(1);
      expect(entry!.actions![0]!.label).toBe("Has ID");
    });

    it("forwards actions to history in grid-bar path", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({
        type: "info",
        message: "Grid bar",
        placement: "grid-bar",
        action: {
          label: "Retry",
          onClick: () => {},
          actionId: "panel.focus",
          actionArgs: { panelId: "p3" },
        },
      });
      const entry = useNotificationHistoryStore.getState().entries[0];
      expect(entry!.actions).toHaveLength(1);
      expect(entry!.actions![0]!.actionId).toBe("panel.focus");
    });

    it("preserves variant in history action", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({
        type: "info",
        message: "With variant",
        priority: "high",
        action: {
          label: "Secondary",
          onClick: () => {},
          actionId: "panel.focus",
          variant: "secondary",
        },
      });
      const entry = useNotificationHistoryStore.getState().entries[0];
      expect(entry!.actions![0]!.variant).toBe("secondary");
    });

    it("combines actions from both action and actions fields", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({
        type: "info",
        message: "Combined",
        priority: "high",
        action: {
          label: "Single",
          onClick: () => {},
          actionId: "panel.focus",
          actionArgs: { panelId: "p1" },
        },
        actions: [
          {
            label: "Array",
            onClick: () => {},
            actionId: "panel.focus",
            actionArgs: { panelId: "p2" },
          },
        ],
      });
      const entry = useNotificationHistoryStore.getState().entries[0];
      expect(entry!.actions).toHaveLength(2);
      expect(entry!.actions![0]!.actionArgs).toEqual({ panelId: "p2" });
      expect(entry!.actions![1]!.actionArgs).toEqual({ panelId: "p1" });
    });
  });

  describe("transient — toast only, no inbox entry", () => {
    it("skips history entry when transient is true", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({
        type: "info",
        title: "Path copied",
        message: "/Users/me/project",
        transient: true,
      });
      expect(useNotificationHistoryStore.getState().entries).toHaveLength(0);
      expect(useNotificationHistoryStore.getState().unreadCount).toBe(0);
    });

    it("still shows the toast when transient is true", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({
        type: "success",
        title: "Shortcuts exported",
        message: "Saved.",
        transient: true,
      });
      expect(useNotificationStore.getState().notifications).toHaveLength(1);
      expect(useNotificationStore.getState().notifications[0]!.historyEntryId).toBeUndefined();
    });

    it("skips history for grid-bar placement when transient", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({
        type: "info",
        message: "Inline confirmation",
        placement: "grid-bar",
        transient: true,
      });
      expect(useNotificationHistoryStore.getState().entries).toHaveLength(0);
      expect(useNotificationStore.getState().notifications).toHaveLength(1);
    });

    it("still writes history when transient is false or omitted", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "success", message: "Default behavior" });
      expect(useNotificationHistoryStore.getState().entries).toHaveLength(1);
    });

    it("transient + priority: 'low' is a silent no-op", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      notify({ type: "info", message: "Nope", priority: "low", transient: true });
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
      expect(useNotificationHistoryStore.getState().entries).toHaveLength(0);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("transient: true with priority: 'low'")
      );
      consoleSpy.mockRestore();
    });

    it("transient + priority: 'watch' still fires native with no inbox", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "warning", message: "Watch me", priority: "watch", transient: true });
      expect(useNotificationStore.getState().notifications).toHaveLength(1);
      expect(useNotificationHistoryStore.getState().entries).toHaveLength(0);
      expect(mockShowNative).toHaveBeenCalledOnce();
    });

    it("transient + urgent during quiet period still fires the toast", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      _setQuietUntil(Date.now() + 10_000);
      notify({
        type: "info",
        message: "Mute confirmation",
        priority: "high",
        transient: true,
        urgent: true,
      });
      expect(useNotificationStore.getState().notifications).toHaveLength(1);
      expect(useNotificationHistoryStore.getState().entries).toHaveLength(0);
    });

    it("warns and drops silently when transient is paired with a visible origin context", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      setActiveContextAccessors({
        getActiveWorktreeId: () => "wt-1",
        getFocusedPanelId: () => null,
        subscribeActiveContext: () => () => {},
      });
      try {
        notify({
          type: "info",
          message: "Origin visible",
          priority: "high",
          transient: true,
          context: { worktreeId: "wt-1" },
        });
        expect(useNotificationStore.getState().notifications).toHaveLength(0);
        expect(useNotificationHistoryStore.getState().entries).toHaveLength(0);
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining("transient: true with context")
        );
      } finally {
        _resetActiveContextAccessorsForTest();
        _resetPendingSuppressedForTest();
        consoleSpy.mockRestore();
      }
    });
  });

  describe("routing — focused + high → toast only", () => {
    it("adds toast notification when focused + high", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "success", message: "Done", priority: "high" });
      expect(useNotificationStore.getState().notifications).toHaveLength(1);
      expect(mockShowNative).not.toHaveBeenCalled();
    });
  });

  describe("routing — focused + low → history only", () => {
    it("does not add toast when focused + low", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "info", message: "Silent", priority: "low" });
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
      expect(mockShowNative).not.toHaveBeenCalled();
    });
  });

  describe("routing — blurred + high → history only", () => {
    it("does NOT toast or show OS native when blurred + high", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({ type: "error", message: "Build failed", priority: "high" });
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
      expect(mockShowNative).not.toHaveBeenCalled();
    });

    it("still adds to history when blurred + high", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({ type: "error", title: "Build Error", message: "Compile failed", priority: "high" });
      expect(useNotificationHistoryStore.getState().entries).toHaveLength(1);
      expect(mockShowNative).not.toHaveBeenCalled();
    });
  });

  describe("routing — blurred + low → history only", () => {
    it("shows nothing when blurred + low", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      notify({ type: "info", message: "Background", priority: "low" });
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
      expect(mockShowNative).not.toHaveBeenCalled();
    });
  });

  describe("routing — watch → always toast + OS native", () => {
    it("shows both toast and OS native when focused + watch", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "warning", message: "Agent waiting", priority: "watch" });
      expect(useNotificationStore.getState().notifications).toHaveLength(1);
      expect(mockShowNative).toHaveBeenCalledOnce();
    });

    it("shows both toast and OS native when blurred + watch", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      notify({ type: "success", message: "Task complete", priority: "watch" });
      expect(useNotificationStore.getState().notifications).toHaveLength(1);
      expect(mockShowNative).toHaveBeenCalledOnce();
    });
  });

  describe("routing — grid-bar bypasses priority routing", () => {
    it("always adds to notification store for grid-bar placement regardless of priority", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      notify({ type: "info", message: "Inline bar", priority: "low", placement: "grid-bar" });
      expect(useNotificationStore.getState().notifications).toHaveLength(1);
      expect(useNotificationStore.getState().notifications[0]!.placement).toBe("grid-bar");
    });
  });

  describe("default priority", () => {
    it("defaults to high priority when not specified", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "success", message: "Default" });
      const notification = useNotificationStore.getState().notifications[0];
      expect(notification!.priority).toBe("high");
    });
  });

  describe("default duration — action-bearing toasts persist", () => {
    it("defaults duration to 0 when `action` is present and duration is undefined", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({
        type: "info",
        message: "Undo?",
        action: { label: "Undo", onClick: () => {} },
      });
      const notification = useNotificationStore.getState().notifications[0];
      expect(notification!.duration).toBe(0);
    });

    it("defaults duration to 0 when `actions` is non-empty and duration is undefined", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({
        type: "warning",
        message: "Retry?",
        actions: [
          { label: "Retry", onClick: () => {} },
          { label: "Cancel", onClick: () => {} },
        ],
      });
      const notification = useNotificationStore.getState().notifications[0];
      expect(notification!.duration).toBe(0);
    });

    it("preserves an explicit positive duration when action is present", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({
        type: "info",
        message: "Timed action",
        action: { label: "Retry", onClick: () => {} },
        duration: 5000,
      });
      const notification = useNotificationStore.getState().notifications[0];
      expect(notification!.duration).toBe(5000);
    });

    it("preserves an explicit duration of 0 (redundant but valid)", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({
        type: "info",
        message: "Persist",
        action: { label: "Undo", onClick: () => {} },
        duration: 0,
      });
      const notification = useNotificationStore.getState().notifications[0];
      expect(notification!.duration).toBe(0);
    });

    it("applies the severity-based default when no action is present", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "success", message: "Done" });
      const notification = useNotificationStore.getState().notifications[0];
      expect(notification!.duration).toBe(TOAST_DURATION.success);
    });

    it("applies the severity-based default when `actions` is an empty array", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "info", message: "No actions", actions: [] });
      const notification = useNotificationStore.getState().notifications[0];
      expect(notification!.duration).toBe(TOAST_DURATION.info);
    });

    it("applies the persist default on the grid-bar placement path", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({
        type: "info",
        message: "Inline",
        placement: "grid-bar",
        action: { label: "Acknowledge", onClick: () => {} },
      });
      const notification = useNotificationStore.getState().notifications[0];
      expect(notification!.placement).toBe("grid-bar");
      expect(notification!.duration).toBe(0);
    });

    it("applies the persist default on the coalesce-create path", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({
        type: "info",
        message: "First",
        action: { label: "Open", onClick: () => {} },
        coalesce: {
          key: "coalesce-persist",
          buildMessage: (n) => `${n} events`,
        },
      });
      const notification = useNotificationStore.getState().notifications[0];
      expect(notification!.duration).toBe(0);
    });

    it("applies the persist default on coalesce-update when buildAction introduces an action", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      // First event: no action → duration falls back to severity default (info).
      notify({
        type: "info",
        message: "First",
        coalesce: {
          key: "coalesce-add-action",
          buildMessage: (n) => `${n} events`,
          buildAction: (n) => (n > 1 ? { label: "Review", onClick: () => {} } : undefined),
        },
      });
      expect(useNotificationStore.getState().notifications[0]!.duration).toBe(TOAST_DURATION.info);

      // Second event: buildAction now returns an action → duration should become 0.
      notify({
        type: "info",
        message: "Second",
        coalesce: {
          key: "coalesce-add-action",
          buildMessage: (n) => `${n} events`,
          buildAction: (n) => (n > 1 ? { label: "Review", onClick: () => {} } : undefined),
        },
      });
      const notification = useNotificationStore.getState().notifications[0];
      expect(notification!.action).toBeDefined();
      expect(notification!.duration).toBe(0);
    });

    it("preserves stored duration on coalesce-update when duration was explicitly set", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      // First event sets duration explicitly to 5000 — update must not override.
      notify({
        type: "info",
        message: "First",
        duration: 5000,
        coalesce: {
          key: "coalesce-keep-duration",
          buildMessage: (n) => `${n} events`,
          buildAction: () => ({ label: "Review", onClick: () => {} }),
        },
      });
      notify({
        type: "info",
        message: "Second",
        coalesce: {
          key: "coalesce-keep-duration",
          buildMessage: (n) => `${n} events`,
          buildAction: () => ({ label: "Review", onClick: () => {} }),
        },
      });
      const notification = useNotificationStore.getState().notifications[0];
      expect(notification!.duration).toBe(5000);
    });
  });

  describe("default duration — severity-based defaults", () => {
    it("applies a 12s default for error notifications", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({ type: "error", message: "Something failed" });
      const notification = useNotificationStore.getState().notifications[0];
      expect(notification!.duration).toBe(12000);
      expect(notification!.duration).toBe(TOAST_DURATION.error);
    });

    it("applies a 12s default for warning notifications", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "warning", message: "Heads up" });
      const notification = useNotificationStore.getState().notifications[0];
      expect(notification!.duration).toBe(12000);
      expect(notification!.duration).toBe(TOAST_DURATION.warning);
    });

    it("applies a 5s default for success notifications", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "success", message: "Saved" });
      const notification = useNotificationStore.getState().notifications[0];
      expect(notification!.duration).toBe(5000);
      expect(notification!.duration).toBe(TOAST_DURATION.success);
    });

    it("applies an 8s default for info notifications", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "info", message: "FYI" });
      const notification = useNotificationStore.getState().notifications[0];
      expect(notification!.duration).toBe(8000);
      expect(notification!.duration).toBe(TOAST_DURATION.info);
    });

    it("preserves an explicit caller duration over the severity default", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({ type: "error", message: "Custom timing", duration: 7500 });
      const notification = useNotificationStore.getState().notifications[0];
      expect(notification!.duration).toBe(7500);
    });

    it("action-bearing rule wins over severity default (sticky for actions)", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({
        type: "error",
        message: "Try again?",
        action: { label: "Retry", onClick: () => {} },
      });
      const notification = useNotificationStore.getState().notifications[0];
      expect(notification!.duration).toBe(0);
    });
  });

  describe("return value", () => {
    it("returns notification id for toast notifications", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const id = notify({ type: "success", message: "Done", priority: "high" });
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    });

    it("returns empty string for low-priority (no toast created)", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const id = notify({ type: "info", message: "Silent", priority: "low" });
      expect(id).toBe("");
    });
  });

  describe("seenAsToast — entry field reflects toast delivery", () => {
    it("seenAsToast is true when focused + high (toast was shown)", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "success", message: "Done", priority: "high" });
      expect(useNotificationHistoryStore.getState().entries[0]!.seenAsToast).toBe(true);
    });

    it("seenAsToast is false when blurred + high (toast not shown)", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({ type: "error", message: "Failed", priority: "high" });
      expect(useNotificationHistoryStore.getState().entries[0]!.seenAsToast).toBe(false);
    });

    it("seenAsToast is false for low priority regardless of focus (never toasts)", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "info", message: "Silent", priority: "low" });
      expect(useNotificationHistoryStore.getState().entries[0]!.seenAsToast).toBe(false);
    });

    it("seenAsToast is true for watch priority (always toasts)", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      notify({ type: "warning", message: "Agent waiting", priority: "watch" });
      expect(useNotificationHistoryStore.getState().entries[0]!.seenAsToast).toBe(true);
    });

    it("seenAsToast is true for grid-bar placement (shown inline)", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      notify({ type: "info", message: "Inline", priority: "low", placement: "grid-bar" });
      expect(useNotificationHistoryStore.getState().entries[0]!.seenAsToast).toBe(true);
    });
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

    it("promotes to toast on window blur during grace window", () => {
      // Alt-tab without changing worktree/panel doesn't fire a context
      // subscriber, so without the blur fallback the timer would silently
      // drop the notification with seenAsToast=true.
      const focusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(true);
      setActiveWorktree("wt-1");
      notify({
        type: "info",
        message: "Alt-tab signal",
        priority: "high",
        context: { worktreeId: "wt-1" },
      });
      expect(useNotificationStore.getState().notifications).toHaveLength(0);

      focusSpy.mockReturnValue(false);
      window.dispatchEvent(new Event("blur"));
      expect(useNotificationStore.getState().notifications).toHaveLength(1);
      expect(useNotificationStore.getState().notifications[0]!.message).toBe("Alt-tab signal");
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
});
