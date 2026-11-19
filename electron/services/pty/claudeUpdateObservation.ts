import type { UpdateInstalledObservation } from "../../../shared/types/ipc/agent.js";
import { events } from "../events.js";
import type { ClaudeUpdateFooter } from "./ClaudeUpdateFooter.js";
import type { TerminalInfo } from "./types.js";

/**
 * How long Claude Code's update footer must have been off screen before its
 * return is a new sighting (#17905), as for the rate-limit and usage messages.
 */
export const UPDATE_FOOTER_REAPPEAR_MS = 60_000;

export interface UpdateFooterSighting {
  /** The footer was on screen in the last frame read. */
  visible: boolean;
  /** The first frame it was missing from since it was last on screen. */
  absentSince: number | null;
  /**
   * Set when an observation is cleared: a footer the ended run left on screen
   * isn't the next run's, so one counts again only after a frame without it.
   */
  fenced: boolean;
  /** The Claude process the last detection pass named behind the pane. */
  pid?: number;
}

function sightingOf(terminal: TerminalInfo): UpdateFooterSighting {
  return (terminal.updateFooterSighting ??= { visible: false, absentSince: null, fenced: false });
}

function publish(
  terminal: TerminalInfo,
  updateInstalled: UpdateInstalledObservation | null,
  now: number
): void {
  events.emit("agent:update-installed-changed", {
    terminalId: terminal.id,
    updateInstalled,
    timestamp: now,
  });
}

/**
 * Take one frame of a live Claude Code pane: `footer` is what it showed, null
 * when the footer wasn't on screen. An observation is made when the footer
 * shows, when what it says about `/restart` changes, and when it comes back
 * after {@link UPDATE_FOOTER_REAPPEAR_MS} off screen; a frame without it
 * changes nothing the pane reports.
 */
export function noteUpdateFooter(
  terminal: TerminalInfo,
  footer: ClaudeUpdateFooter | null,
  now: number
): void {
  const sighting = sightingOf(terminal);
  if (footer === null) {
    // Measured from the first frame without it: a footer that sat unchanged
    // through hours of quiet and blinks out for one repaint hasn't been away.
    if (sighting.visible) sighting.absentSince = now;
    sighting.visible = false;
    sighting.fenced = false;
    return;
  }
  if (sighting.fenced) return;
  const current = terminal.updateInstalled;
  const fresh =
    current === undefined ||
    current.namesRestart !== footer.namesRestart ||
    (!sighting.visible &&
      sighting.absentSince !== null &&
      now - sighting.absentSince >= UPDATE_FOOTER_REAPPEAR_MS);
  sighting.visible = true;
  sighting.absentSince = null;
  if (!fresh) return;
  terminal.updateInstalled = { observedAt: now, namesRestart: footer.namesRestart };
  publish(terminal, terminal.updateInstalled, now);
}

/**
 * Forget the observation: the run that showed the footer ended or changed.
 * Cheap to call on every frame of a pane that isn't a live Claude Code run.
 * With nothing observed there is nothing to fence: a pane whose detection
 * caught up after Claude drew the footer reads it on its next frame.
 */
export function clearUpdateInstalled(terminal: TerminalInfo, now: number): void {
  if (terminal.updateInstalled === undefined) return;
  const sighting = sightingOf(terminal);
  sighting.visible = false;
  sighting.absentSince = null;
  sighting.fenced = true;
  // The run is over, so its process with it: the next run's first pass names its own.
  sighting.pid = undefined;
  terminal.updateInstalled = undefined;
  publish(terminal, null, now);
}

/**
 * A detection pass named the Claude process behind the pane. One that differs
 * from the last means Claude was replaced without the pane ever showing a
 * shell: a new run, so an observation the old process made goes. Tracked
 * whether or not anything is observed, so a footer drawn between two passes
 * is held against the process that was there before it.
 */
export function noteUpdateFooterProcess(terminal: TerminalInfo, pid: number, now: number): void {
  const sighting = sightingOf(terminal);
  if (sighting.pid !== undefined && sighting.pid !== pid) clearUpdateInstalled(terminal, now);
  sighting.pid = pid;
}
