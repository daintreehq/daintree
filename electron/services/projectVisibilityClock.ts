import { onProjectPresenceChanged } from "../window/projectPresenceChanges.js";

/**
 * When each project was last on screen in any window or remote Shell (#13844).
 *
 * Idle gates measure from this rather than from `lastOpened`: that is the
 * switcher's MRU order, and only a project-to-project switch stamps the project
 * being left. Leaving for a scratch, a remote host's project, a closed window or
 * a switch under disk-pressure write suppression all kept the open time, so a
 * project worked in all afternoon read as hours idle the moment it went.
 *
 * Fed whole snapshots of what is visible and diffed against the last one,
 * rather than told what moved by each writer (#10808). A project counts as on
 * screen from the first snapshot that holds it until the first that doesn't.
 * Every arrival is announced, so no visit goes unseen; a departure nobody
 * announced is stamped at the next snapshot instead, which only delays a
 * reclaim. The one early stamp is a cold switch's outgoing project: the active
 * pointer moves before the bridge that keeps its view painted is armed, so it
 * reads as gone up to one view-load timeout before it is.
 *
 * In memory only. A project nothing has seen counts as idle from the first
 * snapshot, taken as tracking starts during boot, so a restart grants every
 * background project a full threshold.
 */
export class ProjectVisibilityClock {
  private readonly lastSeen = new Map<string, number>();
  private onScreen = new Set<string>();
  private startedAt: number | null;

  constructor(
    private readonly now: () => number = () => Date.now(),
    startedAt?: number
  ) {
    this.startedAt = startedAt ?? null;
  }

  /** Record what is on screen right now; anything that dropped off left at this instant. */
  observe(visibleIds: Iterable<string>): void {
    const at = this.now();
    this.startedAt ??= at;
    const next = new Set(visibleIds);
    for (const id of this.onScreen) this.lastSeen.set(id, at);
    for (const id of next) this.lastSeen.set(id, at);
    this.onScreen = next;
  }

  /** When the project was last on screen — now, while it still is or before anything was seen. */
  lastVisibleAt(projectId: string): number {
    if (this.onScreen.has(projectId)) return this.now();
    return this.lastSeen.get(projectId) ?? this.startedAt ?? this.now();
  }
}

export const projectVisibilityClock = new ProjectVisibilityClock();

/**
 * Keep the clock current between idle sweeps: one snapshot now, then one on
 * every change to where projects are open. Without it a visit that starts and
 * ends between two sweeps is never seen at all.
 */
export function trackProjectVisibility(
  readVisible: () => Iterable<string>,
  clock: ProjectVisibilityClock = projectVisibilityClock
): () => void {
  const observe = () => clock.observe(readVisible());
  observe();
  return onProjectPresenceChanged(observe);
}
