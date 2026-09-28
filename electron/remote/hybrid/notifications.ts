import { z } from "zod";
import { CHANNELS } from "../../ipc/channels.js";
import type { RemoteRouter } from "../../ipc/endpoint.js";
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

/**
 * Host → Shell request: a notification the host decided on. It carries what
 * the notification is about, not how to present it: sound, and whether this
 * person muted the session, are this Shell's.
 */
export const NOTIFICATION_SHOW_METHOD = "notification.show";

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
});

export type NotificationShowPayload = z.infer<typeof NotificationShowSchema>;

/**
 * Host side: a notification whose owner is a remote view goes to that view's
 * Shell instead of this machine's screen.
 */
export function installRemoteNotificationSink(): () => void {
  return notificationService.setRemoteNotificationSink((notification: RemoteNotification) => {
    const endpoint = getEndpointRegistry().getByHandle(notification.ownerHandle);
    if (!endpoint || endpoint.kind !== "remote-view" || endpoint.isClosed()) return;
    const payload = {
      title: notification.title,
      body: notification.body,
      category: notification.category,
      ...(notification.navigation ? { navigation: notification.navigation } : {}),
    };
    endpoint.request(NOTIFICATION_SHOW_METHOD, payload).catch(() => {
      // The Shell went away or cannot display it; nothing to retry.
    });
  });
}

/** This machine's sound for each category, as its own agents' notifications would pick it. */
function deviceSoundFile(category: NotificationCategory): string | null {
  const settings = store.get("notificationSettings");
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
 * Shell side: present a host's notification as this machine's own, owned by
 * the local view it was addressed to, so a click lands back in that view.
 * This screen's session mute holds back a completion (a waiting agent still
 * pages through, as it does locally) and its own sound settings pick the
 * sound. Returns false for a payload that does not validate.
 */
export function showHostNotification(webContentsId: number, payload: unknown): boolean {
  const parsed = NotificationShowSchema.safeParse(payload);
  if (!parsed.success) return false;
  const { title, body, category, navigation } = parsed.data;
  if (category === "completed" && agentNotificationService.isSessionMuted()) return true;
  const soundFile = deviceSoundFile(category);
  if (soundFile) soundService.playFile(soundFile);
  notificationService.showNativeNotification(title, body, {
    silent: true,
    ownerWebContentsId: webContentsId,
    ...(navigation ? { navigation } : {}),
  });
  return true;
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
