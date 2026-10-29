// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PluginParityRow } from "@shared/types/ipc/pluginParity";
import type { HostConnectionState } from "@shared/types/remoteHosts";

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: dispatchMock } }));

import { takePendingHostPlugins } from "@/components/Settings/Hosts/hostPluginRequests";
import { useSettingsDialog } from "@/hooks/app/useSettingsDialog";
import { _resetCoalesceMap, _resetRateLimitBuckets } from "@/lib/notify";
import { SettingsNavTargetSchema } from "@/services/actions/definitions/schemas";
import { useHostConnectionStore } from "@/store/hostConnectionStore";
import { useNotificationStore } from "@/store/notificationStore";
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";
import {
  useNotificationHistoryStore,
  type NotificationHistoryEntry,
} from "@/store/slices/notificationHistorySlice";
import { useHostPluginParityNotice } from "../useHostPluginParityNotice";

const CONNECTED: HostConnectionState = {
  status: "connected",
  rttMs: null,
  handshake: {
    version: "0.38.0",
    commit: "abc",
    protocolVersion: 1,
    platform: "linux",
    arch: "x64",
  },
};

// Main's claim for one window: granted when the window lands on a host other
// than the last one claimed, refused while it stays.
let claimedHost: string | null = null;
const parity = {
  diff: vi.fn(async (): Promise<PluginParityRow[]> => []),
  claimSwitchNotice: vi.fn(async ({ hostId }: { hostId: string }) => {
    if (claimedHost === hostId) return false;
    claimedHost = hostId;
    return true;
  }),
};

function missing(...pluginIds: string[]): PluginParityRow[] {
  return pluginIds.map((pluginId) => ({
    pluginId,
    displayName: pluginId,
    group: "only-here",
    localVersion: "1.0.0",
    hostVersion: null,
    incompatibility: null,
    action: "install-on-host",
  }));
}

/** One landing of this window on `hostId`, as the hook sees it. */
async function landOn(hostId: string, rows: PluginParityRow[]): Promise<void> {
  window.__DAINTREE_HOST_ID__ = { id: hostId };
  useHostConnectionStore.setState({ hostName: hostId, connection: CONNECTED });
  parity.diff.mockResolvedValue(rows);
  const calls = parity.diff.mock.calls.length;
  const { unmount } = renderHook(() => useHostPluginParityNotice());
  await waitFor(() => expect(parity.diff.mock.calls.length).toBe(calls + 1));
  // Past the comparison and the claim, whichever way they went.
  await act(async () => {});
  unmount();
}

function entries(): NotificationHistoryEntry[] {
  return useNotificationHistoryStore.getState().entries;
}

function current(hostId: string): NotificationHistoryEntry[] {
  return entries().filter(
    (entry) => entry.supersedeKey === `plugin-parity:${hostId}` && entry.archivedAt === null
  );
}

beforeEach(() => {
  Object.defineProperty(window, "electron", {
    value: {
      pluginParity: parity,
      notification: {
        showNative: vi.fn(),
        setSettings: vi.fn().mockResolvedValue(undefined),
        setSessionMuteUntil: vi.fn(),
      },
    },
    configurable: true,
    writable: true,
  });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  claimedHost = null;
  useNotificationStore.setState({ notifications: [] });
  useNotificationHistoryStore.setState({ entries: [], unreadCount: 0, snoozedThreads: {} });
  useNotificationSettingsStore.setState({
    enabled: true,
    hydrated: true,
    quietHoursEnabled: false,
  });
  _resetCoalesceMap();
  _resetRateLimitBuckets();
  takePendingHostPlugins();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  void useNotificationHistoryStore.persist.clearStorage();
  delete (window as { __DAINTREE_HOST_ID__?: unknown }).__DAINTREE_HOST_ID__;
  useHostConnectionStore.setState({ connection: null, hostName: null });
});

