import { useContext } from "react";
import type { InstallTarget } from "@/services/terminal/installCommandLine";
import { logError } from "@/utils/logger";
import { InstallCommandHandoffContext } from "./installCommandHandoffContext";
import { useHomeTerminalPlacement } from "./useHomeTerminalPlacement";

export type InstallCommandRunner = (line: string, target: InstallTarget) => void;

/**
 * Opens an install command in a new terminal of this window's grid, typed but
 * not run. Null while there is no grid to open one in (no project or scratch)
 * or a dialog over it can't close, so a surface shows the command as copy-only.
 * The opener, with the panel store and terminal service it needs, loads on the
 * first click rather than with every surface that shows a command.
 */
export function useInstallCommandRunner(): InstallCommandRunner | null {
  const handoff = useContext(InstallCommandHandoffContext);
  const placement = useHomeTerminalPlacement();
  if (!placement.ready || handoff === null) return null;
  const { cwd, worktreeId } = placement;
  return (line, target) => {
    const open = () => {
      import("@/services/terminal/installCommandHandoff")
        .then(({ openInstallCommandInTerminal }) =>
          openInstallCommandInTerminal({ line, target, cwd, worktreeId })
        )
        .catch((error: unknown) => logError("Failed to open an install command", error));
    };
    if (handoff) handoff(open);
    else open();
  };
}
