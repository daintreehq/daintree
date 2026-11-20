import { randomUUID } from "node:crypto";
import { app, Notification, webContents as webContentsModule } from "electron";
import type { WindowRegistry, WindowContext } from "../window/WindowRegistry.js";
import { sendToRenderer } from "../ipc/utils.js";
import { getAppWebContents, getWindowForWebContents } from "../window/webContentsRegistry.js";
import { revealWindow } from "../window/projectOwnership.js";
import type {
  NotificationPlace,
  NotificationProjectOpener,
} from "../window/notificationNavigation.js";
import { getLinuxWindowIcon } from "../window/linuxWindowIcon.js";
import {
  FALLBACK_WINDOW_TITLE,
  composeWindowTitle,
  notifyWindowTitlesChanged,
  resolveWindowProjectName,
  type ProjectTitleLookup,
} from "../window/windowTitle.js";
import { readUserPresence, type UserPresence } from "./userPresence.js";
import { CHANNELS } from "../ipc/channels.js";
import { onProjectPresenceChanged } from "../window/projectPresenceChanges.js";
import type {
  DecisionQuestionList,
  DecisionQuestionReference,
  DecisionsOpenAttentionRequest,
  DecisionsOpenQuestionRequest,
} from "../../shared/types/decisionsQuestion.js";

export interface NotificationState {
  /** The panes this view counts as agents waiting on the person, by panel id. */
  waitingPanelIds: readonly string[];
  /**
   * Only which panes wait moved since the view's last report, not how many: a
   * report no view sent before panes were reported (#17233), which matters only
   * against a waiting question.
   */
  membershipOnly?: boolean;
}

/** A pane named by the workspace its view holds it under and its panel (terminal) id. */
function paneKey(workspaceKey: string, panelId: string): string {
  return `${workspaceKey}\0${panelId}`;
}

/** What each window's title and the Dock badge count. */
interface WaitingTally {
  byWindow: Map<number, number>;
  total: number;
}

export interface WatchNotificationContext {
  worktreeId?: string;
  panelId: string;
  panelTitle: string;
}

/**
 * A notification owner is the renderer that reported the state — a project
 * view's `webContents.id`, taken from `event.sender` at IPC time.
 *
 * Not the window id: one window hosts an active project view plus any number of
 * cached ones, each its own renderer with its own panel store. Not the project
 * id: `null` is a legitimate distinct identity (an unbound window showing the
 * project picker), and one project can be open in two windows at once (#11101).
 */
export type NotificationOwnerId = number;

export interface NotificationNavigation {
  channel: string;
  context: WatchNotificationContext;
}

/**
 * What a notification is about. The machine that presents it picks the sound
 * for it from its own settings: for a view on a remote Shell that is the
 * Shell, never the host that decided to notify.
 */
export type NotificationCategory = "completed" | "waiting" | "escalation" | "info";

export interface WatchNotificationOptions {
  silent?: boolean;
  /** Renderer that owns the panel — decides which window a click focuses. */
  ownerWebContentsId?: NotificationOwnerId;
  /**
   * Panels this banner is about. `closeNotificationsForPanel` removes it once
   * every one of them has been dealt with, so a grouped banner outlives the
   * first member to be handled. Omit it and the banner is never closed early.
   */
  closeWithPanels?: readonly string[];
  /** Defaults to "info" (no sound of its own) where a remote Shell presents it. */
  category?: NotificationCategory;
}

export interface NativeNotificationOptions extends WatchNotificationOptions {
  /** Attach to make the notification clickable. Without it, a click does nothing. */
  navigation?: NotificationNavigation;
  /**
   * Handles a click in main instead of routing `navigation` to a renderer.
   * Local banners only: a remote Shell's view never receives it.
   */
  onClick?: () => void;
  /**
   * A banner still showing with the same key is closed before this one goes
   * up, so a re-sent notification replaces its predecessor instead of
   * stacking. Electron's main-process `Notification` has no tag.
   */
  replaceKey?: string;
}

const DEBOUNCE_MS = 300;

/**
 * Most keyed banners kept for replacement. One that timed out into Action
 * Center is otherwise held until something replaces it, so a plugin paging
 * under ever-new keys would grow the set without end.
 */
const MAX_KEYED_NOTIFICATIONS = 50;

/**
 * Most remote banners this host keeps closable. Past it the oldest is closed on
 * its Shell and forgotten, so a view that never deals with its agents can't
 * grow the map without end.
 */
const MAX_REMOTE_BANNERS = 200;

