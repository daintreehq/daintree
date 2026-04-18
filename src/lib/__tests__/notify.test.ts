// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { notify, _resetCoalesceMap, _resetComboMap, _setQuietUntil } from "../notify";
import { useNotificationStore } from "../../store/notificationStore";
import { useNotificationHistoryStore } from "../../store/slices/notificationHistorySlice";
import { useNotificationSettingsStore } from "../../store/notificationSettingsStore";

const mockShowNative = vi.fn();

beforeEach(() => {
  Object.defineProperty(window, "electron", {
    value: { notification: { showNative: mockShowNative } },
    writable: true,
    configurable: true,
  });
});

describe("notify()", () => {
  beforeEach(() => {
    useNotificationStore.setState({ notifications: [] });
    useNotificationHistoryStore.setState({ entries: [], unreadCount: 0 });
    useNotificationSettingsStore.setState({ enabled: true, hydrated: true });
    _resetCoalesceMap();
    _resetComboMap();
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

    it("skips history entry if no string message and no inboxMessage", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({
        type: "info",
        message: null as unknown as string,
        priority: "low",
      });
      expect(useNotificationHistoryStore.getState().entries).toHaveLength(0);
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
      notify({ type: "error", message: "Build failed", priority: "high" });
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
      expect(mockShowNative).not.toHaveBeenCalled();
    });

    it("still adds to history when blurred + high", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(false);
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
      notify({ type: "error", message: "Missed 1", priority: "high" });
      notify({ type: "error", message: "Missed 2", priority: "high" });

      expect(useNotificationHistoryStore.getState().unreadCount).toBe(3);
    });
  });

  describe("toast cap — displaced notifications become unread in history", () => {
    it("caps visible toasts at 3 when adding 4 focused high-priority notifications", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "info", message: "toast-1", priority: "high" });
      notify({ type: "info", message: "toast-2", priority: "high" });
      notify({ type: "info", message: "toast-3", priority: "high" });
      notify({ type: "info", message: "toast-4", priority: "high" });

      const notifications = useNotificationStore.getState().notifications;
      const active = notifications.filter((n) => !n.dismissed);
      expect(active).toHaveLength(3);
    });

    it("marks displaced toast's history entry as unread", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "info", message: "toast-1", priority: "high" });

      const firstEntry = useNotificationHistoryStore.getState().entries[0];
      expect(firstEntry!.seenAsToast).toBe(true);

      notify({ type: "info", message: "toast-2", priority: "high" });
      notify({ type: "info", message: "toast-3", priority: "high" });
      notify({ type: "info", message: "toast-4", priority: "high" });

      const updatedEntry = useNotificationHistoryStore
        .getState()
        .entries.find((e) => e.id === firstEntry!.id);
      expect(updatedEntry?.seenAsToast).toBe(false);
    });

    it("increments unreadCount when a toast is displaced", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "info", message: "toast-1", priority: "high" });
      notify({ type: "info", message: "toast-2", priority: "high" });
      notify({ type: "info", message: "toast-3", priority: "high" });
      expect(useNotificationHistoryStore.getState().unreadCount).toBe(0);

      notify({ type: "info", message: "toast-4", priority: "high" });
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
          { label: "Dismiss", onClick: dismissFn },
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
          { label: "Dismiss", onClick: vi.fn() },
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

  describe("combo — escalating messages on rapid repeats", () => {
    const comboPayload = (message = "Agent spawned") => ({
      type: "success" as const,
      message,
      priority: "high" as const,
      countable: false,
      combo: {
        key: "agent:spawn",
        tiers: ["Agent spawned", "Double agent", "Triple agent", "Sleeper cell activated"],
        windowMs: 2000,
      },
    });

    it("first call uses tier 0 message", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify(comboPayload());
      const n = useNotificationStore.getState().notifications[0];
      expect(n!.message).toBe("Agent spawned");
    });

    it("second call within window uses tier 1", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify(comboPayload());
      notify(comboPayload());
      const notifications = useNotificationStore.getState().notifications;
      expect(notifications).toHaveLength(2);
      expect(notifications[1]!.message).toBe("Double agent");
    });

    it("third call within window uses tier 2", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify(comboPayload());
      notify(comboPayload());
      notify(comboPayload());
      const notifications = useNotificationStore.getState().notifications;
      expect(notifications[2]!.message).toBe("Triple agent");
    });

    it("calls beyond last tier loop on final tier", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      for (let i = 0; i < 6; i++) notify(comboPayload());
      const notifications = useNotificationStore.getState().notifications;
      expect(notifications[3]!.message).toBe("Sleeper cell activated");
      expect(notifications[4]!.message).toBe("Sleeper cell activated");
      expect(notifications[5]!.message).toBe("Sleeper cell activated");
    });

    it("resets to tier 0 after window expires", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const realDateNow = Date.now;

      let now = 1000;
      Date.now = () => now;

      notify(comboPayload());
      notify(comboPayload());

      now = 4000; // 3s later, past 2s window
      notify(comboPayload());

      const notifications = useNotificationStore.getState().notifications;
      expect(notifications[1]!.message).toBe("Double agent");
      expect(notifications[2]!.message).toBe("Agent spawned"); // reset

      Date.now = realDateNow;
    });

    it("does not increment during quiet period", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const realDateNow = Date.now;
      Date.now = () => 1000;
      _setQuietUntil(6000);

      notify(comboPayload());
      notify(comboPayload());

      expect(useNotificationStore.getState().notifications).toHaveLength(0);

      Date.now = () => 7000;
      notify(comboPayload());

      const notifications = useNotificationStore.getState().notifications;
      expect(notifications).toHaveLength(1);
      expect(notifications[0]!.message).toBe("Agent spawned"); // tier 0, not escalated

      Date.now = realDateNow;
    });

    it("does not increment when notifications are disabled", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      useNotificationSettingsStore.setState({ enabled: false });

      notify(comboPayload());
      notify(comboPayload());

      useNotificationSettingsStore.setState({ enabled: true });
      notify(comboPayload());

      const notifications = useNotificationStore.getState().notifications;
      expect(notifications).toHaveLength(1);
      expect(notifications[0]!.message).toBe("Agent spawned"); // tier 0
    });

    it("does not increment when blurred + high (shouldToast false)", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(false);

      notify(comboPayload());
      notify(comboPayload());

      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify(comboPayload());

      const notifications = useNotificationStore.getState().notifications;
      expect(notifications).toHaveLength(1);
      expect(notifications[0]!.message).toBe("Agent spawned"); // tier 0
    });

    it("each combo call creates a separate toast (not coalesced)", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const id1 = notify(comboPayload());
      const id2 = notify(comboPayload());

      expect(id1).not.toBe(id2);
      expect(useNotificationStore.getState().notifications).toHaveLength(2);
    });

    it("history retains original message while toast escalates", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify(comboPayload());
      notify(comboPayload());

      const entries = useNotificationHistoryStore.getState().entries;
      expect(entries).toHaveLength(2);
      expect(entries[0]!.message).toBe("Agent spawned");
      expect(entries[1]!.message).toBe("Agent spawned");

      const notifications = useNotificationStore.getState().notifications;
      expect(notifications[1]!.message).toBe("Double agent");
    });

    it("works with watch priority and fires native notification", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      notify({
        ...comboPayload(),
        priority: "watch",
      });
      notify({
        ...comboPayload(),
        priority: "watch",
      });

      const notifications = useNotificationStore.getState().notifications;
      expect(notifications).toHaveLength(2);
      expect(notifications[0]!.message).toBe("Agent spawned");
      expect(notifications[1]!.message).toBe("Double agent");
      expect(mockShowNative).toHaveBeenCalledTimes(2);
    });

    it("independent combo keys track separately", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);

      notify(comboPayload());
      notify(comboPayload());

      notify({
        type: "success",
        message: "Worktree created",
        priority: "high",
        combo: {
          key: "worktree:create",
          tiers: ["Worktree created", "Branching out", "It's a tree farm"],
        },
      });

      const notifications = useNotificationStore.getState().notifications;
      expect(notifications[1]!.message).toBe("Double agent");
      expect(notifications[2]!.message).toBe("Worktree created"); // tier 0 for different key
    });
  });
});
