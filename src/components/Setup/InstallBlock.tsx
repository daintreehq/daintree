import type { AgentInstallBlock } from "@shared/config/agentRegistry";
import { extractInspectUrl } from "@/lib/agentInstall";
import { CopyableCommand } from "./CopyableCommand";

export { CopyableCommand };

export function InstallBlock({ block }: { block: AgentInstallBlock }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg/50 p-3">
      {block.label && (
        <div className="text-xs font-medium text-daintree-text/60 mb-2">{block.label}</div>
      )}
      {block.steps && block.steps.length > 0 && (
        <ol className="list-decimal list-inside text-xs text-daintree-text/60 space-y-1 mb-2">
          {block.steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      )}
      {block.commands && block.commands.length > 0 && (
        <div className="space-y-1.5">
          {block.commands.map((cmd) => (
            <CopyableCommand key={cmd} command={cmd} inspectUrl={extractInspectUrl(cmd)} />
          ))}
        </div>
      )}
      {block.notes && block.notes.length > 0 && (
        <div className="mt-2 text-[11px] text-daintree-text/40 space-y-0.5">
          {block.notes.map((note, i) => (
            <p key={i}>{note}</p>
          ))}
        </div>
      )}
    </div>
  );
}
