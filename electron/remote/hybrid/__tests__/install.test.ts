import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  relay: null as null | ((id: number, channel: string, args: unknown[]) => boolean),
  sink: null as null | ((notification: Record<string, unknown>) => void),
  showNativeNotification: vi.fn(),
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
    setRemoteNotificationSink: vi.fn((sink) => {
      mocks.sink = sink;
      return () => {
        if (mocks.sink === sink) mocks.sink = null;
      };
    }),
  },
}));
vi.mock("../../../ipc/endpointRegistry.js", () => ({
  getEndpointRegistry: () => ({ getByHandle: (handle: number) => mocks.endpoints.get(handle) }),
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
} from "../index.js";
import { NOTIFICATION_SHOW_METHOD } from "../notifications.js";

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
  mocks.relay = null;
  mocks.sink = null;
  mocks.endpoints.clear();
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
  });

  it("sends a remote owner's notification to its Shell", () => {
    admitHybridHostLegs({ dispatcher: fakeDispatcher() });
    const request = vi.fn(async () => null);
    mocks.endpoints.set(-3, { kind: "remote-view", isClosed: () => false, request });
    const navigation = {
      channel: CHANNELS.NOTIFICATION_WATCH_NAVIGATE,
      context: { panelId: "t1", panelTitle: "Claude" },
    };

    mocks.sink!({ ownerHandle: -3, title: "Agent waiting", body: "b", silent: true, navigation });
    mocks.sink!({ ownerHandle: -9, title: "gone", body: "b", silent: true });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(NOTIFICATION_SHOW_METHOD, {
      title: "Agent waiting",
      body: "b",
      silent: true,
      navigation,
    });
  });
});

describe("showHostNotification", () => {
  it("displays a valid host notification as the local view's own", () => {
    const navigation = {
      channel: CHANNELS.NOTIFICATION_WATCH_NAVIGATE,
      context: { panelId: "t1", panelTitle: "Claude" },
    };
    expect(showHostNotification(12, { title: "t", body: "b", silent: false, navigation })).toBe(
      true
    );
    expect(mocks.showNativeNotification).toHaveBeenCalledWith("t", "b", {
      silent: false,
      ownerWebContentsId: 12,
      navigation,
    });
  });

  it("rejects a host that names another renderer channel", () => {
    expect(
      showHostNotification(12, {
        title: "t",
        body: "b",
        silent: true,
        navigation: { channel: "window:new", context: { panelId: "x", panelTitle: "x" } },
      })
    ).toBe(false);
    expect(mocks.showNativeNotification).not.toHaveBeenCalled();
  });
});

describe("events:push split", () => {
  const push = (name: string) => [{ name, payload: {} }];

  it("takes host events from the host and Shell events from here", () => {
    expect(acceptHostPush(CHANNELS.EVENTS_PUSH, push("agent:state-changed"))).toBe(true);
    expect(acceptHostPush(CHANNELS.EVENTS_PUSH, push("system:wake"))).toBe(false);
    expect(acceptLocalPushForRemoteView(CHANNELS.EVENTS_PUSH, push("system:wake"))).toBe(true);
    expect(acceptLocalPushForRemoteView(CHANNELS.EVENTS_PUSH, push("agent:state-changed"))).toBe(
      false
    );
  });

  it("drops an unclassified bus event from both sides", () => {
    expect(acceptHostPush(CHANNELS.EVENTS_PUSH, push("made:up"))).toBe(false);
    expect(acceptLocalPushForRemoteView(CHANNELS.EVENTS_PUSH, push("made:up"))).toBe(false);
    expect(acceptHostPush(CHANNELS.EVENTS_PUSH, [null])).toBe(false);
  });

  it("routes the other hybrid pushes by owner", () => {
    expect(acceptHostPush(CHANNELS.KEEP_AWAKE_STATE_CHANGED, [{}])).toBe(false);
    expect(acceptLocalPushForRemoteView(CHANNELS.KEEP_AWAKE_STATE_CHANGED, [{}])).toBe(true);
    expect(acceptHostPush(CHANNELS.APP_CONFIG_RELOADED, [])).toBe(true);
    expect(acceptLocalPushForRemoteView(CHANNELS.APP_CONFIG_RELOADED, [])).toBe(true);
  });

  it("keeps plain host and Shell channels on their own side", () => {
    expect(acceptHostPush("worktree:refresh", [{}])).toBe(true);
    expect(acceptLocalPushForRemoteView("worktree:refresh", [{}])).toBe(false);
    expect(acceptHostPush(CHANNELS.REMOTE_HOSTS_EVENT, [{}])).toBe(false);
    expect(acceptLocalPushForRemoteView(CHANNELS.REMOTE_HOSTS_EVENT, [{}])).toBe(true);
  });
});
