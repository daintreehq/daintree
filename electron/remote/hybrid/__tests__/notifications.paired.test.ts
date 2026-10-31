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
    byHandle: new Map<number, unknown>(),
    byId: new Map<string, unknown>(),
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
  getEndpointRegistry: () => ({
    getByHandle: (handle: number) => m.byHandle.get(handle),
    get: (endpointId: string) => m.byId.get(endpointId),
  }),
}));

import { CHANNELS } from "../../../ipc/channels.js";
import { notificationService } from "../../../services/NotificationService.js";
import { AppError } from "../../../utils/errorTypes.js";
import { RemoteViewEndpoint } from "../../host/RemoteViewEndpoint.js";
import { resetHostNoticeBudget } from "../hostNoticeBudget.js";
import {
  NOTIFICATION_CLOSE_METHOD,
  NOTIFICATION_RECONCILE_METHOD,
  NOTIFICATION_SHOW_METHOD,
  _resetHostBannersForTesting,
  closeHostNotifications,
  installRemoteNotificationSink,
  reconcileHostNotifications,
  releaseHostNotifications,
  showHostNotification,
} from "../notifications.js";

const STUDIO = { id: "studio", name: "Studio Mac" };

/**
 * One remote view as the host sees it: a real endpoint whose transport is
 * answered by this same process's Shell handlers, as the Shell's
 * `RemoteHostManager.reverseRequest` would on the far end. Host owners are
 * negative handles and Shell views positive webContents ids, so one
 * NotificationService plays both machines without the two meeting.
 */
function remoteView(clientEndpointId: string, webContentsId: number, host = STUDIO) {
  let down = false;
  let holding = false;
  const held: Array<{ deliver: () => void; fail: (error: Error) => void }> = [];
  let shellAnswers = true;
  const answer = (method: string, payload: unknown): unknown => {
    if (method === NOTIFICATION_SHOW_METHOD) {
      if (!showHostNotification(webContentsId, payload, host)) {
        throw new AppError({ code: "VALIDATION", message: "Malformed notification" });
      }
      return null;
    }
    if (method === NOTIFICATION_CLOSE_METHOD && shellAnswers) {
      if (!closeHostNotifications(payload, host.id)) {
        throw new AppError({ code: "VALIDATION", message: "Malformed close" });
      }
      return null;
    }
    if (method === NOTIFICATION_RECONCILE_METHOD && shellAnswers) {
      if (!reconcileHostNotifications(webContentsId, payload, host.id)) {
        throw new AppError({ code: "VALIDATION", message: "Malformed reconcile" });
      }
      return null;
    }
    throw new AppError({ code: "UNSUPPORTED", message: `No handler for ${method}` });
  };
  const endpoint = new RemoteViewEndpoint(
    {
      endpointId: `remote:s1:${clientEndpointId}`,
      clientEndpointId,
      clientId: "shell",
      linkSessionId: "s1",
      projectId: "p1",
    },
    {
      sendEvent: () => {},
      request: async (_endpoint, method, payload) => {
        await Promise.resolve();
        if (down) {
          throw new AppError({ code: "HOST_DISCONNECTED", message: "Shell is not attached" });
        }
        if (holding && method === NOTIFICATION_CLOSE_METHOD) {
          return new Promise((resolve, reject) =>
            held.push({
              deliver: () => {
                try {
                  resolve(answer(method, payload));
                } catch (error) {
                  reject(error);
                }
              },
              fail: reject,
            })
          );
        }
        return answer(method, payload);
      },
    }
  );
  const request = vi.spyOn(endpoint, "request");
  m.byHandle.set(endpoint.handle, endpoint);
  m.byId.set(endpoint.endpointId, endpoint);
  return {
    endpoint,
    handle: endpoint.handle,
    request,
    closesSent: () =>
      request.mock.calls
        .filter(([method]) => method === NOTIFICATION_CLOSE_METHOD)
        .map(([, payload]) => (payload as { ids: string[] }).ids),
    reconcilesSent: () =>
      request.mock.calls
        .filter(([method]) => method === NOTIFICATION_RECONCILE_METHOD)
        .map(([, payload]) => (payload as { live: string[] }).live),
    setDown(value: boolean) {
      down = value;
    },
    /** A Shell from before closes and reconciles existed. */
    refuseCloses() {
      shellAnswers = false;
    },
    holdCloses() {
      holding = true;
    },
    releaseCloses() {
      holding = false;
      for (const { deliver } of held.splice(0)) deliver();
    },
    /** The held closes die with the link they were on. */
    failHeldCloses() {
      holding = false;
      for (const { fail } of held.splice(0)) {
        fail(new AppError({ code: "HOST_DISCONNECTED", message: "Link closed" }));
      }
    },
    close() {
      m.byHandle.delete(endpoint.handle);
      m.byId.delete(endpoint.endpointId);
      endpoint.close();
    },
  };
}

function resume(...views: Array<{ endpoint: { endpointId: string } }>): void {
  const ids = views.map((view) => view.endpoint.endpointId);
  for (const listener of [...transportListeners]) listener(ids, true);
}

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

