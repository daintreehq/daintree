import { SquareTerminal } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useInstallCommandRunner } from "@/hooks/terminal/useInstallCommandRunner";
import { detectOS, extractInspectUrl } from "@/lib/agentInstall";
import {
  installLineForCommands,
  isStageableInstallLine,
  type InstallTarget,
} from "@/services/terminal/installCommandLine";
import { CopyableCommand } from "./CopyableCommand";

/**
 * An install block's commands, each copyable, and each openable in a new
 * terminal where this window has a grid. A POSIX block of several steps opens
 * as one `&&` line in one terminal, so a sudo password is asked once; a Windows
 * one offers its steps one by one, in order.
 */
export function InstallCommandRows({
  commands,
  target,
  wrap,
  inspect = true,
}: {
  commands: readonly string[];
  target: InstallTarget;
  wrap?: boolean;
  /** Offer the inspect link for a command that pipes a downloaded script. */
  inspect?: boolean;
}) {
  const run = useInstallCommandRunner();
  const joined = run && commands.length > 1 ? installLineForCommands(commands, detectOS()) : null;

  return (
    <>
      {commands.map((command) => (
        <CopyableCommand
          key={command}
          command={command}
          wrap={wrap}
          inspectUrl={inspect ? extractInspectUrl(command) : undefined}
          onOpenInTerminal={
            run && !joined && isStageableInstallLine(command)
              ? () => run(command.trim(), target)
              : undefined
          }
        />
      ))}
      {run && joined && (
        <Button
          variant="ghost"
          size="xs"
          className="justify-self-start"
          onClick={() => run(joined, target)}
        >
          <SquareTerminal aria-hidden="true" />
          Open all in a terminal
        </Button>
      )}
    </>
  );
}
