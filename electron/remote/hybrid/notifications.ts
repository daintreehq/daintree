import { z } from "zod";
import { CHANNELS } from "../../ipc/channels.js";
import type { ClientEndpoint, Disposable, RemoteRouter } from "../../ipc/endpoint.js";
import { getEndpointRegistry } from "../../ipc/endpointRegistry.js";
import { setNotificationHostRelay } from "../../ipc/handlers/notifications.js";
import { agentNotificationService } from "../../services/AgentNotificationService.js";
import {
  notificationService,
  type NotificationCategory,
  type RemoteNotification,
} from "../../services/NotificationService.js";
import { soundService } from "../../services/SoundService.js";
import { store } from "../../store.js";
import type { HostAttentionEvent } from "../../../shared/types/ipc/hostMetrics.js";
import type { NotificationSettings } from "../../../shared/types/ipc/api.js";
import { displaySafeText } from "../../../shared/utils/displaySafeText.js";
import { isScheduledQuietNow } from "../../../shared/utils/quietHours.js";
import { admitHostNotice } from "./hostNoticeBudget.js";

/**
 * Host → Shell request: a notification about one of the host's agents. It
 * carries what the notification is about, not how to present it: sound,
 * quiet hours, and whether this person muted the session, are this Shell's.
 */
export const NOTIFICATION_SHOW_METHOD = "notification.show";

/**
 * Host → Shell request: take down banners `notification.show` put up, by the
 * ids the host gave them. A Shell from before it answers UNSUPPORTED and keeps
 * its banners, as it always did.
 */
export const NOTIFICATION_CLOSE_METHOD = "notification.close";

/**
 * Host → Shell request: the banners the host still holds on this view, so
 * the Shell takes down any other it shows for the view. Sent when the Shell
 * may have missed a close: the link dropped and resumed, or a close failed.
 */
export const NOTIFICATION_RECONCILE_METHOD = "notification.reconcile";

/** Most ids one show may supersede, or one close may name. */
const MAX_IDS_PER_REQUEST = 64;

/** Most live ids one reconcile may name: above what a host keeps closable. */
const MAX_LIVE_IDS = 256;

// No colon, so the Shell's key for a host's banner can't be read two ways.
const NoticeIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

const NotificationShowSchema = z.object({
  title: z.string().max(512),
  body: z.string().max(4096),
  category: z.enum(["completed", "waiting", "escalation", "info"]),
  navigation: z
    .object({
      // A click delivers to the owning renderer on this channel; a host may not pick another.
      channel: z.literal(CHANNELS.NOTIFICATION_WATCH_NAVIGATE),
      context: z.object({
        panelId: z.string().min(1).max(256),
        panelTitle: z.string().max(512),
        worktreeId: z.string().max(4096).optional(),
      }),
    })
    .optional(),
  /** Present when the host may take this banner down later. */
  id: NoticeIdSchema.optional(),
  /** This host's banners this one replaces. */
  supersedes: z.array(NoticeIdSchema).max(MAX_IDS_PER_REQUEST).optional(),
});

export type NotificationShowPayload = z.infer<typeof NotificationShowSchema>;

const NotificationCloseSchema = z.object({
  ids: z.array(NoticeIdSchema).min(1).max(MAX_IDS_PER_REQUEST),
});

const NotificationReconcileSchema = z.object({
  live: z.array(NoticeIdSchema).max(MAX_LIVE_IDS),
});

/** Endpoint ids whose link dropped (`attached` false) or came back on a resume (true). */
export type RemoteTransportFeed = (
  listener: (endpointIds: string[], attached: boolean) => void
) => () => void;

/**
 * Host side: a notification whose owner is a remote view goes to that view's
 * Shell instead of this machine's screen, and is taken down there once it has
 * been dealt with. When the Shell may have missed a close (the link dropped
 * and resumed, or a request to the view failed), the host tells it which of
 * its banners on that view are still live instead of replaying closes: what
 * it holds is the truth, however many closes went missing or in what order
 * their failures arrive.
 */
