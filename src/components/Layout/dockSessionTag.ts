import { isPtyPanel, type DockPanelData } from "@shared/types/panel";
import { getTerminalDisplayTitle } from "@/utils/terminalTitleDisplay";

const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const TIME_SECONDS = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});
const DAY = new Intl.DateTimeFormat(undefined, { weekday: "short" });

/** "14:02" today, "Tue 14:02" before that; with seconds when minutes would collide. */
export function formatSessionStart(createdAt: number, now: number, withSeconds = false): string {
  const started = new Date(createdAt);
  const time = (withSeconds ? TIME_SECONDS : TIME).format(started);
  const today = new Date(now).toDateString() === started.toDateString();
  return today ? time : `${DAY.format(started)} ${time}`;
}

/**
 * When each session started, for the chips whose visible title another chip on
 * the rail shares — two "Claude" sessions with no task yet, say.
 *
 * A start time, not an ordinal: a "Claude 2" would silently name a different
 * session the moment a neighbour closed or the chips were reordered, while the
 * time a session started never changes and is something the user saw happen.
 * Chips with a title of their own get nothing, so the rail stays quiet until
 * there is a collision to resolve.
 */
export function dockSessionTags(
  panels: readonly DockPanelData[],
  showTask: boolean,
  now: number
): ReadonlyMap<string, string> {
  const byTitle = new Map<string, DockPanelData[]>();
  for (const panel of panels) {
    if (!isPtyPanel(panel)) continue;
    const title = getTerminalDisplayTitle(panel, "compact", { showTask });
    const shared = byTitle.get(title);
    if (shared) shared.push(panel);
    else byTitle.set(title, [panel]);
  }
  const tags = new Map<string, string>();
  for (const shared of byTitle.values()) {
    if (shared.length < 2) continue;
    const dated = shared.filter(
      (panel): panel is DockPanelData & { createdAt: number } => typeof panel.createdAt === "number"
    );
    // Two sessions started in the same minute would still read alike, so the
    // whole group drops to seconds rather than leaving a pair identical.
    const minutes = dated.map((panel) => formatSessionStart(panel.createdAt, now));
    const withSeconds = new Set(minutes).size < minutes.length;
    for (const panel of dated) {
      tags.set(panel.id, formatSessionStart(panel.createdAt, now, withSeconds));
    }
  }
  return tags;
}
