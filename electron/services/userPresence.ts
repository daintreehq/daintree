import { powerMonitor } from "electron";
import { getPowerPolicy } from "../window/powerPolicy.js";

/**
 * Whether someone is at the machine. `unknown` is its own answer, never folded
 * into either side: idle time is unreadable under some Wayland compositors, and
 * a guess there would either silence alerts for someone who walked off or page
 * someone who is sitting right there.
 */
export type UserPresence = "present" | "away" | "unknown";

export const AWAY_IDLE_THRESHOLD_SECONDS = 180;

/**
 * Read on demand rather than polled — `getSystemIdleState` is a cheap
 * synchronous OS query. There is deliberately no `getSystemIdleTime` fallback
 * for `unknown`: it answers 0 on Wayland, which would report everyone as active.
 */
export function readUserPresence(): UserPresence {
  // Event-driven on macOS and Windows, so it is exact the moment the screen
  // locks rather than after the idle threshold elapses.
  if (getPowerPolicy().screenLocked) return "away";

  let state: string;
  try {
    state = powerMonitor.getSystemIdleState(AWAY_IDLE_THRESHOLD_SECONDS);
  } catch {
    return "unknown";
  }

  switch (state) {
    case "active":
      return "present";
    case "idle":
    case "locked":
      return "away";
    default:
      return "unknown";
  }
}