export function installRemoteNotificationSink(
  options: { onTransportChange?: RemoteTransportFeed } = {}
): () => void {
  /** Views shown a closable banner, watched so their banners are forgotten when they close. */
  const watched = new Map<number, Disposable>();
  /** Views whose Shell may have missed a close since it last heard what is live. */
  const unsure = new Set<number>();

  const remoteView = (endpoint: ClientEndpoint | undefined): ClientEndpoint | null =>
    endpoint && endpoint.kind === "remote-view" && !endpoint.isClosed() ? endpoint : null;

  const watch = (endpoint: ClientEndpoint): void => {
    const { handle } = endpoint;
    if (watched.has(handle)) return;
    watched.set(
      handle,
      endpoint.onClose(() => {
        watched.delete(handle);
        unsure.delete(handle);
        notificationService.forgetRemoteOwner(handle);
      })
    );
  };

  const markUnsure = (endpoint: ClientEndpoint) => (error: unknown) => {
    // A Shell from before closes existed refuses them, and always will; a
    // closed view's Shell takes its banners down itself.
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "UNSUPPORTED" || code === "VALIDATION" || endpoint.isClosed()) return;
    unsure.add(endpoint.handle);
  };

  const reconcile = (endpoint: ClientEndpoint): void => {
    unsure.delete(endpoint.handle);
    const live = notificationService.remoteBannerIds(endpoint.handle).slice(-MAX_LIVE_IDS);
    endpoint.request(NOTIFICATION_RECONCILE_METHOD, { live }).catch(markUnsure(endpoint));
  };

  const sendCloses = (endpoint: ClientEndpoint, ids: readonly string[]): void => {
    for (let at = 0; at < ids.length; at += MAX_IDS_PER_REQUEST) {
      const batch = ids.slice(at, at + MAX_IDS_PER_REQUEST);
      endpoint.request(NOTIFICATION_CLOSE_METHOD, { ids: batch }).catch(markUnsure(endpoint));
    }
  };

  const disposeSink = notificationService.setRemoteNotificationSink({
    show(notification: RemoteNotification) {
      const endpoint = remoteView(getEndpointRegistry().getByHandle(notification.ownerHandle));
      if (!endpoint) return;
      if (notification.id !== undefined) watch(endpoint);
      if (unsure.has(endpoint.handle)) reconcile(endpoint);
      const all = notification.supersedes ?? [];
      const supersedes = all.slice(0, MAX_IDS_PER_REQUEST);
      sendCloses(endpoint, all.slice(MAX_IDS_PER_REQUEST));
      const payload = {
        title: notification.title,
        body: notification.body,
        category: notification.category,
        ...(notification.navigation ? { navigation: notification.navigation } : {}),
        ...(notification.id !== undefined ? { id: notification.id } : {}),
        ...(supersedes.length > 0 ? { supersedes } : {}),
      };
      endpoint.request(NOTIFICATION_SHOW_METHOD, payload).catch(markUnsure(endpoint));
    },
    close(ownerHandle: number, ids: readonly string[]) {
      const endpoint = remoteView(getEndpointRegistry().getByHandle(ownerHandle));
      if (!endpoint) return;
      // The ids are no longer live, so a reconcile takes them down too.
      if (unsure.has(endpoint.handle)) reconcile(endpoint);
      else sendCloses(endpoint, ids);
    },
  });

  // A failed close's rejection can land after the resume it raced, so every
  // resume reconciles a view that has had closable banners, not only one
  // already marked unsure.
  const disposeTransport = options.onTransportChange?.((endpointIds, attached) => {
    if (!attached) return;
    for (const endpointId of endpointIds) {
      const endpoint = remoteView(getEndpointRegistry().get(endpointId));
      if (endpoint && watched.has(endpoint.handle)) reconcile(endpoint);
    }
  });

  return () => {
    disposeSink();
    disposeTransport?.();
    for (const watch of watched.values()) watch.dispose();
    watched.clear();
    unsure.clear();
  };
}

