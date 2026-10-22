import type {
  PluginProjectPresence,
  PluginProjectPresenceState,
} from "../../shared/types/plugin.js";
import { isProjectWorkspaceId, isScratchWorkspaceId } from "../../shared/utils/workspaceIds.js";
import { collectShownProjectIds } from "../window/activeProjectIds.js";
import { onProjectPresenceChanged } from "../window/projectPresenceChanges.js";

type OpenPresenceState = Exclude<PluginProjectPresenceState, "closed">;

export type ProjectPresenceListener = (changes: readonly PluginProjectPresence[]) => void;

/** A workspace this machine owns — a project or a scratch, never a remote host's view key. */
function isLocalWorkspaceId(id: string): boolean {
  return isProjectWorkspaceId(id) || isScratchWorkspaceId(id);
}

function presence(projectId: string, state: PluginProjectPresenceState): PluginProjectPresence {
  return Object.freeze({ projectId, state });
}

/**
 * Where each open workspace is, for plugins (#13813): foreground while a window
 * has switched to it or a remote Shell shows it, background while it is open
 * behind another, closed once its close commits.
 *
 * Closes come from the plugin lifecycle seam (`projectPluginLifecycle.ts`),
 * the edges that unload a project's own plugins, so "closed" means what it
 * means to them: closed, removed or slept. Eviction, hibernation and losing a
 * window are not closes, and leave the project in the background. A workspace
 * is open from the first time the seam opens it or a window shows it, since a
 * remote Shell shows projects the seam never hears about.
 *
 * What is shown is re-read whole on every presence invalidation rather than
 * told by each writer what moved (#10808).
 */
export class ProjectPresenceTracker {
  private readonly opened = new Set<string>();
  /**
   * Closed while a window still pointed at them. A close that kills terminals
   * runs against the project on screen, and the pointer only moves once the
   * renderer switches away, so the close has to outrank a pointer it outlived.
   * Released when the pointer moves off, or by the next open.
   */
  private readonly closedWhileShown = new Set<string>();
  private states = new Map<string, OpenPresenceState>();
  private readonly listeners = new Set<ProjectPresenceListener>();
  private readShown: () => Iterable<string>;

  constructor(readShown: () => Iterable<string> = () => []) {
    this.readShown = readShown;
  }

  /** Installed by main once it has windows to read; until then only the seam's edges count. */
  setShownReader(readShown: () => Iterable<string>): void {
    this.readShown = readShown;
    this.refresh();
  }

  markOpened(projectId: string): void {
    if (!isLocalWorkspaceId(projectId)) return;
    this.opened.add(projectId);
    this.closedWhileShown.delete(projectId);
    this.refresh();
  }

  markClosed(projectId: string): void {
    if (!isLocalWorkspaceId(projectId)) return;
    this.opened.delete(projectId);
    this.closedWhileShown.add(projectId);
    this.refresh();
  }

  getState(projectId: string): PluginProjectPresenceState {
    return this.states.get(projectId) ?? "closed";
  }

  /** Every open workspace, scratches included. */
  getOpen(): PluginProjectPresence[] {
    return [...this.states].map(([projectId, state]) => presence(projectId, state));
  }

  /** Called with every workspace whose state changed, closes included. */
  subscribe(listener: ProjectPresenceListener): () => void {
    const entry: ProjectPresenceListener = (changes) => listener(changes);
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  refresh(): void {
    let shown: Set<string>;
    try {
      shown = new Set([...this.readShown()].filter(isLocalWorkspaceId));
    } catch (err) {
      // Keep the last answer: a reader failing mid-teardown says nothing about
      // where projects are.
      console.error("[ProjectPresenceTracker] reading shown projects failed:", err);
      return;
    }
    for (const id of this.closedWhileShown) {
      if (!shown.has(id)) this.closedWhileShown.delete(id);
    }
    const next = new Map<string, OpenPresenceState>();
    for (const id of shown) {
      if (this.closedWhileShown.has(id)) continue;
      this.opened.add(id);
      next.set(id, "foreground");
    }
    for (const id of this.opened) {
      if (!next.has(id)) next.set(id, "background");
    }

    const changes: PluginProjectPresence[] = [];
    for (const [id, state] of next) {
      if (this.states.get(id) !== state) changes.push(presence(id, state));
    }
    for (const id of this.states.keys()) {
      if (!next.has(id)) changes.push(presence(id, "closed"));
    }
    this.states = next;
    if (changes.length === 0) return;
    const frozen = Object.freeze(changes);
    for (const listener of [...this.listeners]) {
      try {
        listener(frozen);
      } catch (err) {
        // Refreshes run inside view-manager mutations; a listener must never
        // abort one halfway.
        console.error("[ProjectPresenceTracker] listener failed:", err);
      }
    }
  }
}

let instance: ProjectPresenceTracker | null = null;

/**
 * The process-wide tracker, re-read on every presence invalidation. Created on
 * first use — by the lifecycle seam or by main's wiring, whichever comes first —
 * and reading only remote Shells until main installs the window reader.
 */
export function getProjectPresenceTracker(): ProjectPresenceTracker {
  if (!instance) {
    const tracker = new ProjectPresenceTracker(() =>
      collectShownProjectIds(null, "project-presence")
    );
    onProjectPresenceChanged(() => tracker.refresh());
    instance = tracker;
  }
  return instance;
}

export function _setProjectPresenceTrackerForTests(tracker: ProjectPresenceTracker | null): void {
  instance = tracker;
}
