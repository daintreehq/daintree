// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostAttentionEvent, HostMetricsEvent } from "@shared/types/ipc/hostMetrics";
import type { HostMetricsSummary } from "@shared/types/remoteHosts";
import { _resetCoalesceMap, _resetRateLimitBuckets, _setQuietUntil } from "@/lib/notify";
import { useNotificationStore } from "@/store/notificationStore";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";
import { useHostMetricsStore } from "@/store/hostMetricsStore";
import {
  _resetHostMetricsFeedForTesting,
  presentHostAttention,
  startHostMetricsFeed,
} from "../hostMetricsFeed";

const attention: HostAttentionEvent = {
  type: "attention",
  hostId: "studio-01",
  hostName: "studio-01",
  kind: "waiting",
  terminalId: "t1",
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
  _resetHostMetricsFeedForTesting();
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

  it("goes to the inbox only while the window is in the background", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    presentHostAttention(attention);
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
    expect(useNotificationHistoryStore.getState().entries).toHaveLength(1);
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
});

describe("startHostMetricsFeed", () => {
  it("seeds from the snapshots, applies pushed summaries and presents attention", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const stop = startHostMetricsFeed();
    await vi.waitFor(() =>
      expect(useHostMetricsStore.getState().history.get("studio-01")).toHaveLength(1)
    );
    emit?.({ type: "summary", summary: summary("studio-01", 2) });
    expect(
      useHostMetricsStore
        .getState()
        .history.get("studio-01")!
        .map((s) => s.sampledAt)
    ).toEqual([2, 1]);
    emit?.(attention);
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
    stop();
    expect(emit).toBeNull();
  });

  it("reads nothing while remote hosts aren't in use", async () => {
    isInUse.mockResolvedValue(false);
    hostMetrics.getSnapshots.mockClear();
    const stop = startHostMetricsFeed();
    await Promise.resolve();
    await Promise.resolve();
    expect(hostMetrics.getSnapshots).not.toHaveBeenCalled();
    stop();
  });
});
