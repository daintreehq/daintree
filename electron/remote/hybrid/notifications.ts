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

/** Most ids one show may supersede, or one close may name. */
const MAX_IDS_PER_REQUEST = 64;

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

/**
 * Host side: a notification whose owner is a remote view goes to that view's
 * Shell instead of this machine's screen, and is taken down there once it has
 * been dealt with. A close the Shell may not have heard (the link dropped
 * while it was on its way) rides along with the next request to that view,
 * so a banner that missed its close can't stay up beside the next one.
 */
export function installRemoteNotificationSink(): () => void {
  const owed = new Map<number, string[]>();
  const closeWatches = new Map<number, Disposable>();

  const remoteView = (handle: number): ClientEndpoint | null => {
    const endpoint = getEndpointRegistry().getByHandle(handle);
    if (!endpoint || endpoint.kind !== "remote-view" || endpoint.isClosed()) return null;
    if (!closeWatches.has(handle)) {
      closeWatches.set(
        handle,
        endpoint.onClose(() => {
          closeWatches.delete(handle);
          owed.delete(handle);
          notificationService.forgetRemoteOwner(handle);
        })
      );
    }
    return endpoint;
  };

  const takeOwed = (handle: number, ids: readonly string[]): string[] => {
    const all = [...new Set([...(owed.get(handle) ?? []), ...ids])];
    owed.delete(handle);
    return all.slice(-MAX_IDS_PER_REQUEST);
  };

  const oweOnFailure = (endpoint: ClientEndpoint, ids: readonly string[]) => (error: unknown) => {
    // A Shell from before closes existed refuses them, and always will; a
    // closed view's Shell takes its banners down itself.
    const code = (error as { code?: unknown } | null)?.code;
    if (ids.length === 0 || code === "UNSUPPORTED" || code === "VALIDATION") return;
    if (endpoint.isClosed()) return;
    owed.set(endpoint.handle, takeOwed(endpoint.handle, ids));
  };

  const dispose = notificationService.setRemoteNotificationSink({
    show(notification: RemoteNotification) {
      const endpoint = remoteView(notification.ownerHandle);
      if (!endpoint) return;
      const supersedes = takeOwed(endpoint.handle, notification.supersedes ?? []);
      const payload = {
        title: notification.title,
        body: notification.body,
        category: notification.category,
        ...(notification.navigation ? { navigation: notification.navigation } : {}),
        ...(notification.id !== undefined ? { id: notification.id } : {}),
        ...(supersedes.length > 0 ? { supersedes } : {}),
      };
      endpoint
        .request(NOTIFICATION_SHOW_METHOD, payload)
        .catch(oweOnFailure(endpoint, supersedes));
    },
    close(ownerHandle: number, ids: readonly string[]) {
      const endpoint = remoteView(ownerHandle);
      if (!endpoint) return;
      const all = takeOwed(endpoint.handle, ids);
      if (all.length === 0) return;
      endpoint
        .request(NOTIFICATION_CLOSE_METHOD, { ids: all })
        .catch(oweOnFailure(endpoint, all));
    },
  });

  return () => {
    dispose();
    for (const watch of closeWatches.values()) watch.dispose();
    closeWatches.clear();
    owed.clear();
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