/** A decided notification whose owner is a view on a remote Shell. */
export interface RemoteNotification {
  /** The owning remote endpoint's handle (negative). */
  ownerHandle: number;
  title: string;
  body: string;
  category: NotificationCategory;
  navigation?: NotificationNavigation;
  /**
   * This banner's identity, present when this host may later take it down
   * (it closes with panels, or a later one replaces it). Never reused, so a
   * close that arrives late can only reach the banner it was meant for.
   */
  id?: string;
  /** Banners of the same owner this one replaces, taken down before it shows. */
  supersedes?: string[];
}

/**
 * Delivers notifications to the Shell that owns them, and takes them down
 * there once they have been dealt with. Installed by the Remote Hosts host
 * side; with none installed a remote owner's notification is dropped, since
 * this machine's screen is not the one being watched.
 */
export interface RemoteNotificationSink {
  show(notification: RemoteNotification): void;
  close(ownerHandle: number, ids: readonly string[]): void;
}

/** A banner this host showed on a remote Shell and may still have to take down. */
interface RemoteBanner {
  ownerHandle: number;
  /** Panels still outstanding; empty for a banner only a replacement takes down. */
  pending: Set<string>;
  replaceKey?: string;
}

/**
 * Whether the owner is a view on a remote Shell. Remote endpoint handles are
 * negative; `WebContents` ids never are.
 */
export function isRemoteNotificationOwner(
  ownerId: NotificationOwnerId | undefined
): ownerId is number {
  return typeof ownerId === "number" && ownerId < 0;
}

interface TrackedWindow {
  browserWindow: import("electron").BrowserWindow;
  focusHandler: () => void;
  blurHandler: () => void;
}

class NotificationService {
  private registry: WindowRegistry | null = null;
  private projectLookup: ProjectTitleLookup | null = null;
  private openProject: NotificationProjectOpener | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private statesByOwner = new Map<NotificationOwnerId, NotificationState>();
  private focusedWindows = new Set<number>();
  private trackedWindows = new Map<number, TrackedWindow>();
  private activeNotifications = new Set<Notification>();
  /** Panels still outstanding for each banner that asked to close with them. */
  private pendingPanelsByNotification = new Map<Notification, Set<string>>();
  private notificationsByReplaceKey = new Map<string, Notification>();
  /** Closable banners on remote Shells, by id, oldest first. */
  private remoteBanners = new Map<string, RemoteBanner>();
  /**
   * Each pane holding a Decisions question that waits on the person (#17233),
   * by `paneKey(projectId, terminalId)`, to its project id. Empty while
   * Decisions is off, which leaves every count as the agents' alone.
   */
  private questionPanes: ReadonlyMap<string, string> = new Map();
  /** This service lifetime's watch of the question list; a stale import finds it replaced. */
  private questionWatch: object | null = null;
  private offDecisionQuestions: (() => void) | null = null;
  /** Held only while a question waits, since only then does where projects are open move a count. */
  private offProjectPresence: (() => void) | null = null;
  private presenceRecountPending = false;

  private remoteSink: RemoteNotificationSink | null = null;

  /** The host decides; the Shell that owns the view displays. */
  setRemoteNotificationSink(sink: RemoteNotificationSink | null): () => void {
    this.remoteSink = sink;
    return () => {
      if (this.remoteSink === sink) this.remoteSink = null;
    };
  }

  detachWindowListeners(windowId: number): void {
    const tracked = this.trackedWindows.get(windowId);
    if (!tracked) return;
    if (!tracked.browserWindow.isDestroyed()) {
      tracked.browserWindow.off("focus", tracked.focusHandler);
      tracked.browserWindow.off("blur", tracked.blurHandler);
    }
    this.trackedWindows.delete(windowId);
    this.focusedWindows.delete(windowId);
  }

  private detachAllWindowListeners(): void {
    for (const id of [...this.trackedWindows.keys()]) {
      this.detachWindowListeners(id);
    }
  }

  /**
   * The webContents id of the view a window is currently showing — the renderer
   * that receives the DOM focus event and zeroes its own count. Clearing only
   * this owner on window focus keeps a cached project view's unseen waiting
   * agents counted: the user hasn't looked at them yet, and switching to that
   * view focuses its webContents, which zeroes it through the normal path.
   */
  private activeOwnerOf(
    browserWindow: import("electron").BrowserWindow
  ): NotificationOwnerId | null {
    try {
      const webContents = getAppWebContents(browserWindow);
      return typeof webContents?.id === "number" ? webContents.id : null;
    } catch {
      return null;
    }
  }

