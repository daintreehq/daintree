import { z } from "zod";
import { CHANNELS } from "../../ipc/channels.js";
import type { RemoteRouter } from "../../ipc/endpoint.js";
import { getEndpointRegistry } from "../../ipc/endpointRegistry.js";
import { setNotificationHostRelay } from "../../ipc/handlers/notifications.js";
import {
  notificationService,
  type RemoteNotification,
} from "../../services/NotificationService.js";

/** Host → Shell request: display a notification the host decided on. */
export const NOTIFICATION_SHOW_METHOD = "notification.show";

const NotificationShowSchema = z.object({
  title: z.string().max(512),
  body: z.string().max(4096),
  silent: z.boolean(),
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
      silent: notification.silent,
      ...(notification.navigation ? { navigation: notification.navigation } : {}),
    };
    endpoint.request(NOTIFICATION_SHOW_METHOD, payload).catch(() => {
      // The Shell went away or cannot display it; nothing to retry.
    });
  });
}

/**
 * Shell side: display a host's notification as this machine's own, owned by
 * the local view it was addressed to, so a click lands back in that view.
 * Returns false for a payload that does not validate.
 */
export function showHostNotification(webContentsId: number, payload: unknown): boolean {
  const parsed = NotificationShowSchema.safeParse(payload);
  if (!parsed.success) return false;
  const { title, body, silent, navigation } = parsed.data;
  notificationService.showNativeNotification(title, body, {
    silent,
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