const transportListeners = new Set<(endpointIds: string[], attached: boolean) => void>();
let uninstall: () => void;

beforeEach(() => {
  m.FakeNotification.instances.length = 0;
  m.byHandle.clear();
  m.byId.clear();
  transportListeners.clear();
  resetHostNoticeBudget();
  _resetHostBannersForTesting();
  uninstall = installRemoteNotificationSink({
    onTransportChange: (listener) => {
      transportListeners.add(listener);
      return () => transportListeners.delete(listener);
    },
  });
});

afterEach(() => {
  uninstall();
  notificationService.dispose();
});

describe("a remote view's banners, host sink to Shell", () => {
  it("takes the Shell's banner down once its panel is dealt with on the host", async () => {
    const view = remoteView("view-12", 12);
    hostWaiting(view.handle, "Agent waiting", ["t1"]);
    hostWaiting(view.handle, "Other waiting", ["t2"]);
    await settle();
    expect(shellBanners()).toEqual(["Studio Mac: Agent waiting", "Studio Mac: Other waiting"]);

    notificationService.closeNotificationsForPanel("t1");
    await settle();
    expect(shellBanners()).toEqual(["Studio Mac: Other waiting"]);
  });

  it("keeps a grouped banner until its last panel is dealt with", async () => {
    const view = remoteView("view-12", 12);
    hostWaiting(view.handle, "Agents waiting", ["t1", "t2"]);
    await settle();

    notificationService.closeNotificationsForPanel("t1");
    await settle();
    expect(shellBanners()).toEqual(["Studio Mac: Agents waiting"]);

    notificationService.closeNotificationsForPanel("t2");
    notificationService.closeNotificationsForPanel("t2");
    await settle();
    expect(shellBanners()).toEqual([]);
    expect(view.closesSent()).toHaveLength(1);
  });

  it("shows one banner for a repeated wait on one panel", async () => {
    const view = remoteView("view-12", 12);
    hostWaiting(view.handle, "first wait", ["t1"]);
    await settle();
    notificationService.closeNotificationsForPanel("t1");
    hostWaiting(view.handle, "second wait", ["t1"]);
    await settle();
    expect(shellBanners()).toEqual(["Studio Mac: second wait"]);
  });

  it("closes a banner whose close was lost with the link once the link resumes", async () => {
    const view = remoteView("view-12", 12);
    hostWaiting(view.handle, "first wait", ["t1"]);
    hostWaiting(view.handle, "still waiting", ["t2"]);
    await settle();

    view.setDown(true);
    notificationService.closeNotificationsForPanel("t1");
    await settle();
    expect(shellBanners()).toEqual(["Studio Mac: first wait", "Studio Mac: still waiting"]);

    view.setDown(false);
    for (const listener of transportListeners) listener([view.endpoint.endpointId], false);
    await settle();
    expect(view.reconcilesSent()).toEqual([]);
    resume(view);
    await settle();
    expect(shellBanners()).toEqual(["Studio Mac: still waiting"]);
  });

  it("closes it even when the lost close fails only after the resume it raced", async () => {
    const view = remoteView("view-12", 12);
    hostWaiting(view.handle, "first wait", ["t1"]);
    await settle();

    // The old link is replaced: the new one attaches before the close that
    // was on the old one is rejected.
    view.holdCloses();
    notificationService.closeNotificationsForPanel("t1");
    await settle();
    resume(view);
    view.failHeldCloses();
    await settle();
    expect(shellBanners()).toEqual([]);
  });

  it("closes it however many banners came and went while the link was down", async () => {
    const view = remoteView("view-12", 12);
    hostWaiting(view.handle, "first wait", ["t1"]);
    await settle();

    view.setDown(true);
    notificationService.closeNotificationsForPanel("t1");
    for (let i = 0; i < 300; i++) {
      hostWaiting(view.handle, `missed ${i}`, [`m${i}`]);
      notificationService.closeNotificationsForPanel(`m${i}`);
    }
    await settle();
    view.setDown(false);
    resume(view);
    await settle();
    expect(shellBanners()).toEqual([]);
    expect(view.reconcilesSent().at(-1)).toEqual([]);
  });

  it("closes a banner whose close was lost ahead of the next notification", async () => {
    const view = remoteView("view-12", 12);
    hostWaiting(view.handle, "first wait", ["t1"]);
    await settle();

    view.setDown(true);
    notificationService.closeNotificationsForPanel("t1");
    await settle();
    view.setDown(false);
    hostWaiting(view.handle, "second wait", ["t1"]);
    await settle();
    expect(shellBanners()).toEqual(["Studio Mac: second wait"]);
    expect(view.reconcilesSent()).toHaveLength(1);
  });

  it("never lets a close that arrives late take down a newer banner", async () => {
    const view = remoteView("view-12", 12);
    hostWaiting(view.handle, "first wait", ["t1"]);
    await settle();

    view.holdCloses();
    notificationService.closeNotificationsForPanel("t1");
    hostWaiting(view.handle, "second wait", ["t1"]);
    await settle();
    expect(shellBanners()).toEqual(["Studio Mac: first wait", "Studio Mac: second wait"]);
    view.releaseCloses();
    await settle();
    expect(shellBanners()).toEqual(["Studio Mac: second wait"]);
  });

  it("never lets an old close reach the banner a reconnected view shows", async () => {
    const before = remoteView("view-12", 12);
    hostWaiting(before.handle, "before the gap", ["t1"]);
    await settle();
    const oldId = (before.request.mock.calls[0]![1] as { id: string }).id;

    // A fresh session: the host dropped the old endpoint, and the Shell takes
    // down what nothing can close any more before the view is reopened.
    before.close();
    releaseHostNotifications(STUDIO.id);
    const after = remoteView("view-12", 12);
    hostWaiting(after.handle, "after the gap", ["t1"]);
    await settle();
    expect(shellBanners()).toEqual(["Studio Mac: after the gap"]);

    // The old endpoint's close, delivered late on the new session.
    expect(closeHostNotifications({ ids: [oldId] }, STUDIO.id)).toBe(true);
    expect(shellBanners()).toEqual(["Studio Mac: after the gap"]);

    notificationService.closeNotificationsForPanel("t1");
    await settle();
    expect(shellBanners()).toEqual([]);
    expect(after.closesSent()).toHaveLength(1);
  });

  it("sends nothing more for a view that went away with a close in flight", async () => {
    const view = remoteView("view-12", 12);
    hostWaiting(view.handle, "first", ["t1"]);
    hostWaiting(view.handle, "second", ["t2"]);
    await settle();

    view.holdCloses();
    notificationService.closeNotificationsForPanel("t1");
    await settle();
    view.close();
    await settle();
    // The host forgot the view's banners with its endpoint.
    expect(notificationService.remoteBannerIds(view.handle)).toEqual([]);
    resume(view);
    notificationService.closeNotificationsForPanel("t2");
    await settle();
    expect(view.closesSent()).toHaveLength(1);
    expect(view.reconcilesSent()).toEqual([]);
  });

  it("closes every banner on a panel however many were tracked, past one request's share", async () => {
    const view = remoteView("view-12", 12);
    // The host tracks them all; the Shell shows its share for the minute.
    for (let i = 0; i < 65; i++) hostWaiting(view.handle, `wait ${i}`, ["t1"]);
    await settle();
    expect(shellBanners()).toHaveLength(6);

    notificationService.closeNotificationsForPanel("t1");
    await settle();
    expect(view.closesSent().map((ids) => ids.length)).toEqual([64, 1]);
    expect(shellBanners()).toEqual([]);
  });

  it("replaces a banner under the same key, for the same view only", async () => {
    const view = remoteView("view-12", 12);
    const other = remoteView("view-13", 13);
    const keyed = (owner: number, title: string) =>
      notificationService.showNativeNotification(title, "b", {
        ownerWebContentsId: owner,
        replaceKey: "plugin:build",
      });
    keyed(view.handle, "build 1");
    keyed(other.handle, "other view's build");
    keyed(view.handle, "build 2");
    await settle();
    expect(shellBanners()).toEqual(["Studio Mac: other view's build", "Studio Mac: build 2"]);
  });

  it("sends a banner nothing will close without an identity", async () => {
    const view = remoteView("view-12", 12);
    notificationService.showNativeNotification("Agent finished", "b", {
      ownerWebContentsId: view.handle,
      category: "completed",
    });
    await settle();
    expect(view.request).toHaveBeenCalledWith(NOTIFICATION_SHOW_METHOD, {
      title: "Agent finished",
      body: "b",
      category: "completed",
    });
  });

  it("asks an older Shell to close once, and owes it nothing after it refuses", async () => {
    const view = remoteView("view-12", 12);
    hostWaiting(view.handle, "first wait", ["t1"]);
    await settle();
    const firstId = (view.request.mock.calls[0]![1] as { id: string }).id;
    view.refuseCloses();

    notificationService.closeNotificationsForPanel("t1");
    await settle();
    expect(view.closesSent()).toEqual([[firstId]]);

    resume(view);
    hostWaiting(view.handle, "second wait", ["t2"]);
    await settle();
    expect(view.closesSent()).toEqual([[firstId]]);
    // The resume's reconcile is refused too, and leaves nothing to retry.
    expect(view.reconcilesSent()).toHaveLength(1);
    const lastShow = view.request.mock.calls.at(-1)![1] as Record<string, unknown>;
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

  it("reconciles only the host's own banners on the view it addressed", () => {
    show(12, "a1");
    show(12, "a2");
    show(13, "b1");
    show(12, "a3", { id: "other", name: "Other Mac" });
    expect(reconcileHostNotifications(12, { live: ["a2"] }, STUDIO.id)).toBe(true);
    expect(shellBanners()).toEqual(["Studio Mac: a2", "Studio Mac: b1", "Other Mac: a3"]);
    expect(reconcileHostNotifications(12, { live: ["a:2"] }, STUDIO.id)).toBe(false);
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
