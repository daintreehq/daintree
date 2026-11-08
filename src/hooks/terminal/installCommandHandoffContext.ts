import { createContext } from "react";

/** Gets a dialog out of the way, then opens the terminal. */
export type InstallCommandHandoff = (open: () => void) => void;

/**
 * Set by a dialog that shows install commands, since a terminal opened behind
 * a modal can't be typed into. Unset where nothing covers the grid; null while
 * the dialog can't close (an install it runs is still going).
 */
export const InstallCommandHandoffContext = createContext<InstallCommandHandoff | null | undefined>(
  undefined
);