  private attachWindowListeners(ctx: WindowContext): void {
    const windowId = ctx.windowId;

    if (this.trackedWindows.has(windowId)) return;

    if (ctx.browserWindow.isFocused()) {
      this.focusedWindows.add(windowId);
    }

    const focusHandler = () => {
      this.focusedWindows.add(windowId);

      const activeOwner = this.activeOwnerOf(ctx.browserWindow);
      if (activeOwner !== null) {
        this.statesByOwner.delete(activeOwner);
      }

      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }

      this.applyNotifications();
    };

    const blurHandler = () => {
      this.focusedWindows.delete(windowId);
    };

    ctx.browserWindow.on("focus", focusHandler);
    ctx.browserWindow.on("blur", blurHandler);

    this.trackedWindows.set(windowId, {
      browserWindow: ctx.browserWindow,
      focusHandler,
      blurHandler,
    });
  }

  /**
   * `projectLookup` resolves a ProjectViewManager id to its project row so each
   * window's title can name what it is showing. Injected rather than imported
   * so the service stays free of the SQLite-backed project store — omit it and
   * every window falls back to the app name. `openProject` is how a click on a
   * banner for a project that isn't on screen switches to it; omit it and the
   * click is delivered to the owning view where it is.
   */
  initialize(
    registry: WindowRegistry,
    projectLookup?: ProjectTitleLookup,
    openProject?: NotificationProjectOpener
  ): void {
    this.detachAllWindowListeners();
    this.registry = registry;
    this.projectLookup = projectLookup ?? null;
    this.openProject = openProject ?? null;

    for (const ctx of registry.all()) {
      this.attachWindowListeners(ctx);
    }
    this.watchDecisionQuestions();
  }

  /**
   * Questions waiting on the person count until they are answered, declined,
   * withdrawn or expire, focus or not (#17233). Read from the list Decisions
   * publishes for main (#17229), imported on demand so Decisions adds nothing
   * to startup; the list is empty while Decisions is off.
   */
  private watchDecisionQuestions(): void {
    if (this.questionWatch !== null) return;
    const watch = {};
    this.questionWatch = watch;
    void import("./decisionsQuestionList.js").then(
      ({ getDecisionQuestionList, onDecisionQuestionsChanged }) => {
        if (this.questionWatch !== watch) return;
        this.offDecisionQuestions = onDecisionQuestionsChanged((list) =>
          this.noteDecisionQuestions(list)
        );
        this.noteDecisionQuestions(getDecisionQuestionList());
      },
      (err) => console.warn("[NotificationService] failed to load the question list:", err)
    );
  }

  /**
   * Counts each pane with a question waiting on the person once, however many
   * it holds. One whose ask they've seen or cleared here (#17895) waits on
   * the agent's side only, and counts no more until it asks something new.
   */
  private noteDecisionQuestions(list: DecisionQuestionList): void {
    const panes = new Map<string, string>();
    for (const question of list.questions) {
      if (question.standing.kind !== "waiting") continue;
      if (question.inbox?.seen === true || question.inbox?.cleared === true) continue;
      const { projectId, terminalId } = question.reference;
      panes.set(paneKey(projectId, terminalId), projectId);
    }
    const previous = this.questionPanes;
    if (panes.size === previous.size && [...panes.keys()].every((key) => previous.has(key))) {
      return;
    }
    this.questionPanes = panes;
    this.watchProjectPresence(panes.size > 0);
    this.applyNotifications();
  }

  /**
   * A question counts in the title of each window holding a view of its
   * project, so a view opened, restored or evicted moves it without an agent
   * report or a question changing. Recounted once the mutation that reported
   * it has finished, since the listener runs inside it.
   */
  private watchProjectPresence(on: boolean): void {
    if (on && this.offProjectPresence === null) {
      const watch = this.questionWatch;
      this.offProjectPresence = onProjectPresenceChanged(() => {
        if (this.presenceRecountPending) return;
        this.presenceRecountPending = true;
        queueMicrotask(() => {
          this.presenceRecountPending = false;
          if (this.questionWatch !== watch || this.questionPanes.size === 0) return;
          this.applyNotifications();
        });
      });
    } else if (!on && this.offProjectPresence !== null) {
      this.offProjectPresence();
      this.offProjectPresence = null;
    }
  }

  updateNotifications(ownerWebContentsId: NotificationOwnerId, state: NotificationState): void {
    // A marked report only moves panes within the count its view last reported;
    // one landing after focus cleared that report would bring back what was seen.
    const previous = this.statesByOwner.get(ownerWebContentsId);
    if (
      state.membershipOnly === true &&
      previous?.waitingPanelIds.length !== state.waitingPanelIds.length
    ) {
      return;
    }
    this.statesByOwner.set(ownerWebContentsId, state);
    // Panes trading places are kept for the next pass but bring none of their
    // own with no question waiting, so with Decisions off every pass runs when
    // it always did. Nor do they postpone a pass already armed, which tallies
    // the latest state when it runs.
    if (
      state.membershipOnly === true &&
      (this.questionPanes.size === 0 || this.debounceTimer !== null)
    ) {
      return;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.applyNotifications();
    }, DEBOUNCE_MS);
  }

  /**
   * Drop an owner's state when its renderer is gone. Idempotent — a destroyed
   * webContents and its window's cleanup can both fire.
   */
  removeOwner(ownerWebContentsId: NotificationOwnerId): void {
    if (!this.statesByOwner.delete(ownerWebContentsId)) return;
    this.applyNotifications();
  }

  private applyNotifications(): void {
    if (!this.registry) return;

    this.pruneDeadOwners();
    const { byWindow, total } = this.tally();

    for (const ctx of this.registry.all()) {
      this.writeTitle(ctx, byWindow.get(ctx.windowId) ?? 0);
    }
    notifyWindowTitlesChanged();

    if (process.platform === "darwin") {
      app.setBadgeCount(total);
    }
  }

  /**
   * Recompose every live window's title against the project each one is now
   * showing, without touching the waiting counts or the Dock badge.
   *
   * Called after a project switch, rename, close, or removal — the moments the
   * displayed identity changes but the notification state does not. Refreshing
   * every window rather than a named one is deliberate: each window answers from
   * its own ProjectViewManager, so there is no cross-window filter to get wrong
   * (a cached, non-visible view for the same project must not retitle its host).
   */
  refreshTitles(): void {
    if (!this.registry) return;

    const { byWindow } = this.tally();
    for (const ctx of this.registry.all()) {
      this.writeTitle(ctx, byWindow.get(ctx.windowId) ?? 0);
    }
    notifyWindowTitlesChanged();
  }

  /**
   * An owner that no longer resolves to a window is dead or dying: a view's
   * webContents id is indexed at creation, before its renderer can send any
   * IPC, and is unindexed only on eviction (which closes it) or window
   * teardown. Pruning keeps the badge honest even if a "destroyed" event is
   * missed.
   *
   * Only `applyNotifications` prunes, because dropping an owner changes the
   * total the badge is about to be set from. A title-only pass that pruned
   * would leave the badge stale AND make the later `removeOwner` a no-op, since
   * its `delete` would find nothing left to remove.
   */
  private pruneDeadOwners(): void {
    if (!this.registry) return;

    for (const ownerId of [...this.statesByOwner.keys()]) {
      const ctx = this.registry.getByWebContentsId(ownerId);
      if (!ctx || ctx.browserWindow.isDestroyed()) {
        this.statesByOwner.delete(ownerId);
      }
    }
  }

  /**
   * Each pane waiting on the person once: an agent seen waiting, or a
   * Decisions question waiting (#17233), and a pane that is both counts once.
   * A window's title counts its own views' agents and the questions of every
   * project it holds a view of, active or cached; the Dock counts every pane
   * once, so a question whose project is open nowhere still reaches it, and
   * one open in two windows counts once there. With no question waiting this
   * is each window's sum of its owners' agents, as it always was.
   */
  private tally(): WaitingTally {
    const byWindow = new Map<number, number>();
    if (!this.registry) return { byWindow, total: 0 };

    const questions = this.questionPanes;
    const views = questions.size > 0 ? this.viewsByWindow() : null;
    let total = questions.size;

    for (const [ownerId, state] of this.statesByOwner) {
      const ctx = this.registry.getByWebContentsId(ownerId);
      if (!ctx || ctx.browserWindow.isDestroyed()) continue;
      const workspaceKey = views?.get(ctx.windowId)?.workspaceOfOwner.get(ownerId);
      let count = state.waitingPanelIds.length;
      if (workspaceKey !== undefined) {
        for (const panelId of state.waitingPanelIds) {
          if (questions.has(paneKey(workspaceKey, panelId))) count -= 1;
        }
      }
      total += count;
      byWindow.set(ctx.windowId, (byWindow.get(ctx.windowId) ?? 0) + count);
    }

    for (const [windowId, { workspaces }] of views ?? []) {
      let count = 0;
      for (const projectId of questions.values()) {
        if (workspaces.has(projectId)) count += 1;
      }
      if (count > 0) byWindow.set(windowId, (byWindow.get(windowId) ?? 0) + count);
    }
    return { byWindow, total };
  }

  /**
   * The workspaces each live window holds a view of, and which workspace each
   * of its views' renderers shows. A host-qualified view's key never matches
   * a question, which names a project of this computer's.
   */
  private viewsByWindow(): Map<
    number,
    { workspaces: Set<string>; workspaceOfOwner: Map<NotificationOwnerId, string> }
  > {
    const byWindow = new Map<
      number,
      { workspaces: Set<string>; workspaceOfOwner: Map<NotificationOwnerId, string> }
    >();
    for (const ctx of this.registry?.all() ?? []) {
      if (ctx.browserWindow.isDestroyed()) continue;
      const workspaces = new Set<string>();
      const workspaceOfOwner = new Map<NotificationOwnerId, string>();
      // Read as possibly missing: Electron leaves a destroyed view's `webContents` undefined.
      let entries: readonly {
        projectId: string;
        view: { webContents?: import("electron").WebContents };
      }[];
      try {
        entries = ctx.services.projectViewManager?.getAllViews() ?? [];
      } catch {
        // A window tearing down can throw from its view manager; it holds nothing then.
        continue;
      }
      for (const entry of entries) {
        // One view torn down under a window never costs the window its other views.
        try {
          const contents = entry.view.webContents;
          if (!contents || contents.isDestroyed()) continue;
          workspaces.add(entry.projectId);
          workspaceOfOwner.set(contents.id, entry.projectId);
        } catch {
          continue;
        }
      }
      byWindow.set(ctx.windowId, { workspaces, workspaceOfOwner });
    }
    return byWindow;
  }

  /**
   * Best-effort by construction: callers invoke this from a `finally` after a
   * switch or rename has already committed, so a throw here would replace the
   * original result and mask the real failure.
   */
  private writeTitle(ctx: WindowContext, waitingCount: number): void {
    if (ctx.browserWindow.isDestroyed()) return;

    try {
      const projectName = resolveWindowProjectName(
        ctx.services.projectViewManager,
        this.projectLookup
      );
      ctx.browserWindow.setTitle(composeWindowTitle(projectName, waitingCount));
    } catch (err) {
      console.warn("[NotificationService] failed to set window title:", err);
    }
  }

  /**
   * Only runs from `dispose()`, so it deliberately drops back to the plain app
   * name rather than resolving project names: the store is closing on the
   * shutdown path, and nothing reads these titles again.
   */
  private clearNotifications(): void {
    if (this.registry) {
      for (const ctx of this.registry.all()) {
        if (!ctx.browserWindow.isDestroyed()) {
          ctx.browserWindow.setTitle(FALLBACK_WINDOW_TITLE);
        }
      }
    }

    if (process.platform === "darwin") {
      app.setBadgeCount(0);
    }
  }

  isWindowFocused(): boolean {
    return this.focusedWindows.size > 0;
  }

  /**
   * True only while the owner's renderer is the view its window is showing and
   * that window has focus. A cached view, or a window behind another, does not
   * count — its panels are out of sight.
   */
  isOwnerViewFocused(ownerWebContentsId: NotificationOwnerId | undefined): boolean {
    if (ownerWebContentsId === undefined || !this.registry) return false;
    const ctx = this.registry.getByWebContentsId(ownerWebContentsId);
    if (!ctx || ctx.browserWindow.isDestroyed()) return false;
    if (!this.focusedWindows.has(ctx.windowId)) return false;
    return this.activeOwnerOf(ctx.browserWindow) === ownerWebContentsId;
  }

  getUserPresence(): UserPresence {
    return readUserPresence();
  }

  /**
   * The panel has been dealt with — acknowledged, or its agent stopped waiting.
   * Banners that were only about it leave Notification Center; grouped banners
   * just drop it and stay until their last member goes the same way.
   *
   * `close()` is a no-op for a banner the user already dismissed, and on
   * unsigned macOS builds, so the tracking is cleared here rather than relying
   * on the "close" event to arrive.
   */
  closeNotificationsForPanel(panelId: string): void {
    for (const [notification, pending] of [...this.pendingPanelsByNotification]) {
      if (!pending.delete(panelId) || pending.size > 0) continue;
      this.forgetNotification(notification);
      try {
        notification.close();
      } catch (err) {
        console.warn("[NotificationService] failed to close native notification:", err);
      }
    }
    const doneByOwner = new Map<number, string[]>();
    for (const [id, banner] of [...this.remoteBanners]) {
      if (!banner.pending.delete(panelId) || banner.pending.size > 0) continue;
      this.remoteBanners.delete(id);
      const done = doneByOwner.get(banner.ownerHandle);
      if (done) done.push(id);
      else doneByOwner.set(banner.ownerHandle, [id]);
    }
    for (const [ownerHandle, ids] of doneByOwner) this.closeRemote(ownerHandle, ids);
  }

  /**
   * The remote view is gone, and so is any way to reach its banners: its
   * Shell takes them down itself when its views go away.
   */
  forgetRemoteOwner(ownerHandle: number): void {
    for (const [id, banner] of [...this.remoteBanners]) {
      if (banner.ownerHandle === ownerHandle) this.remoteBanners.delete(id);
    }
  }

  /** Ids of the banners this host still holds on a remote owner, oldest first. */
  remoteBannerIds(ownerHandle: number): string[] {
    const ids: string[] = [];
    for (const [id, banner] of this.remoteBanners) {
      if (banner.ownerHandle === ownerHandle) ids.push(id);
    }
    return ids;
  }

  private closeRemote(ownerHandle: number, ids: readonly string[]): void {
    try {
      this.remoteSink?.close(ownerHandle, ids);
    } catch (error) {
      console.warn("[NotificationService] remote notification close failed:", error);
    }
  }

  /**
   * Hand a remote owner's notification to its Shell, giving it an identity
   * when this host may take it down later, as `closeWithPanels` and
   * `replaceKey` do for a banner on this screen.
   */
  private showRemote(
    notification: Omit<RemoteNotification, "id" | "supersedes">,
    closeWithPanels: readonly string[] | undefined,
    replaceKey: string | undefined
  ): void {
    if (!this.remoteSink) return;
    const { ownerHandle } = notification;
    const closable = (closeWithPanels && closeWithPanels.length > 0) || replaceKey !== undefined;
    let id: string | undefined;
    const supersedes: string[] = [];
    if (closable) {
      if (replaceKey !== undefined) {
        for (const [heldId, banner] of [...this.remoteBanners]) {
          if (banner.ownerHandle !== ownerHandle || banner.replaceKey !== replaceKey) continue;
          this.remoteBanners.delete(heldId);
          supersedes.push(heldId);
        }
      }
      id = randomUUID();
      this.remoteBanners.set(id, {
        ownerHandle,
        pending: new Set(closeWithPanels ?? []),
        ...(replaceKey !== undefined ? { replaceKey } : {}),
      });
      for (const [oldestId, oldest] of this.remoteBanners) {
        if (this.remoteBanners.size <= MAX_REMOTE_BANNERS) break;
        this.remoteBanners.delete(oldestId);
        if (oldest.ownerHandle === ownerHandle) supersedes.push(oldestId);
        else this.closeRemote(oldest.ownerHandle, [oldestId]);
      }
    }
    try {
      this.remoteSink?.show({
        ...notification,
        ...(id !== undefined ? { id } : {}),
        ...(supersedes.length > 0 ? { supersedes } : {}),
      });
    } catch (error) {
      console.warn("[NotificationService] remote notification delivery failed:", error);
    }
  }

  private forgetNotification(notification: Notification): void {
    this.activeNotifications.delete(notification);
    this.pendingPanelsByNotification.delete(notification);
    for (const [key, held] of this.notificationsByReplaceKey) {
      if (held === notification) this.notificationsByReplaceKey.delete(key);
    }
  }

  /**
   * Take down the banner showing under `replaceKey`. Its listeners go first:
   * `close()` can emit synchronously, and a late click must not run on behalf
   * of the banner that replaced it.
   */
  closeNotificationByKey(replaceKey: string): void {
    const previous = this.notificationsByReplaceKey.get(replaceKey);
    if (!previous) return;
    this.forgetNotification(previous);
    previous.removeAllListeners();
    try {
      previous.close();
    } catch (err) {
      console.warn("[NotificationService] failed to close native notification:", err);
    }
  }

  showNativeNotification(
    title: string,
    body: string,
    options: NativeNotificationOptions = {}
  ): void {
    this.showNotification(title, body, options);
  }

  showWatchNotification(
    title: string,
    body: string,
    context: WatchNotificationContext,
    navigateChannel: string,
    options: WatchNotificationOptions = {}
  ): void {
    this.showNotification(title, body, {
      ...options,
      navigation: { channel: navigateChannel, context },
    });
  }

  private showNotification(title: string, body: string, options: NativeNotificationOptions): void {
    const {
      silent = true,
      ownerWebContentsId,
      navigation,
      closeWithPanels,
      category = "info",
      onClick,
      replaceKey,
    } = options;
    if (isRemoteNotificationOwner(ownerWebContentsId)) {
      this.showRemote(
        { ownerHandle: ownerWebContentsId, title, body, category, navigation },
        closeWithPanels,
        replaceKey
      );
      return;
    }

    if (!Notification.isSupported()) return;
    if (replaceKey !== undefined) this.closeNotificationByKey(replaceKey);

    // On Linux Electron sends no app icon, only a `desktop-entry` hint that the
    // spec leaves daemons free to ignore, and an AppImage has no installed
    // desktop entry for it to name. The image is what every daemon draws.
    const icon = getLinuxWindowIcon();
    const notification = new Notification({ title, body, silent, ...(icon ? { icon } : {}) });
    this.activeNotifications.add(notification);
    if (replaceKey !== undefined) {
      this.notificationsByReplaceKey.set(replaceKey, notification);
      for (const [key, held] of this.notificationsByReplaceKey) {
        if (this.notificationsByReplaceKey.size <= MAX_KEYED_NOTIFICATIONS) break;
        this.notificationsByReplaceKey.delete(key);
        this.forgetNotification(held);
        held.removeAllListeners();
      }
    }
    if (closeWithPanels && closeWithPanels.length > 0) {
      this.pendingPanelsByNotification.set(notification, new Set(closeWithPanels));
    }

    const cleanup = () => {
      this.forgetNotification(notification);
    };
    notification.on("close", (details) => {
      // A Windows toast that times out moves to Action Center rather than
      // going away, so one that closes with its panels stays tracked until
      // they are dealt with. Nothing else could ever close it, so the rest go.
      // A keyed banner stays tracked too, so its replacement can still take
      // it out of Action Center.
      if (
        details?.reason === "timedOut" &&
        (this.pendingPanelsByNotification.has(notification) ||
          (replaceKey !== undefined &&
            this.notificationsByReplaceKey.get(replaceKey) === notification))
      ) {
        return;
      }
      cleanup();
    });
    notification.once("failed", (_event, error) => {
      // Electron 42 routes macOS notifications through UNNotification, which
      // silently emits "failed" on unsigned dev builds instead of displaying.
      // Surface it as a diagnostic — signed release builds never hit this.
      console.warn(
        "[NotificationService] native notification failed (unsigned macOS dev build?):",
        error
      );
      cleanup();
    });

    if (onClick) {
      notification.once("click", () => {
        cleanup();
        try {
          onClick();
        } catch (err) {
          console.warn("[NotificationService] notification click handler failed:", err);
        }
      });
    } else if (navigation) {
      // Taken now, while the owning view is alive: the banner can outlive it.
      const place = this.placeOf(ownerWebContentsId);
      notification.once("click", () => {
        cleanup();
        this.routeNavigation(navigation.channel, navigation.context, ownerWebContentsId, place);
      });
    }

    notification.show();
  }

  /**
   * Focus the window that owns the panel and hand the navigate to the owning
   * renderer itself. The owner is re-resolved here rather than captured when
   * the notification was created: a view can be evicted or its window closed
   * while the banner sits on screen.
   *
   * `sendToRenderer` would deliver to whichever project view the window happens
   * to be showing, so a panel in a cached view would never receive it — send
   * straight to the owning webContents instead. The primary window is the
   * explicit last resort for a notification whose owner is gone.
   *
   * A project that isn't on screen — its view cached, or evicted since the
   * banner went up — is switched to through the renderer-owned project switch
   * instead (#15233), which saves the outgoing layout and lands on the panel
   * once the project is showing.
   */
  private routeNavigation(
    navigateChannel: string,
    context: WatchNotificationContext,
    ownerWebContentsId?: NotificationOwnerId,
    place?: NotificationPlace | null
  ): void {
    if (this.sendToOwner(navigateChannel, context, ownerWebContentsId)) return;
    if (place && this.openProject?.(place, context.panelId)) return;

    // The owner is gone, or died between the guard and the send. Falling back to
    // the primary window is a guess — it delivers to whichever view that window
    // is showing — but a click that does nothing at all is worse.
    const fallbackWindow = this.registry?.getPrimary()?.browserWindow;
    if (!fallbackWindow || fallbackWindow.isDestroyed()) return;

    revealWindow(fallbackWindow);
    sendToRenderer(fallbackWindow, navigateChannel, context);
  }

  /**
   * Opens a Decisions question (#17232) in the question view of a window on
   * this computer, at `messageId` in its thread when given (#17235): the most
   * recently focused one showing the question's project, else the most
   * recently focused one. No project is switched to: every window reads a
   * question by its reference, whatever it shows. A view still loading gets
   * it once it subscribes (the preload replays it). False when no window
   * could take it.
   */
  openDecisionQuestion(reference: DecisionQuestionReference, messageId?: string): boolean {
    return this.sendToDecisionsWindow(
      reference.projectId,
      "decisions:open-question",
      messageId === undefined ? { reference } : { reference, messageId }
    );
  }

  /**
   * Opens the list of answers needing attention (#17235) at the pane that
   * asked `reference`, in a window on this computer chosen as a question is.
   * The list is this computer's, whatever project the window shows.
   */
  openDecisionAttention(reference: DecisionQuestionReference): boolean {
    return this.sendToDecisionsWindow(reference.projectId, "decisions:open-attention", {
      terminalId: reference.terminalId,
    });
  }

  private sendToDecisionsWindow(
    projectId: string,
    name: "decisions:open-question" | "decisions:open-attention",
    payload: DecisionsOpenQuestionRequest | DecisionsOpenAttentionRequest
  ): boolean {
    const targets = (this.registry?.focusOrder() ?? []).flatMap((ctx) => {
      const window = ctx.browserWindow;
      if (window.isDestroyed()) return [];
      const contents = getAppWebContents(window);
      // With its app view gone the window answers with its own blank contents, which show nothing.
      if (contents.isDestroyed() || contents === window.webContents) return [];
      return [{ window, contents }];
    });
    const target =
      targets.find(({ contents }) => this.placeOf(contents.id)?.workspaceKey === projectId) ??
      targets[0];
    if (!target) return false;
    revealWindow(target.window);
    try {
      target.contents.focus();
      target.contents.send(CHANNELS.EVENTS_PUSH, { name, payload });
      return true;
    } catch {
      // The view went between the check and the send.
      return false;
    }
  }

  /** False when the owner could not be reached, so the caller falls back. */
  private sendToOwner(
    navigateChannel: string,
    context: WatchNotificationContext,
    ownerWebContentsId?: NotificationOwnerId
  ): boolean {
    if (ownerWebContentsId === undefined) return false;

    const ownerWebContents = webContentsModule.fromId(ownerWebContentsId);
    if (!ownerWebContents || ownerWebContents.isDestroyed()) return false;

    const ownerWindow = getWindowForWebContents(ownerWebContents);
    if (ownerWindow && !ownerWindow.isDestroyed()) {
      // A cached view: its project switches in rather than being told to focus
      // a panel nobody can see.
      const place = this.placeOf(ownerWebContentsId);
      if (
        place &&
        !this.isOnScreen(ownerWindow, ownerWebContentsId, place) &&
        this.openProject?.(place, context.panelId)
      ) {
        return true;
      }
      revealWindow(ownerWindow);
    }

    try {
      ownerWebContents.send(navigateChannel, context);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether the window is showing the owner: its app view, or the outgoing view
   * a cold switch still holds over the incoming one. Switching to the project
   * that bridge already shows would be asked of the bridge itself, which has
   * nothing to switch to.
   */
  private isOnScreen(
    ownerWindow: import("electron").BrowserWindow,
    ownerWebContentsId: NotificationOwnerId,
    place: NotificationPlace
  ): boolean {
    if (getAppWebContents(ownerWindow).id === ownerWebContentsId) return true;
    try {
      const pvm = this.registry?.getByWindowId(place.windowId)?.services.projectViewManager;
      return pvm?.getOutgoingBridgeProjectId() === place.workspaceKey;
    } catch {
      return false;
    }
  }

  /** The window and workspace a local view belongs to, or null when it is neither. */
  private placeOf(ownerWebContentsId: NotificationOwnerId | undefined): NotificationPlace | null {
    if (ownerWebContentsId === undefined || isRemoteNotificationOwner(ownerWebContentsId)) {
      return null;
    }
    try {
      const ctx = this.registry?.getByWebContentsId(ownerWebContentsId);
      const entry = ctx?.services.projectViewManager
        ?.getAllViews()
        .find(
          (view) =>
            !view.view.webContents.isDestroyed() && view.view.webContents.id === ownerWebContentsId
        );
      return ctx && entry ? { windowId: ctx.windowId, workspaceKey: entry.projectId } : null;
    } catch {
      // A window tearing down can throw from any of these reads.
      return null;
    }
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.detachAllWindowListeners();
    this.clearNotifications();
    this.statesByOwner.clear();

    this.questionWatch = null;
    this.offDecisionQuestions?.();
    this.offDecisionQuestions = null;
    this.watchProjectPresence(false);
    this.questionPanes = new Map();

    for (const notification of this.activeNotifications) {
      notification.removeAllListeners();
    }
    this.activeNotifications.clear();
    this.pendingPanelsByNotification.clear();
    this.notificationsByReplaceKey.clear();
    this.remoteBanners.clear();

    this.registry = null;
    this.projectLookup = null;
    this.openProject = null;
    this.remoteSink = null;
  }
}

export const notificationService = new NotificationService();
