/** Notification type */
export type NotificationType = "info" | "success" | "error" | "warning";

/** A notification message to display to the user */
export interface Notification {
  /** Unique identifier for the notification */
  id: string;
  /** Message text to display */
  message: string;
  /** Type determines styling/icon */
  type: NotificationType;
}

/** Payload for creating a new notification (id is optional and will be generated) */
export type NotificationPayload = Omit<Notification, "id"> & { id?: string };
