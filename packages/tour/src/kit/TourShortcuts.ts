import { createContext, useContext } from "react";

/** The two keyboards a tour is voiced for; Windows and Linux name their keys alike. */
export type TourKeyboard = "mac" | "pc";

/**
 * How the host draws a shortcut the narration names. Scenes pass the host's
 * own token for it (an action id, or a literal combo) and never format keys
 * themselves, so a mock and the real app can't disagree.
 */
export interface TourShortcuts {
  keyboard: TourKeyboard;
  /** One keycap per key of a single-step shortcut: ["⌘", "K"]. */
  keycaps(shortcut: string): readonly string[];
  /** A menu row's hint: "⌘⇧P" on a Mac, "Ctrl+Shift+P" elsewhere. */
  hint(shortcut: string): string;
}

/** Without a host, a shortcut is drawn as it was named. */
export const PLAIN_TOUR_SHORTCUTS: TourShortcuts = {
  keyboard: "pc",
  keycaps: (shortcut) => shortcut.split("+"),
  hint: (shortcut) => shortcut,
};

export const TourShortcutsContext = createContext<TourShortcuts>(PLAIN_TOUR_SHORTCUTS);

export function useTourShortcuts(): TourShortcuts {
  return useContext(TourShortcutsContext);
}
