// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { notify } from "../notify";
import { useNotificationStore } from "../../store/notificationStore";
import { useNotificationHistoryStore } from "../../store/slices/notificationHistorySlice";

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
      expect(useNotificationHistoryStore.getState().entries[0].message).toBe("Task done");
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
      expect(useNotificationHistoryStore.getState().entries[0].message).toBe(
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
      expect(useNotificationHistoryStore.getState().entries[0].message).toBe("inbox message");
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
      expect(useNotificationHistoryStore.getState().entries[0].correlationId).toBe("panel-abc");
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
      expect(entry.actions).toHaveLength(1);
      expect(entry.actions![0]).toEqual({
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
      expect(entry.actions).toBeUndefined();
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
      expect(entry.actions).toHaveLength(1);
      expect(entry.actions![0].label).toBe("Has ID");
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
      expect(entry.actions).toHaveLength(1);
      expect(entry.actions![0].actionId).toBe("panel.focus");
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
      expect(entry.actions![0].variant).toBe("secondary");
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
      expect(useNotificationStore.getState().notifications[0].placement).toBe("grid-bar");
    });
  });

  describe("default priority", () => {
    it("defaults to high priority when not specified", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "success", message: "Default" });
      const notification = useNotificationStore.getState().notifications[0];
      expect(notification.priority).toBe("high");
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
      expect(useNotificationHistoryStore.getState().entries[0].seenAsToast).toBe(true);
    });

    it("seenAsToast is false when blurred + high (toast not shown)", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      notify({ type: "error", message: "Failed", priority: "high" });
      expect(useNotificationHistoryStore.getState().entries[0].seenAsToast).toBe(false);
    });

    it("seenAsToast is false for low priority regardless of focus (never toasts)", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      notify({ type: "info", message: "Silent", priority: "low" });
      expect(useNotificationHistoryStore.getState().entries[0].seenAsToast).toBe(false);
    });

    it("seenAsToast is true for watch priority (always toasts)", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      notify({ type: "warning", message: "Agent waiting", priority: "watch" });
      expect(useNotificationHistoryStore.getState().entries[0].seenAsToast).toBe(true);
    });

    it("seenAsToast is true for grid-bar placement (shown inline)", () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      notify({ type: "info", message: "Inline", priority: "low", placement: "grid-bar" });
      expect(useNotificationHistoryStore.getState().entries[0].seenAsToast).toBe(true);
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
});
