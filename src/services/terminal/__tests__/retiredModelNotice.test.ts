// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetRateLimitBuckets, _setQuietUntil } from "@/lib/notify";
import { useNotificationStore } from "@/store/notificationStore";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";
import { notifyRetiredModelDropped } from "../retiredModelNotice";

function liveBars() {
  return useNotificationStore.getState().notifications.filter((n) => !n.dismissed);
}

function inboxRows() {
  return useNotificationHistoryStore.getState().entries.filter((e) => e.archivedAt === null);
}

describe("notifyRetiredModelDropped", () => {
  let now = 1_000_000;

  beforeEach(() => {
    Object.defineProperty(window, "electron", {
      value: {
        notification: {
          showNative: vi.fn(),
          setSettings: vi.fn().mockResolvedValue(undefined),
          setSessionMuteUntil: vi.fn(),
        },
      },
      writable: true,
      configurable: true,
    });
    useNotificationStore.setState({ notifications: [] });
    useNotificationHistoryStore.setState({ entries: [], unreadCount: 0 });
    useNotificationSettingsStore.setState({
      enabled: true,
      hydrated: true,
      quietHoursEnabled: false,
      quietHoursWeekdays: [],
    });
    _resetRateLimitBuckets();
    _setQuietUntil(0);
    now += 60_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("names the model and the pane it was taken from", () => {
    notifyRetiredModelDropped("copilot", ["claude-opus-4.6"], { panelId: "p1", worktreeId: "w1" });

    const [bar] = liveBars();
    expect(bar?.placement).toBe("grid-bar");
    expect(bar?.message).toContain("claude-opus-4.6");
    expect(bar?.message).toContain("This GitHub Copilot pane");
    expect(bar?.context).toMatchObject({ panelId: "p1", worktreeId: "w1" });
  });

  it("folds a restore's burst of drops into one bar and one inbox row with the count", () => {
    for (const panelId of ["p1", "p2", "p3"]) {
      notifyRetiredModelDropped("copilot", ["gpt-5.4"], { panelId });
      now += 500;
    }

    const bars = liveBars();
    expect(bars).toHaveLength(1);
    expect(bars[0]?.message).toContain("3 GitHub Copilot panes");
    expect(bars[0]?.context?.panelId).toBeUndefined();
    expect(inboxRows()).toHaveLength(1);
  });

  it("keeps different models, and a later drop of the same one, as separate notices", () => {
    notifyRetiredModelDropped("copilot", ["gpt-5.4"], { panelId: "p1" });
    notifyRetiredModelDropped("copilot", ["claude-opus-4.6"], { panelId: "p2" });
    now += 60_000;
    notifyRetiredModelDropped("copilot", ["gpt-5.4"], { panelId: "p3" });

    expect(liveBars()).toHaveLength(3);
    expect(inboxRows()).toHaveLength(3);
    expect(liveBars().every((bar) => bar.message.includes("This GitHub Copilot pane"))).toBe(true);
  });

  it("still leaves an inbox row naming the model during quiet hours", () => {
    _setQuietUntil(now + 3_600_000);

    notifyRetiredModelDropped("copilot", ["claude-sonnet-4.6"], { panelId: "p1" });

    expect(liveBars()).toHaveLength(0);
    expect(inboxRows()[0]?.message).toContain("claude-sonnet-4.6");
  });
});
