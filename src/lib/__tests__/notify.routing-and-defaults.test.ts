// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  notify,
  TOAST_DURATION,
  _resetCoalesceMap,
  _getActiveCoalescedSizeForTest,
  _resetEscalationTrackers,
  _resetRateLimitBuckets,
  _resetOverflowAnnouncements,
  _setQuietUntil,
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

    // The ReactNode-without-inboxMessage shape is now a compile error (see
    // NotifyPayload's discriminated union). The runtime guard that previously
    // mirrored that check was removed; if a caller bypasses the type system
    // with `as any`, the history entry is still silently dropped — that is
    // the intentional fallback, not a regression.
    it("skips history entry if ReactNode message and no inboxMessage (runtime fallback)", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const jsxElement = React.createElement("span", null, "test");
      notify({
        type: "info",
        message: jsxElement,
        priority: "low",
      } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(useNotificationHistoryStore.getState().entries).toHaveLength(0);
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

    it("string message without inboxMessage is type-legal and writes the history entry", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "info", message: "Just a string", priority: "low" });
      expect(useNotificationHistoryStore.getState().entries).toHaveLength(1);
    });

    it("empty-string inboxMessage with ReactNode message drops the history entry (runtime fallback)", () => {
      // The type allows `inboxMessage: ""` (it is a string), but the runtime
      // treats empty as "no inbox text" and skips the entry — same fallback
      // as the bypassed-type case above. Callers should pass a non-empty
      // fallback; we don't enforce a NonEmptyString at the type level.
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const jsxElement = React.createElement("span", null, "test");
      notify({
        type: "info",
        message: jsxElement,
        inboxMessage: "",
        priority: "low",
      });
      expect(useNotificationHistoryStore.getState().entries).toHaveLength(0);
    });

    // These cases assert the NotifyPayload discriminated union's shape. The
    // runtime behaviour is incidental — the value of the assertion is a
    // compile-time type check ensuring @ts-expect-error directives remain valid
    // (removing them must produce an unused-directive diagnostic if the union
    // ever widens, e.g. inboxMessage drifts back to optional on the ReactNode arm).
    describe("NotifyPayload type contract (compile-time enforcement)", () => {
      it("rejects ReactNode message without inboxMessage", () => {
        // Wrapped in a no-op factory so the unused-variable check still fires
        // on the `notify` call itself rather than on the surrounding payload.
        const make = () =>
          // @ts-expect-error ReactNode message requires inboxMessage
          notify({ type: "info", message: React.createElement("span", null, "x") });
        expect(typeof make).toBe("function");
      });

      it("accepts ReactNode message with inboxMessage", () => {
        const make = () =>
          notify({
            type: "info",
            message: React.createElement("span", null, "x"),
            inboxMessage: "plain",
          });
        expect(typeof make).toBe("function");
      });

      it("accepts string message without inboxMessage", () => {
        const make = () => notify({ type: "info", message: "plain" });
        expect(typeof make).toBe("function");
      });
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
    it("applies an 8s default for error notifications", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({ type: "error", message: "Something failed" });
      const notification = useNotificationStore.getState().notifications[0];
      expect(notification!.duration).toBe(8000);
      expect(notification!.duration).toBe(TOAST_DURATION.error);
    });

    it("applies an 8s default for warning notifications", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "warning", message: "Heads up" });
      const notification = useNotificationStore.getState().notifications[0];
      expect(notification!.duration).toBe(8000);
      expect(notification!.duration).toBe(TOAST_DURATION.warning);
    });

    it("applies a 5s default for success notifications", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "success", message: "Saved" });
      const notification = useNotificationStore.getState().notifications[0];
      expect(notification!.duration).toBe(5000);
      expect(notification!.duration).toBe(TOAST_DURATION.success);
    });

    it("applies a 6s default for info notifications", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "info", message: "FYI" });
      const notification = useNotificationStore.getState().notifications[0];
      expect(notification!.duration).toBe(6000);
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
});
