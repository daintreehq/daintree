// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostAttentionEvent, HostMetricsEvent } from "@shared/types/ipc/hostMetrics";
import type { HostMetricsSummary } from "@shared/types/remoteHosts";
import { _resetCoalesceMap, _resetRateLimitBuckets, _setQuietUntil } from "@/lib/notify";
import {
  useNotificationStore,
  type Notification,
  type NotificationAction,
} from "@/store/notificationStore";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";
import { useHostMetricsStore } from "@/store/hostMetricsStore";
import { actionService } from "@/services/ActionService";
import {
  _resetHostAttentionFeedForTesting,
  presentHostAttention,
  startHostAttentionFeed,
} from "../hostMetricsFeed";

const attention: HostAttentionEvent = {
  type: "attention",
  hostId: "studio-01",
  hostName: "studio-01",
  kind: "waiting",
  terminalId: "t1",
  projectId: "p1",
  projectName: "helios",
  agentName: "Claude",
  quiet: false,
};

function summary(hostId: string, sampledAt: number): HostMetricsSummary {
  return {
    hostId,
    sampledAt,
    platform: "linux",
    cpuPercent: 5,
    memoryPressure: "normal",
    memoryUsedBytes: null,
    memoryTotalBytes: null,
    swapUsedBytes: null,
    swapTotalBytes: null,
    thermal: null,
    cpuPressure: null,
    agentsObserved: { working: 0, waiting: 0, idle: 0 },
    projectCount: 0,
    worktreeCount: 0,
    driver: null,
    agentClis: [],
  };
}

function toastActions(toast: Notification | undefined): NotificationAction[] {
  return [...(toast?.actions ?? []), ...(toast?.action ? [toast.action] : [])];
}

let emit: ((event: HostMetricsEvent) => void) | null = null;
const isInUse = vi.fn(async () => true);
const hostMetrics = {
  getSnapshots: vi.fn(async () => [{ hostId: "studio-01", history: [summary("studio-01", 1)] }]),
  onEvent: vi.fn((callback: (event: HostMetricsEvent) => void) => {
    emit = callback;
    return () => {
      emit = null;
    };
  }),
};

beforeEach(() => {
  isInUse.mockReset().mockResolvedValue(true);
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      hostMetrics,
      remoteHosts: { isInUse },
      notification: {
        showNative: vi.fn(),
        setSettings: vi.fn().mockResolvedValue(undefined),
        setSessionMuteUntil: vi.fn(),
      },
    },
  });
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
  useHostMetricsStore.getState().reset();
  _resetCoalesceMap();
  _resetRateLimitBuckets();
  _setQuietUntil(0);
});

afterEach(() => {
  _resetHostAttentionFeedForTesting();
  vi.restoreAllMocks();
});

