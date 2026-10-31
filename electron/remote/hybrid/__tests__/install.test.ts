import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  relay: null as null | ((id: number, channel: string, args: unknown[]) => boolean),
  sink: null as null | {
    show: (notification: Record<string, unknown>) => void;
    close: (ownerHandle: number, ids: string[]) => void;
  },
  showNativeNotification: vi.fn(),
  closeNotificationsForPanel: vi.fn(),
  playFile: vi.fn(),
  isSessionMuted: vi.fn(() => false),
  notificationSettings: {} as Record<string, unknown>,
  residencyDispose: vi.fn(),
  endpoints: new Map<number, Record<string, unknown>>(),
}));

vi.mock("../../../ipc/handlers/notifications.js", () => ({
  setNotificationHostRelay: vi.fn((relay) => {
    mocks.relay = relay;
    return () => {
      if (mocks.relay === relay) mocks.relay = null;
    };
  }),
}));
vi.mock("../../../services/NotificationService.js", () => ({
  notificationService: {
    showNativeNotification: mocks.showNativeNotification,
    closeNotificationsForPanel: mocks.closeNotificationsForPanel,
    forgetRemoteOwner: vi.fn(),
    setRemoteNotificationSink: vi.fn((sink) => {
      mocks.sink = sink;
      return () => {
        if (mocks.sink === sink) mocks.sink = null;
      };
    }),
  },
}));
vi.mock("../../../services/AgentNotificationService.js", () => ({
  agentNotificationService: { isSessionMuted: mocks.isSessionMuted },
}));
vi.mock("../../../services/SoundService.js", () => ({
  soundService: { playFile: mocks.playFile },
}));
vi.mock("../../../store.js", () => ({
  store: { get: () => mocks.notificationSettings },
}));
vi.mock("../residency.js", () => ({
  installRemoteProjectResidency: vi.fn(() => mocks.residencyDispose),
}));
vi.mock("../../../ipc/endpointRegistry.js", () => ({
  getEndpointRegistry: () => ({
    getByHandle: (handle: number) => mocks.endpoints.get(handle),
    get: () => undefined,
    getRemote: () => [],
    onChange: () => () => undefined,
  }),
}));
vi.mock("../splits.js", () => ({
  HYBRID_SPLITS: { "app:hydrate": vi.fn(), "keep-awake:get-state": vi.fn() },
  HYBRID_HOST_LEGS: ["app:hydrate", "notification:sync-watched"],
}));

import { CHANNELS } from "../../../ipc/channels.js";
import {
  acceptHostPush,
  acceptLocalPushForRemoteView,
  admitHybridHostLegs,
  installHybridSplits,
  showHostNotification,
  unclassifiedPushName,
} from "../index.js";
import { NOTIFICATION_SHOW_METHOD, showHostAttentionBanner } from "../notifications.js";
import type { HostAttentionEvent } from "../../../../shared/types/ipc/hostMetrics.js";
import { resetHostNoticeBudget } from "../hostNoticeBudget.js";

const STUDIO = { id: "studio", name: "Studio Mac" };

