import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => {
  class FakeNotification {
    static isSupported = () => true;
    static instances: FakeNotification[] = [];
    handlers: Record<string, (...args: unknown[]) => void> = {};
    closed = false;
    show = vi.fn();
    removeAllListeners = vi.fn(() => {
      this.handlers = {};
    });
    // Like Electron, closing a shown notification emits "close".
    close = vi.fn(() => {
      this.closed = true;
      this.handlers.close?.({});
    });
    constructor(public options: { title: string; body: string }) {
      FakeNotification.instances.push(this);
    }
    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers[event] = handler;
      return this;
    }
    once(event: string, handler: (...args: unknown[]) => void) {
      this.handlers[event] = handler;
      return this;
    }
  }
  return {
    FakeNotification,
    endpoints: new Map<number, unknown>(),
    isSessionMuted: vi.fn(() => false),
  };
});

vi.mock("electron", () => ({
  app: { setBadgeCount: vi.fn() },
  Notification: m.FakeNotification,
  webContents: { fromId: vi.fn(() => undefined) },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
vi.mock("../../../ipc/utils.js", () => ({ sendToRenderer: vi.fn() }));
vi.mock("../../../window/webContentsRegistry.js", () => ({
  getAppWebContents: vi.fn(),
  getWindowForWebContents: vi.fn(),
}));
vi.mock("../../../window/linuxWindowIcon.js", () => ({ getLinuxWindowIcon: () => undefined }));
vi.mock("../../../ipc/handlers/notifications.js", () => ({
  setNotificationHostRelay: vi.fn(() => () => {}),
}));
vi.mock("../../../services/AgentNotificationService.js", () => ({
  agentNotificationService: { isSessionMuted: m.isSessionMuted },
}));
vi.mock("../../../services/SoundService.js", () => ({ soundService: { playFile: vi.fn() } }));
vi.mock("../../../store.js", () => ({ store: { get: () => ({}) } }));
vi.mock("../../../ipc/endpointRegistry.js", () => ({
  getEndpointRegistry: () => ({ getByHandle: (handle: number) => m.endpoints.get(handle) }),
}));

import { CHANNELS } from "../../../ipc/channels.js";
import { notificationService } from "../../../services/NotificationService.js";
import { resetHostNoticeBudget } from "../hostNoticeBudget.js";
import {
  NOTIFICATION_CLOSE_METHOD,
  NOTIFICATION_SHOW_METHOD,
  _resetHostBannersForTesting,
  closeHostNotifications,
  installRemoteNotificationSink,
  releaseHostNotifications,
  showHostNotification,
} from "../notifications.js";

/**
 * One remote view as the host sees it, answered by this same process's Shell
 * handlers, as `RemoteHostManager.reverseRequest` would on the far end. Host
 * owners are negative handles and Shell views are positive webContents ids,
 * so one NotificationService plays both machines without the two meeting.
 */
function remoteView(handle: number, webContentsId: number, host = STUDIO) {
  const closeListeners = new Set<() => void>();
  let closed = false;
  let down = false;
  const heldCloses: Array<() => void> = [];
  let holdCloses = false;
  const answer = (method: string, payload: unknown): unknown => {
    if (method === NOTIFICATION_SHOW_METHOD) {
      if (!showHostNotification(webContentsId, payload, host)) throw new Error("VALIDATION");
      return null;
    }
    if (method === NOTIFICATION_CLOSE_METHOD) {
      if (!closeHostNotifications(payload, host.id)) throw new Error("VALIDATION");
      return null;
    }
    throw Object.assign(new Error("No handler"), { code: "UNSUPPORTED" });
  };
  const endpoint = {
    kind: "remote-view" as const,
    handle,
    isClosed: () => closed,
    onClose(cb: () => void) {
      closeListeners.add(cb);
      return { dispose: () => closeListeners.delete(cb) };
    },
    request: vi.fn(async (method: string, payload: unknown) => {
      await Promise.resolve();
      if (down)
        throw Object.assign(new Error("Shell is not attached"), { code: "HOST_DISCONNECTED" });
      if (holdCloses && method === NOTIFICATION_CLOSE_METHOD) {
        return new Promise((resolve) => heldCloses.push(() => resolve(answer(method, payload))));
      }
      return answer(method, payload);
    }),
  };
  m.endpoints.set(handle, endpoint);
  return {
    endpoint,
    setDown(value: boolean) {
      down = value;
    },
    holdCloses() {
      holdCloses = true;
    },
    releaseCloses() {
      holdCloses = false;
      for (const deliver of heldCloses.splice(0)) deliver();
    },
    close() {
      closed = true;
      m.endpoints.delete(handle);
      for (const cb of [...closeListeners]) cb();
    },
  };
}

const STUDIO = { id: "studio", name: "Studio Mac" };

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** The host decides a waiting banner for its remote owner, as AgentNotificationService does. */
function hostWaiting(ownerHandle: number, title: string, panels: string[]): void {
  notificationService.showWatchNotification(
    title,
    "is waiting for input",
    { panelId: panels[0]!, panelTitle: "Claude" },
    CHANNELS.NOTIFICATION_WATCH_NAVIGATE,
    { ownerWebContentsId: ownerHandle, closeWithPanels: panels, category: "waiting" }
  );
}

function shellBanners(): string[] {
  return m.FakeNotification.instances.filter((n) => !n.closed).map((n) => n.options.title);
}

let uninstall: () => void;

beforeEach(() => {
  m.FakeNotification.instances.length = 0;
  m.endpoints.clear();
  resetHostNoticeBudget();
  _resetHostBannersForTesting();
  uninstall = installRemoteNotificationSink();
});

afterEach(() => {
  uninstall();
  notificationService.dispose();
});

describe("a remote view's banners, host sink to Shell", () => {
  it("takes the Shell's banner down once its panel is dealt with on the host", async () => {
    remoteView(-3, 12);
    hostWaiting(-3, "Agent waiting", ["t1"]);
    hostWaiting(-3, "Other waiting", ["t2"]);
    await settle();
    expect(shellBanners()).toEqual(["Studio Mac: Agent waiting", "Studio Mac: Other waiting"]);

    notificationService.closeNotificationsForPanel("t1");
    await settle();
    expect(shellBanners()).toEqual(["Studio Mac: Other waiting"]);
  });

  it("keeps a grouped banner until its last panel is dealt with", async () => {
    const view = remoteView(-3, 12);
    hostWaiting(-3, "Agents waiting", ["t1", "t2"]);
    await settle();

    notificationService.closeNotificationsForPanel("t1");
    await settle();
    expect(shellBanners()).toEqual(["Studio Mac: Agents waiting"]);

    notificationService.closeNotificationsForPanel("t2");
    notificationService.closeNotificationsForPanel("t2");
    await settle();
    expect(shellBanners()).toEqual([]);
    const closes = view.endpoint.request.mock.calls.filter(
      ([method]) => method === NOTIFICATION_CLOSE_METHOD
    );
    expect(closes).toHaveLength(1);
  });

  it("shows one banner for a repeated wait on one panel", async () => {
    remoteView(-3, 12);
    hostWaiting(-3, "first wait", ["t1"]);
    await settle();
    notificationService.closeNotificationsForPanel("t1");
    hostWaiting(-3, "second wait", ["t1"]);
    await settle();
    expect(shellBanners()).toEqual(["Studio Mac: second wait"]);
  });

  it("takes down a banner whose close was lost with the link, before the next one shows", async () => {
    const view = remoteView(-3, 12);
    hostWaiting(-3, "first wait", ["t1"]);
    await settle();

    view.setDown(true);
    notificationService.closeNotificationsForPanel("t1");
    await settle();
    expect(shellBanners()).toEqual(["Studio Mac: first wait"]);

    view.setDown(false);
    hostWaiting(-3, "second wait", ["t1"]);
    await settle();
    expect(shellBanners()).toEqual(["Studio Mac: second wait"]);
  });

  it("never lets a close that arrives late take down a newer banner", async () => {
    const view = remoteView(-3, 12);
    hostWaiting(-3, "first wait", ["t1"]);
    await settle();

    view.holdCloses();
    notificationService.closeNotificationsForPanel("t1");
    hostWaiting(-3, "second wait", ["t1"]);
    await settle();
    view.releaseCloses();
    await settle();
    expect(shellBanners()).toEqual(["Studio Mac: second wait"]);
  });

  it("never lets an old close reach the banner a reconnected view shows", async () => {
    const before = remoteView(-3, 12);
    hostWaiting(-3, "before the gap", ["t1"]);
    await settle();
    const [{ id: oldId }] = before.endpoint.request.mock.calls.map(
      ([, payload]) => payload as { id: string }
    );

    // A fresh session: the host dropped the old endpoint, and the Shell takes
    // down what nothing can close any more before the view is reopened.
    before.close();
    releaseHostNotifications(STUDIO.id);
    const after = remoteView(-4, 12);
    hostWaiting(-4, "after the gap", ["t1"]);
    await settle();
    expect(shellBanners()).toEqual(["Studio Mac: after the gap"]);

    // The old endpoint's close, delivered late on the new session.
    expect(closeHostNotifications({ ids: [oldId] }, STUDIO.id)).toBe(true);
    expect(shellBanners()).toEqual(["Studio Mac: after the gap"]);

    // The host forgot the old owner's banners with its endpoint.
    notificationService.closeNotificationsForPanel("t1");
    await settle();
    expect(shellBanners()).toEqual([]);
    expect(
      after.endpoint.request.mock.calls.filter(([method]) => method === NOTIFICATION_CLOSE_METHOD)
    ).toHaveLength(1);
  });

  it("replaces a banner under the same key, for the same view only", async () => {
    remoteView(-3, 12);
    remoteView(-5, 13);
    const keyed = (owner: number, title: string) =>
      notificationService.showNativeNotification(title, "b", {
        ownerWebContentsId: owner,
        replaceKey: "plugin:build",
      });
    keyed(-3, "build 1");
    keyed(-5, "other view's build");
    keyed(-3, "build 2");
    await settle();
    expect(shellBanners()).toEqual(["Studio Mac: other view's build", "Studio Mac: build 2"]);
  });

  it("sends a banner nothing will close without an identity", async () => {
    const view = remoteView(-3, 12);
    notificationService.showNativeNotification("Agent finished", "b", {
      ownerWebContentsId: -3,
      category: "completed",
    });
    await settle();
    expect(view.endpoint.request).toHaveBeenCalledWith(NOTIFICATION_SHOW_METHOD, {
      title: "Agent finished",
      body: "b",
      category: "completed",
    });
  });

  it("asks an older Shell to close once, and owes it nothing after it refuses", async () => {
    const view = remoteView(-3, 12);
    hostWaiting(-3, "first wait", ["t1"]);
    await settle();
    view.endpoint.request.mockImplementationOnce(async () => {
      throw Object.assign(new Error("No handler"), { code: "UNSUPPORTED" });
    });
    notificationService.closeNotificationsForPanel("t1");
    await settle();
    hostWaiting(-3, "second wait", ["t2"]);
    await settle();
    const lastShow = view.endpoint.request.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(lastShow.supersedes).toBeUndefined();
  });
});

describe("Shell tracking of a host's banners", () => {
  const show = (webContentsId: number, id: string, host = STUDIO, now = Date.now()) =>
    showHostNotification(
      webContentsId,
      { title: id, body: "b", category: "waiting", id },
      host,
      now
    );

  it("keeps two hosts that use the same id out of each other's banners", () => {
    show(12, "a1");
    show(12, "a1", { id: "other", name: "Other Mac" });
    closeHostNotifications({ ids: ["a1"] }, STUDIO.id);
    expect(shellBanners()).toEqual(["Other Mac: a1"]);
  });

  it("takes down only the banners shown for a view that went away", () => {
    show(12, "a1");
    show(13, "b1");
    show(12, "a2", { id: "other", name: "Other Mac" });
    releaseHostNotifications(STUDIO.id, 12);
    expect(shellBanners()).toEqual(["Studio Mac: b1", "Other Mac: a2"]);
    releaseHostNotifications(STUDIO.id);
    expect(shellBanners()).toEqual(["Other Mac: a2"]);
  });

  it("bounds the banners it holds for one host by taking down the oldest", () => {
    for (let i = 0; i < 40; i++) show(12, `n${i}`, STUDIO, i * 61_000);
    const open = shellBanners();
    expect(open).toHaveLength(32);
    expect(open[0]).toBe("Studio Mac: n8");
  });

  it("still takes down what a show supersedes when the show itself is held back", () => {
    for (let i = 0; i < 6; i++) show(12, `n${i}`, STUDIO, 1_000);
    expect(
      showHostNotification(
        12,
        { title: "over budget", body: "b", category: "waiting", id: "n6", supersedes: ["n0"] },
        STUDIO,
        1_000
      )
    ).toBe(true);
    expect(shellBanners()).toEqual(["n1", "n2", "n3", "n4", "n5"].map((t) => `Studio Mac: ${t}`));
  });

  it("rejects a malformed close, and an id that could be read as another host's", () => {
    expect(closeHostNotifications({ ids: [] }, STUDIO.id)).toBe(false);
    expect(closeHostNotifications({ ids: ["a:b"] }, STUDIO.id)).toBe(false);
    expect(closeHostNotifications({}, STUDIO.id)).toBe(false);
    expect(
      showHostNotification(12, { title: "t", body: "b", category: "waiting", id: "x:y" }, STUDIO)
    ).toBe(false);
  });
});
