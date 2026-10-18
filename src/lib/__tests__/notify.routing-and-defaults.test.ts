// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  notify,
  TOAST_DURATION,
  EVENT_POLICY,
  EVENT_KIND_TO_SETTING_KEY,
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

    it("replaceKey dismisses the live toast and retires the inbox row it replaces (#13505)", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const firstId = notify({
        type: "info",
        message: "Run r1 waiting",
        replaceKey: "plugin:acme:r1",
        rateLimitKey: "a",
      });
      notify({ type: "info", message: "Other", replaceKey: "plugin:acme:r2", rateLimitKey: "b" });
      const secondId = notify({
        type: "info",
        message: "Run r1 still waiting",
        replaceKey: "plugin:acme:r1",
        rateLimitKey: "c",
      });

      const live = useNotificationStore.getState().notifications.filter((n) => !n.dismissed);
      expect(live.map((n) => n.message)).toEqual(["Other", "Run r1 still waiting"]);
      expect(live.some((n) => n.id === firstId)).toBe(false);
      expect(secondId).not.toBe("");

      const rows = useNotificationHistoryStore.getState().entries;
      const active = rows.filter((e) => !e.archivedAt).map((e) => e.message);
      expect(active).toContain("Run r1 still waiting");
      expect(active).toContain("Other");
      expect(active).not.toContain("Run r1 waiting");
    });

    it("a rate-limited replacement still replaces the inbox row and keeps its buttons", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const open = (runId: string) => ({
        label: "Open",
        actionId: "acme.openRun" as never,
        actionArgs: { runId },
        onClick: () => {},
      });
      for (const n of [1, 2, 3]) {
        notify({
          type: "info",
          message: `burst ${n}`,
          rateLimitKey: "plugin:acme:notify",
          replaceKey: `burst-${n}`,
        });
      }
      notify({
        type: "info",
        message: "v1",
        rateLimitKey: "plugin:acme:notify",
        replaceKey: "k",
        actions: [open("old")],
      });
      notify({
        type: "info",
        message: "v2",
        rateLimitKey: "plugin:acme:notify",
        replaceKey: "k",
        actions: [open("new")],
      });

      const rows = useNotificationHistoryStore
        .getState()
        .entries.filter((e) => !e.archivedAt && e.supersedeKey === "k");
      expect(rows.map((e) => e.message)).toEqual(["v2"]);
      expect(rows[0]!.actions?.[0]?.actionArgs).toEqual({ runId: "new" });
      // No overflow summary beside it: the replacement's own row is the record.
      const active = useNotificationHistoryStore.getState().entries.filter((e) => !e.archivedAt);
      expect(active.map((e) => e.message).sort()).toEqual(["burst 1", "burst 2", "burst 3", "v2"]);
    });

    it("replaceKey retires the old toast even when the replacement is held back", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "info", message: "first", replaceKey: "k" });
      _setQuietUntil(Date.now() + 60_000);
      notify({ type: "info", message: "second", replaceKey: "k" });

      expect(useNotificationStore.getState().notifications.filter((n) => !n.dismissed)).toEqual([]);
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

    it("forwards an explicit `actions: undefined` through to the store's collapse clear", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      // eslint-disable-next-line no-restricted-syntax -- notify-event-kind: ok
      notify({
        type: "success",
        title: "Update ready",
        message: "Version 2.5.0 is ready to install.",
        correlationId: "collapse-clear",
        duration: 0,
        actions: [{ label: "View release notes", onClick: () => {} }],
      });
      // eslint-disable-next-line no-restricted-syntax -- notify-event-kind: ok
      notify({
        type: "info",
        title: "Update available",
        message: "Version 2.5.1 is downloading...",
        correlationId: "collapse-clear",
        duration: 0,
        actions: undefined,
      });

      // The store's clear branch keys off `"actions" in payload`, so this only
      // works if notify() forwards an own key whose value is undefined. A future
      // normalization that strips undefined fields would silently resurrect
      // stale actions while the hook and store unit tests both stayed green.
      const live = useNotificationStore.getState().notifications;
      expect(live).toHaveLength(1);
      expect(live[0]!.actions).toBeUndefined();
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

    it("toasts a transient payload whose addressed origin is visible, without warning", () => {
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
        expect(useNotificationStore.getState().notifications).toHaveLength(1);
        expect(useNotificationHistoryStore.getState().entries).toHaveLength(0);
        expect(consoleSpy).not.toHaveBeenCalled();
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
  });

  describe("routing — watch → always toast + OS native", () => {
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
    it("preserves an explicit caller duration over the severity default", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({ type: "error", message: "Custom timing", duration: 7500 });
      const notification = useNotificationStore.getState().notifications[0];
      expect(notification!.duration).toBe(7500);
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
});