/** This machine's sound for each category, as its own agents' notifications would pick it. */
function deviceSoundFile(
  category: NotificationCategory,
  settings: NotificationSettings | undefined = store.get("notificationSettings")
): string | null {
  if (!settings?.soundEnabled) return null;
  switch (category) {
    case "completed":
      return settings.completedSoundFile;
    case "waiting":
      return settings.waitingSoundFile;
    case "escalation":
      return settings.escalationSoundFile;
    case "info":
      return null;
  }
}

/**
 * Shell side: present a host's notification, owned by the local view it was
 * addressed to so a click lands back in that view. The title says which host
 * it came from, in this device's own name for it, so a host can't pass its
 * words off as this machine's; a host past its share for the minute is
 * dropped quietly. This screen's choices hold back what they would of its
 * own agents', before the notice counts against that share: everything with
 * notifications off, and a completion during its quiet hours or session mute
 * (a waiting agent still pages through, as it does locally). Its own sound
 * settings pick the sound. Returns false for a payload that does not validate.
 */
export function showHostNotification(
  webContentsId: number,
  payload: unknown,
  host: { id: string; name: string },
  now = Date.now()
): boolean {
  const parsed = NotificationShowSchema.safeParse(payload);
  if (!parsed.success) return false;
  const { category, navigation, id, supersedes } = parsed.data;
  // Banners this one replaces were dealt with whether or not it shows.
  if (supersedes) closeHostBanners(host.id, supersedes);
  const settings = store.get("notificationSettings");
  if (settings?.enabled === false) return true;
  if (
    category === "completed" &&
    (agentNotificationService.isSessionMuted() || isScheduledQuietNow(settings, new Date(now)))
  ) {
    return true;
  }
  if (!admitHostNotice(host.id, now)) return true;
  const title = `${displaySafeText(host.name).trim() || host.id}: ${displaySafeText(parsed.data.title)}`;
  const body = displaySafeText(parsed.data.body);
  const soundFile = deviceSoundFile(category, settings);
  if (soundFile) soundService.playFile(soundFile);
  if (id !== undefined) closeHostBanners(host.id, [id]);
  notificationService.showNativeNotification(title, body, {
    silent: true,
    ownerWebContentsId: webContentsId,
    ...(navigation ? { navigation } : {}),
    ...(id !== undefined ? { closeWithPanels: [hostBannerKey(host.id, id)] } : {}),
  });
  if (id !== undefined) trackHostBanner(host.id, id, webContentsId);
  return true;
}

/**
 * Most banners this Shell keeps closable for one host. Past it the oldest is
 * taken down: nothing could close it once forgotten, and a host's waiting
 * agents past this many have long since been paged about.
 */
const MAX_HOST_BANNERS = 32;

/** Each host's closable banners, by the id it gave them, to the view each was shown for; oldest first. */
const hostBanners = new Map<string, Map<string, number>>();

/**
 * What a host's banner closes with on this screen. Scoped by host, so two
 * hosts that name the same id can't reach each other's banners, and unlike
 * any local panel id.
 */
function hostBannerKey(hostId: string, id: string): string {
  return `host-notice:${hostId}:${id}`;
}

function trackHostBanner(hostId: string, id: string, webContentsId: number): void {
  let banners = hostBanners.get(hostId);
  if (!banners) {
    banners = new Map();
    hostBanners.set(hostId, banners);
  }
  banners.set(id, webContentsId);
  for (const oldest of banners.keys()) {
    if (banners.size <= MAX_HOST_BANNERS) break;
    closeHostBanners(hostId, [oldest]);
  }
}

