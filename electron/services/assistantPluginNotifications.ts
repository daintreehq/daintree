import type { HostWatchNotification } from "../../shared/types/hostControl.js";
import { assistantAgentMcpAccess } from "./pluginAgentMcp/projectEnablement.js";

/** A plugin's notification for an assistant (#18154), with the words only a read returns. */
export interface AssistantPluginNotification extends HostWatchNotification {
  title: string;
  body: string;
}

/** Notifications kept at once; past it the oldest no one holds goes first. */
export const ASSISTANT_NOTIFICATIONS_MAX = 128;
/** How long one waits for an assistant, and how long its taker may still read it. */
export const ASSISTANT_NOTIFICATION_KEEP_MS = 30 * 60_000;

export interface AssistantPluginNotificationsDeps {
  /** The person let this project's Assistant use this plugin's tools: the whole grant. */
  mayHear(projectId: string, pluginId: string): boolean;
  now(): number;
}

interface Row {
  notification: AssistantPluginNotification;
  /** The watch whose notice carries it, until that notice is typed or let go. */
  heldBy: string | null;
  /** The run it was given to: typed into its pane, or returned by its arm. */
  takenBy: string | null;
  /** When it was published, or taken: it is kept for its taker from then. */
  since: number;
}

export interface AssistantNotificationFilter {
  projectId: string | null;
  pluginId: string | null;
}

/**
 * Plugins' notifications marked for an assistant (#18154), each given to at
 * most one assistant run. Kept in memory only, bounded and for a while, so an
 * assistant that arms later still finds what no one took. Only notifications
 * whose project's Assistant the person gave that plugin's tools are kept, and
 * that grant is asked again at every hand-over and read.
 */
export class AssistantPluginNotifications {
  private readonly rows = new Map<string, Row>();
  private readonly listeners = new Set<(notification: AssistantPluginNotification) => void>();

  constructor(private readonly deps: AssistantPluginNotificationsDeps) {}

  /** Keeps one and tells the listeners, unless its project's Assistant may not hear that plugin. */
  publish(notification: AssistantPluginNotification): void {
    if (!this.deps.mayHear(notification.projectId, notification.pluginId)) return;
    this.prune();
    if (this.rows.size >= ASSISTANT_NOTIFICATIONS_MAX && !this.evictOne()) return;
    this.rows.set(notification.notificationId, {
      notification,
      heldBy: null,
      takenBy: null,
      since: this.deps.now(),
    });
    for (const listener of [...this.listeners]) listener(notification);
  }

  subscribe(listener: (notification: AssistantPluginNotification) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Whether the person still lets that project's Assistant hear that plugin. */
  mayHear(notification: HostWatchNotification): boolean {
    return this.deps.mayHear(notification.projectId, notification.pluginId);
  }

  /** Those no one holds or took that match, oldest first. */
  untaken(filter: AssistantNotificationFilter): AssistantPluginNotification[] {
    this.prune();
    const found: AssistantPluginNotification[] = [];
    for (const row of this.rows.values()) {
      if (row.heldBy !== null || row.takenBy !== null) continue;
      const notification = row.notification;
      if (filter.projectId !== null && notification.projectId !== filter.projectId) continue;
      if (filter.pluginId !== null && notification.pluginId !== filter.pluginId) continue;
      if (!this.mayHear(notification)) continue;
      found.push(notification);
    }
    return found.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Holds one for a watch's notice; false when it is gone, held or taken. */
  hold(notificationId: string, watchId: string): boolean {
    const row = this.rows.get(notificationId);
    if (row === undefined || row.heldBy !== null || row.takenBy !== null) return false;
    row.heldBy = watchId;
    return true;
  }

  /**
   * Lets go of one a watch held and never had typed; false when that watch
   * doesn't hold it, so a late answer never frees another's.
   */
  release(notificationId: string, watchId: string): boolean {
    const row = this.rows.get(notificationId);
    if (row === undefined || row.heldBy !== watchId || row.takenBy !== null) return false;
    row.heldBy = null;
    return true;
  }

  /**
   * Gives one to a run: from the watch holding it (`watchId`), or untaken
   * (`null`). False when it is gone, someone else holds or took it, or its
   * grant is off.
   */
  take(notificationId: string, watchId: string | null, run: string): boolean {
    const row = this.rows.get(notificationId);
    if (row === undefined || row.takenBy !== null || row.heldBy !== watchId) return false;
    if (!this.mayHear(row.notification)) return false;
    row.heldBy = null;
    row.takenBy = run;
    row.since = this.deps.now();
    return true;
  }

  /** One given to `run`, while it is kept and its grant is on; null otherwise. */
  read(notificationId: string, run: string): AssistantPluginNotification | null {
    this.prune();
    const row = this.rows.get(notificationId);
    if (row === undefined || row.takenBy !== run || !this.mayHear(row.notification)) return null;
    return row.notification;
  }

  /** Drops those past their time; one a watch's notice holds stays until it settles. */
  private prune(): void {
    const cutoff = this.deps.now() - ASSISTANT_NOTIFICATION_KEEP_MS;
    for (const [id, row] of this.rows) {
      if (row.heldBy === null && row.since <= cutoff) this.rows.delete(id);
    }
  }

  /** Makes room: the oldest no one holds or took, else the oldest taken; never one held. */
  private evictOne(): boolean {
    let victim: string | null = null;
    let taken: string | null = null;
    for (const [id, row] of this.rows) {
      if (row.heldBy !== null) continue;
      if (row.takenBy === null) {
        victim = id;
        break;
      }
      taken ??= id;
    }
    const id = victim ?? taken;
    if (id === null) return false;
    this.rows.delete(id);
    return true;
  }
}

let shared: AssistantPluginNotifications | null = null;

/**
 * This process's one store, made on first use and gated by the person's Agent
 * tools switch. Its callers import this module only once a plugin marks a
 * notification for an assistant or an assistant arms for one.
 */
export function assistantPluginNotifications(): AssistantPluginNotifications {
  shared ??= new AssistantPluginNotifications({
    mayHear: (projectId, pluginId) => assistantAgentMcpAccess(projectId, pluginId) !== "off",
    now: () => Date.now(),
  });
  return shared;
}
