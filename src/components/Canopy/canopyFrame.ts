import { createContext, use } from "react";
import type { CanopyAssistantItem } from "./canopyAssistants";
import type { placeOf } from "./canopyInboxPlace";
import type { CanopyTrashItem } from "./canopyTrash";

/** Where a run really is: a host of null is this renderer's own. */
export type CanopyRunPlace = ReturnType<typeof placeOf>;

/** What the inbox asks of its host when the user goes to a run's pane. */
export interface CanopyGoToRun {
  place: CanopyRunPlace;
  /** Cmd/Ctrl held: the user asked for the run in a new window. */
  newWindow: boolean;
}

/**
 * What hosts Canopy's inbox, and what only that host can decide: the Canopy
 * window, which holds no project and moves to none (#16581). Tests mount the
 * inbox with decisions of their own.
 */
export interface CanopyFrame {
  /** Null where a run's pane can't be reached from: the inbox offers no way to it. */
  goToRun: ((run: CanopyGoToRun) => void) | null;
  /** A trashed run its own project has to bring back. */
  restoreElsewhere: (item: CanopyTrashItem, place: CanopyRunPlace) => void;
  /** Resolves to why it couldn't, in words, or null once it did. */
  openAssistant: (item: CanopyAssistantItem, mounted: () => boolean) => Promise<string | null>;
  /**
   * When the live terminal takes the PTY's size: as a row is selected, or only
   * once the user works in it, in a window left open all day beside the
   * agent's own pane (#16339). Main holds this machine's runs to the window's
   * choice itself; this is the inbox's answer for a run on another host.
   */
  takesTerminalSize: "on-select" | "on-use";
}

/** Everything in the surface, header included. */
export const CANOPY_SURFACE = "[data-canopy-standalone]";

export const CanopyFrameContext = createContext<CanopyFrame | null>(null);

export function useCanopyFrame(): CanopyFrame {
  const frame = use(CanopyFrameContext);
  if (frame === null) throw new Error("Canopy's inbox mounted outside a frame");
  return frame;
}