function closeHostBanners(hostId: string, ids: Iterable<string>): void {
  const banners = hostBanners.get(hostId);
  for (const id of ids) {
    banners?.delete(id);
    notificationService.closeNotificationsForPanel(hostBannerKey(hostId, id));
  }
  if (banners?.size === 0) hostBanners.delete(hostId);
}

/**
 * Shell side: take down a host's banners once it says they have been dealt
 * with. Only ever by the ids it gave them, so a close that arrives late, or
 * after a reconnect, can't reach a newer banner. Not held back by this
 * screen's choices or the host's share: it only ever removes. Returns false
 * for a payload that does not validate.
 */
export function closeHostNotifications(payload: unknown, hostId: string): boolean {
  const parsed = NotificationCloseSchema.safeParse(payload);
  if (!parsed.success) return false;
  closeHostBanners(hostId, parsed.data.ids);
  return true;
}

/**
 * Shell side: the host says which of its banners on this view are still live;
 * any other this Shell shows for the view from that host was dealt with while
 * a close went missing. Only ever takes banners down, and only the host's own
 * on the view it was addressed to. Returns false for a payload that does not
 * validate.
 */
export function reconcileHostNotifications(
  webContentsId: number,
  payload: unknown,
  hostId: string
): boolean {
  const parsed = NotificationReconcileSchema.safeParse(payload);
  if (!parsed.success) return false;
  const banners = hostBanners.get(hostId);
  if (!banners) return true;
  const live = new Set(parsed.data.live);
  const gone = [...banners]
    .filter(([id, owner]) => owner === webContentsId && !live.has(id))
    .map(([id]) => id);
  closeHostBanners(hostId, gone);
  return true;
}

/**
 * Shell side: a host's view went away (closed, moved host, its connection
 * stopped), or the host forgot every view on a fresh session. The host can no
 * longer reach the banners it showed there, so they come down now rather than
 * stay up after their agents are answered; a host no window is showing pages
 * through its attention banners instead. Without a view, every one of the
 * host's banners goes.
 */
export function releaseHostNotifications(hostId: string, webContentsId?: number): void {
  const banners = hostBanners.get(hostId);
  if (!banners) return;
  const released = [...banners]
    .filter(([, owner]) => webContentsId === undefined || owner === webContentsId)
    .map(([id]) => id);
  closeHostBanners(hostId, released);
}

/** @internal Tests only. */
export function _resetHostBannersForTesting(): void {
  hostBanners.clear();
}

/**
 * Shell side: page for an opted-in host's waiting agent as a banner, titled
 * with the host's name as its own notifications are. The opt-in, this
 * screen's own choices and the host's notice budget were applied before it
 * got here, and a waiting agent pages through this screen's session mute as
 * a local one does. A later notice about the same terminal replaces it.
 */
export function showHostAttentionBanner(event: HostAttentionEvent, onClick: () => void): void {
  const host = displaySafeText(event.hostName).trim() || event.hostId;
  const who = event.agentName ?? "An agent";
  const where = event.projectName ? ` in ${event.projectName}` : "";
  const soundFile = deviceSoundFile("waiting");
  if (soundFile) soundService.playFile(soundFile);
  notificationService.showNativeNotification(
    `${host}: Agent waiting`,
    `${who}${where} is waiting for input`,
    {
      silent: true,
      category: "waiting",
      replaceKey: `host-attention:${event.hostId}:${event.terminalId}`,
      onClick,
    }
  );
}

/**
 * Shell side: which panels a remote view watches is the host's input, since
 * the host's agents trigger the notifications.
 */
export function installNotificationHostRelay(
  router: Pick<RemoteRouter, "hostForSender" | "forwardSend">
): () => void {
  return setNotificationHostRelay((senderWebContentsId, channel, args) => {
    const hostId = router.hostForSender(senderWebContentsId);
    if (hostId === null) return false;
    router.forwardSend(hostId, senderWebContentsId, channel, args);
    return true;
  });
}