function fakeDispatcher() {
  const splits = new Map<string, unknown>();
  const admitted = new Map<string, number>();
  return {
    splits,
    admitted,
    registerHybridSplit: vi.fn((channel: string, split: unknown) => {
      splits.set(channel, split);
      return () => splits.delete(channel);
    }),
    allowHybridOverLink: vi.fn((channel: string) => {
      admitted.set(channel, (admitted.get(channel) ?? 0) + 1);
      return () => admitted.set(channel, admitted.get(channel)! - 1);
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetHostNoticeBudget();
  mocks.relay = null;
  mocks.sink = null;
  mocks.endpoints.clear();
  mocks.notificationSettings = {};
  mocks.isSessionMuted.mockReturnValue(false);
});

describe("installHybridSplits", () => {
  it("registers every split and removes them on dispose", () => {
    const dispatcher = fakeDispatcher();
    const dispose = installHybridSplits({ dispatcher });
    expect([...dispatcher.splits.keys()]).toEqual(["app:hydrate", "keep-awake:get-state"]);
    expect(mocks.relay).toBeNull();
    dispose();
    expect(dispatcher.splits.size).toBe(0);
  });

  it("relays notification sends from remote-bound views to their host", () => {
    const router = {
      hostForSender: (id: number) => (id === 5 ? "studio" : null),
      forwardSend: vi.fn(),
    };
    const dispose = installHybridSplits({ dispatcher: fakeDispatcher(), router });

    expect(mocks.relay!(5, CHANNELS.NOTIFICATION_SYNC_WATCHED, [["p"]])).toBe(true);
    expect(router.forwardSend).toHaveBeenCalledWith(
      "studio",
      5,
      CHANNELS.NOTIFICATION_SYNC_WATCHED,
      [["p"]]
    );
    expect(mocks.relay!(6, CHANNELS.NOTIFICATION_SYNC_WATCHED, [["p"]])).toBe(false);
    dispose();
    expect(mocks.relay).toBeNull();
  });
});

describe("admitHybridHostLegs", () => {
  it("admits each host leg for link calls and releases on dispose", () => {
    const dispatcher = fakeDispatcher();
    const dispose = admitHybridHostLegs({ dispatcher });
    expect(dispatcher.admitted.get("app:hydrate")).toBe(1);
    expect(dispatcher.admitted.get("notification:sync-watched")).toBe(1);
    expect(mocks.sink).not.toBeNull();
    dispose();
    expect(dispatcher.admitted.get("app:hydrate")).toBe(0);
    expect(mocks.sink).toBeNull();
    expect(mocks.residencyDispose).toHaveBeenCalledTimes(1);
  });

  it("sends a remote owner's notification to its Shell", () => {
    admitHybridHostLegs({ dispatcher: fakeDispatcher() });
    const request = vi.fn(async () => null);
    mocks.endpoints.set(-3, {
      kind: "remote-view",
      handle: -3,
      isClosed: () => false,
      onClose: () => ({ dispose: () => {} }),
      request,
    });
    const navigation = {
      channel: CHANNELS.NOTIFICATION_WATCH_NAVIGATE,
      context: { panelId: "t1", panelTitle: "Claude" },
    };

    mocks.sink!.show({
      ownerHandle: -3,
      title: "Agent waiting",
      body: "b",
      category: "waiting",
      navigation,
    });
    mocks.sink!.show({ ownerHandle: -9, title: "gone", body: "b", category: "info" });
    mocks.sink!.close(-9, ["gone"]);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(NOTIFICATION_SHOW_METHOD, {
      title: "Agent waiting",
      body: "b",
      category: "waiting",
      navigation,
    });
  });
});

describe("showHostNotification", () => {
  it("displays a valid host notification as the local view's own, with this device's sound", () => {
    mocks.notificationSettings = {
      soundEnabled: true,
      waitingSoundFile: "ping.wav",
      completedSoundFile: "chime.wav",
    };
    const navigation = {
      channel: CHANNELS.NOTIFICATION_WATCH_NAVIGATE,
      context: { panelId: "t1", panelTitle: "Claude" },
    };
    expect(
      showHostNotification(12, { title: "t", body: "b", category: "waiting", navigation }, STUDIO)
    ).toBe(true);
    expect(mocks.playFile).toHaveBeenCalledWith("ping.wav");
    expect(mocks.showNativeNotification).toHaveBeenCalledWith("Studio Mac: t", "b", {
      silent: true,
      ownerWebContentsId: 12,
      navigation,
    });
  });

  it("plays nothing when this device has sound off, and no sound for an info notification", () => {
    mocks.notificationSettings = { soundEnabled: false, waitingSoundFile: "ping.wav" };
    showHostNotification(12, { title: "t", body: "b", category: "waiting" }, STUDIO);
    mocks.notificationSettings = { soundEnabled: true, waitingSoundFile: "ping.wav" };
    showHostNotification(12, { title: "t", body: "b", category: "info" }, STUDIO);
    expect(mocks.playFile).not.toHaveBeenCalled();
    expect(mocks.showNativeNotification).toHaveBeenCalledTimes(2);
  });

  it("holds back a completion while this screen's session is muted, but not a waiting agent", () => {
    mocks.isSessionMuted.mockReturnValue(true);
    mocks.notificationSettings = { soundEnabled: true, waitingSoundFile: "ping.wav" };
    expect(
      showHostNotification(12, { title: "done", body: "b", category: "completed" }, STUDIO)
    ).toBe(true);
    expect(mocks.showNativeNotification).not.toHaveBeenCalled();
    showHostNotification(12, { title: "waiting", body: "b", category: "waiting" }, STUDIO);
    expect(mocks.showNativeNotification).toHaveBeenCalledTimes(1);
    expect(mocks.playFile).toHaveBeenCalledWith("ping.wav");
  });

  it("holds back a host's completion during this machine's quiet hours, whatever the host's (#14701)", () => {
    mocks.notificationSettings = {
      quietHoursEnabled: true,
      quietHoursStartMin: 11 * 60,
      quietHoursEndMin: 13 * 60,
      quietHoursWeekdays: [],
    };
    const at = (hour: number) => new Date(2026, 9, 26, hour, 0).getTime();
    const show = (category: string, hour: number) =>
      showHostNotification(12, { title: category, body: "b", category }, STUDIO, at(hour));

    expect(show("completed", 12)).toBe(true);
    expect(mocks.showNativeNotification).not.toHaveBeenCalled();
    // A waiting agent pages through quiet hours, as it does locally.
    show("waiting", 12);
    show("completed", 14);
    expect(mocks.showNativeNotification.mock.calls.map((call) => call[0])).toEqual([
      "Studio Mac: waiting",
      "Studio Mac: completed",
    ]);
  });

  it("shows nothing with this machine's notifications off, and spends none of the host's share", () => {
    mocks.notificationSettings = { enabled: false };
    const show = () =>
      showHostNotification(12, { title: "t", body: "b", category: "waiting" }, STUDIO, 1_000);
    for (let i = 0; i < 6 + 3; i++) expect(show()).toBe(true);
    expect(mocks.showNativeNotification).not.toHaveBeenCalled();

    mocks.notificationSettings = { enabled: true };
    for (let i = 0; i < 6 + 3; i++) show();
    expect(mocks.showNativeNotification).toHaveBeenCalledTimes(6);
  });

  it("rejects a presentation instead of a category", () => {
    expect(showHostNotification(12, { title: "t", body: "b", silent: false }, STUDIO)).toBe(false);
  });

  it("rejects a host that names another renderer channel", () => {
    expect(
      showHostNotification(
        12,
        {
          title: "t",
          body: "b",
          category: "waiting",
          navigation: { channel: "window:new", context: { panelId: "x", panelTitle: "x" } },
        },
        STUDIO
      )
    ).toBe(false);
    expect(mocks.showNativeNotification).not.toHaveBeenCalled();
  });

  it("drops a host's notifications past its share for the minute, and lets them through after", () => {
    const show = (now: number) =>
      showHostNotification(12, { title: "t", body: "b", category: "waiting" }, STUDIO, now);
    for (let i = 0; i < 6 + 3; i++) expect(show(1_000 + i)).toBe(true);
    expect(mocks.showNativeNotification).toHaveBeenCalledTimes(6);
    showHostNotification(
      12,
      { title: "t", body: "b", category: "waiting" },
      { id: "other", name: "Other" },
      2_000
    );
    expect(mocks.showNativeNotification).toHaveBeenCalledTimes(7);
    show(1_000 + 61_000);
    expect(mocks.showNativeNotification).toHaveBeenCalledTimes(8);
  });

  it("keeps a host's text from reordering or hiding what this machine adds", () => {
    showHostNotification(
      12,
      { title: "\u202eUpdate macOS\u2066", body: "line\u0085two\u200b", category: "info" },
      STUDIO
    );
    expect(mocks.showNativeNotification).toHaveBeenCalledWith(
      "Studio Mac: Update macOS",
      "line two",
      expect.anything()
    );
  });
});

describe("showHostAttentionBanner", () => {
  const event: HostAttentionEvent = {
    type: "attention",
    hostId: "studio",
    hostName: "Studio Mac",
    kind: "waiting",
    terminalId: "t1",
    projectId: "p1",
    projectName: "api",
    agentName: "Claude",
    quiet: false,
  };

  it("titles the banner with the host's name, plays this device's waiting sound, and hands the click to main", () => {
    mocks.notificationSettings = { soundEnabled: true, waitingSoundFile: "ping.wav" };
    const onClick = vi.fn();
    showHostAttentionBanner(event, onClick);
    expect(mocks.playFile).toHaveBeenCalledWith("ping.wav");
    expect(mocks.showNativeNotification).toHaveBeenCalledWith(
      "Studio Mac: Agent waiting",
      "Claude in api is waiting for input",
      expect.objectContaining({ silent: true, category: "waiting", onClick })
    );
  });

  it("replaces the banner for the same terminal and keeps another terminal's, or another host's", () => {
    showHostAttentionBanner(event, () => {});
    showHostAttentionBanner(event, () => {});
    showHostAttentionBanner({ ...event, terminalId: "t2" }, () => {});
    showHostAttentionBanner({ ...event, hostId: "other" }, () => {});
    const keys = mocks.showNativeNotification.mock.calls.map(
      ([, , options]) => (options as { replaceKey?: string }).replaceKey
    );
    expect(keys[0]).toBeDefined();
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
    // Another host's terminal can share the id.
    expect(keys[3]).not.toBe(keys[0]);
  });

  it("names an agent it couldn't identify, and a project it couldn't tell, by what it knows", () => {
    showHostAttentionBanner(
      { ...event, hostName: "  ", agentName: null, projectId: null, projectName: null },
      () => {}
    );
    expect(mocks.showNativeNotification).toHaveBeenCalledWith(
      "studio: Agent waiting",
      "An agent is waiting for input",
      expect.anything()
    );
    expect(mocks.playFile).not.toHaveBeenCalled();
  });

  it("pages through this screen's session mute, as a local waiting agent does", () => {
    mocks.isSessionMuted.mockReturnValue(true);
    showHostAttentionBanner(event, () => {});
    expect(mocks.showNativeNotification).toHaveBeenCalledTimes(1);
  });
});

describe("events:push split", () => {
  const push = (name: string) => [{ name, payload: {} }];

  it("keeps a push on a channel nobody classified away from a remote view", () => {
    expect(acceptLocalPushForRemoteView("made-up:channel", [])).toBe(false);
  });

  it("takes host events from the host and Shell events from here", () => {
    expect(acceptHostPush(CHANNELS.EVENTS_PUSH, push("agent:state-changed"))).toBe(true);
    expect(acceptHostPush(CHANNELS.EVENTS_PUSH, push("system:wake"))).toBe(false);
    expect(acceptLocalPushForRemoteView(CHANNELS.EVENTS_PUSH, push("system:wake"))).toBe(true);
    expect(acceptLocalPushForRemoteView(CHANNELS.EVENTS_PUSH, push("agent:state-changed"))).toBe(
      false
    );
  });

  it("takes agent settings from the host and the grid layout from here (#14700)", () => {
    expect(acceptHostPush(CHANNELS.AGENT_SETTINGS_CHANGED, [{}])).toBe(true);
    expect(acceptLocalPushForRemoteView(CHANNELS.AGENT_SETTINGS_CHANGED, [{}])).toBe(false);
    expect(acceptHostPush(CHANNELS.APP_PANEL_GRID_CONFIG_CHANGED, [{}])).toBe(false);
    expect(acceptLocalPushForRemoteView(CHANNELS.APP_PANEL_GRID_CONFIG_CHANGED, [{}])).toBe(true);
  });

  it("takes keyboard shortcuts from this machine, never the host (#15579)", () => {
    expect(acceptHostPush(CHANNELS.KEYBINDING_OVERRIDES_CHANGED, [{}])).toBe(false);
    expect(acceptLocalPushForRemoteView(CHANNELS.KEYBINDING_OVERRIDES_CHANGED, [{}])).toBe(true);
  });

  it("drops an unclassified bus event from both sides", () => {
    expect(acceptHostPush(CHANNELS.EVENTS_PUSH, push("made:up"))).toBe(false);
    expect(acceptLocalPushForRemoteView(CHANNELS.EVENTS_PUSH, push("made:up"))).toBe(false);
    expect(acceptHostPush(CHANNELS.EVENTS_PUSH, [null])).toBe(false);
  });

  it("names only the pushes this build never classified, not the ones it drops on purpose", () => {
    expect(unclassifiedPushName(CHANNELS.EVENTS_PUSH, push("made:up"))).toBe("made:up");
    expect(unclassifiedPushName("made:up-channel", [{}])).toBe("made:up-channel");
    expect(unclassifiedPushName(CHANNELS.EVENTS_PUSH, push("system:wake"))).toBeNull();
    expect(unclassifiedPushName(CHANNELS.EVENTS_PUSH, push("agent:state-changed"))).toBeNull();
    expect(unclassifiedPushName(CHANNELS.REMOTE_HOSTS_EVENT, [{}])).toBeNull();
    expect(unclassifiedPushName(CHANNELS.KEEP_AWAKE_STATE_CHANGED, [{}])).toBeNull();
    expect(unclassifiedPushName(CHANNELS.EVENTS_PUSH, [null])).toBeNull();
    expect(unclassifiedPushName(CHANNELS.EVENTS_PUSH, [{ name: 7 }])).toBeNull();
  });

  it("routes the other hybrid pushes by owner", () => {
    expect(acceptHostPush(CHANNELS.KEEP_AWAKE_STATE_CHANGED, [{}])).toBe(false);
    expect(acceptLocalPushForRemoteView(CHANNELS.KEEP_AWAKE_STATE_CHANGED, [{}])).toBe(true);
    expect(acceptHostPush(CHANNELS.APP_CONFIG_RELOADED, [])).toBe(true);
    expect(acceptLocalPushForRemoteView(CHANNELS.APP_CONFIG_RELOADED, [])).toBe(true);
    // Settings copied to the host refresh its remote windows as well as its own.
    expect(acceptHostPush(CHANNELS.CONFIG_BUNDLE_IMPORTED, [])).toBe(true);
    expect(acceptLocalPushForRemoteView(CHANNELS.CONFIG_BUNDLE_IMPORTED, [])).toBe(true);
  });

  it("keeps plain host and Shell channels on their own side", () => {
    expect(acceptHostPush("worktree:refresh", [{}])).toBe(true);
    expect(acceptLocalPushForRemoteView("worktree:refresh", [{}])).toBe(false);
    expect(acceptHostPush(CHANNELS.REMOTE_HOSTS_EVENT, [{}])).toBe(false);
    expect(acceptLocalPushForRemoteView(CHANNELS.REMOTE_HOSTS_EVENT, [{}])).toBe(true);
  });
});
