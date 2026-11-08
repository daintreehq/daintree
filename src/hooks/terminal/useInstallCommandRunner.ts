import { createContext, useContext } from "react";
import {
  openInstallCommandInTerminal,
  type InstallTarget,
} from "@/services/terminal/installCommandHandoff";
import { useHomeTerminalPlacement } from "./useHomeTerminalPlacement";

export type InstallCommandRunner = (line: string, target: InstallTarget) => void;

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

/**
 * Opens an install command in a new terminal of this window's grid, typed but
 * not run. Null while there is no grid to open one in (no project or scratch)
 * or a dialog over it can't close, so a surface shows the command as copy-only.
 */
export function useInstallCommandRunner(): InstallCommandRunner | null {
  const handoff = useContext(InstallCommandHandoffContext);
  const placement = useHomeTerminalPlacement();
  if (!placement.ready || handoff === null) return null;
  const { cwd, worktreeId } = placement;
  return (line, target) => {
    const open = () => void openInstallCommandInTerminal({ line, target, cwd, worktreeId });
    if (handoff) handoff(open);
    else open();
  };
}