describe("presentHostAttention", () => {
  it("toasts '<host>: agent waiting' in a focused window and names the host as the source", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    presentHostAttention(attention);
    const toast = useNotificationStore.getState().notifications[0];
    expect(toast?.title).toBe("studio-01: agent waiting");
    expect(toast?.message).toBe("Claude in helios is waiting for input");
    const entry = useNotificationHistoryStore.getState().entries[0];
    expect(entry?.context).toMatchObject({ eventKind: "waiting", hostName: "studio-01" });
  });

  it("offers to go to the agent's terminal on that host, from the toast and the inbox", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const dispatch = vi
      .spyOn(actionService, "dispatch")
      .mockResolvedValue({ ok: true, result: undefined });
    presentHostAttention(attention);
    const goTo = { hostId: "studio-01", projectId: "p1", terminalId: "t1" };
    const toast = useNotificationStore.getState().notifications[0];
    const actions = toastActions(toast);
    expect(actions.map((action) => action.label)).toEqual(["Go to terminal"]);
    // Timed, not sticky: the inbox entry is where it waits.
    expect(toast?.duration).toBeGreaterThan(0);
    void actions[0]?.onClick();
    expect(dispatch).toHaveBeenCalledWith("host.switch", goTo, { source: "user" });

    const entry = useNotificationHistoryStore.getState().entries[0];
    expect(entry?.actions).toEqual([
      expect.objectContaining({
        label: "Go to terminal",
        actionId: "host.switch",
        actionArgs: goTo,
      }),
    ]);
  });

  it("still notifies, with nowhere to go, when the host couldn't name the project", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    presentHostAttention({ ...attention, projectId: null });
    const toast = useNotificationStore.getState().notifications[0];
    expect(toast?.title).toBe("studio-01: agent waiting");
    expect(toastActions(toast)).toEqual([]);
    const entries = useNotificationHistoryStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.message).toBe("Claude in helios is waiting for input");
    expect(entries[0]?.actions ?? []).toEqual([]);
  });

  it("drops the action from a toast still showing when a repeat can't name the project", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    presentHostAttention(attention);
    presentHostAttention({ ...attention, projectId: null });
    const notifications = useNotificationStore.getState().notifications;
    expect(notifications).toHaveLength(1);
    expect(toastActions(notifications[0])).toEqual([]);
  });

  it("goes to the inbox only while the window is in the background", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    presentHostAttention(attention);
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
    const entries = useNotificationHistoryStore.getState().entries;
    expect(entries).toHaveLength(1);
    // Never shown as a toast, it still carries the way there.
    expect(entries[0]?.actions?.map((action) => action.actionId)).toEqual(["host.switch"]);
  });

  it("files it in the inbox without a toast when the source host is in its quiet hours", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    presentHostAttention({ ...attention, quiet: true });
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
    const entry = useNotificationHistoryStore.getState().entries[0];
    expect(entry?.seenAsToast).toBe(false);
  });

  it("ignores this window's quiet hours and on/off switch, which can be another host's", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    useNotificationSettingsStore.setState({
      enabled: false,
      quietHoursEnabled: true,
      quietHoursStartMin: 0,
      quietHoursEndMin: 24 * 60 - 1,
      quietHoursWeekdays: [],
    });
    presentHostAttention(attention);
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
  });

  it("still honours this screen's session mute", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    _setQuietUntil(Date.now() + 60_000);
    presentHostAttention(attention);
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
    expect(useNotificationHistoryStore.getState().entries).toHaveLength(1);
  });

  it("only files one main already paged for with a banner, though the window gained focus since", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    presentHostAttention({ ...attention, pagedNatively: true });
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
    const entries = useNotificationHistoryStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.seenAsToast).toBe(false);
    expect(window.electron.notification.showNative).not.toHaveBeenCalled();
  });

  it("doesn't re-toast a banner's notice to revive a thread the person archived", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    presentHostAttention(attention);
    const history = useNotificationHistoryStore.getState();
    history.archiveByCorrelationId(history.entries[0]!.correlationId!);
    useNotificationStore.setState({ notifications: [] });

    presentHostAttention({ ...attention, pagedNatively: true });
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
    const live = useNotificationHistoryStore
      .getState()
      .entries.filter((e) => e.archivedAt === null);
    expect(live).toHaveLength(1);
    expect(live[0]?.seenAsToast).toBe(false);
  });
});

describe("startHostAttentionFeed", () => {
  it("presents attention and leaves summaries to whatever shows host figures", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    hostMetrics.getSnapshots.mockClear();
    isInUse.mockClear();
    const stop = startHostAttentionFeed();
    emit?.({ type: "summary", summary: summary("studio-01", 2) });
    emit?.(attention);
    await Promise.resolve();
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
    expect(useHostMetricsStore.getState().history.size).toBe(0);
    expect(hostMetrics.getSnapshots).not.toHaveBeenCalled();
    expect(isInUse).not.toHaveBeenCalled();
    stop();
    expect(emit).toBeNull();
  });

  it("listens once for every owner and stops with the last, however often each releases", () => {
    hostMetrics.onEvent.mockClear();
    const first = startHostAttentionFeed();
    const second = startHostAttentionFeed();
    expect(hostMetrics.onEvent).toHaveBeenCalledTimes(1);
    first();
    first();
    expect(emit).not.toBeNull();
    second();
    expect(emit).toBeNull();
  });
});