describe("the host plugin notice in the inbox", () => {
  it("keeps a Review that opens that host's plugins", async () => {
    await landOn("studio-01", missing("acme.a", "acme.b"));
    const [row] = current("studio-01");
    expect(row?.message).toBe("2 of your plugins aren't installed on studio-01");
    const review = row?.actions?.find((action) => action.label === "Review");
    expect(review?.actionId).toBe("app.settings.openTab");

    // What the inbox does with the button: dispatch its id with its args, which
    // the action parses and hands to Settings.
    expect(SettingsNavTargetSchema.safeParse(review?.actionArgs).success).toBe(true);
    const { result } = renderHook(() => useSettingsDialog());
    act(() => {
      window.dispatchEvent(
        new CustomEvent("daintree:open-settings-tab", { detail: review?.actionArgs })
      );
    });
    expect(result.current.isSettingsOpen).toBe(true);
    expect(result.current.settingsTab).toBe("hosts");
    expect(takePendingHostPlugins()).toEqual({ hostId: "studio-01", sectionId: "host-plugins" });
    // The host's details open on their plugins; nothing else scrolls for them.
    expect(result.current.settingsSectionId).toBeUndefined();
  });

  it("doesn't post an unchanged difference again on a later switch, read or done", async () => {
    await landOn("studio-01", missing("acme.a", "acme.b"));
    const [first] = entries();

    await landOn("build-box", missing("acme.c"));
    await landOn("studio-01", missing("acme.b", "acme.a"));
    expect(current("studio-01").map((entry) => entry.id)).toEqual([first!.id]);
    expect(entries()).toHaveLength(2);

    useNotificationHistoryStore.getState().archiveEntry(first!.id);
    await landOn("build-box", missing("acme.c"));
    await landOn("studio-01", missing("acme.a", "acme.b"));
    expect(entries().filter((entry) => entry.supersedeKey === "plugin-parity:studio-01")).toEqual([
      expect.objectContaining({ id: first!.id, archivedAt: expect.any(Number) }),
    ]);
  });

  it("stays quiet about the same difference after a relaunch", async () => {
    await landOn("studio-01", missing("acme.a"));
    const [first] = entries();
    const options = useNotificationHistoryStore.persist.getOptions();
    const saved: unknown = JSON.parse(
      JSON.stringify(options.partialize!(useNotificationHistoryStore.getState()))
    );
    useNotificationHistoryStore.setState(
      options.merge!(saved, useNotificationHistoryStore.getState())
    );
    claimedHost = null;

    await landOn("studio-01", missing("acme.a"));
    expect(entries().map((entry) => entry.id)).toEqual([first!.id]);
    expect(parity.claimSwitchNotice).toHaveBeenCalledTimes(2);
  });

  it("replaces the host's row when the difference changes, even at the same count", async () => {
    await landOn("studio-01", missing("acme.a", "acme.b"));
    const first = current("studio-01")[0]!;

    await landOn("build-box", missing("acme.z"));
    await landOn("studio-01", missing("acme.a", "acme.c"));
    const second = current("studio-01")[0]!;
    expect(current("studio-01")).toHaveLength(1);
    expect(second.id).not.toBe(first.id);
    expect(second.message).toBe("2 of your plugins aren't installed on studio-01");
    expect(entries().find((entry) => entry.id === first.id)?.archivedAt).toEqual(
      expect.any(Number)
    );

    // Back to the first set: it's the newest row, not an older one, that counts.
    await landOn("build-box", missing("acme.z"));
    await landOn("studio-01", missing("acme.a", "acme.b"));
    expect(current("studio-01")).toHaveLength(1);
    expect([first.id, second.id]).not.toContain(current("studio-01")[0]!.id);
  });

  it("still hears about a host's change after a switch to a host it had nothing new for", async () => {
    await landOn("studio-01", missing("acme.a"));
    await landOn("build-box", missing("acme.a"));
    const before = current("build-box")[0]!.id;

    await landOn("studio-01", missing("acme.a"));
    await landOn("build-box", missing("acme.a", "acme.b"));
    expect(current("build-box").map((entry) => entry.id)).not.toEqual([before]);
    expect(current("build-box")[0]!.message).toBe(
      "2 of your plugins aren't installed on build-box"
    );
  });

  it("keeps each host's difference in its own row", async () => {
    await landOn("studio-01", missing("acme.a"));
    await landOn("build-box", missing("acme.a"));
    expect(current("studio-01")).toHaveLength(1);
    expect(current("build-box")).toHaveLength(1);
  });
});
