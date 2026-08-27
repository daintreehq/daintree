import { Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { VersionTooOld } from "@/controllers/HelpSessionController";

interface HelpPanelVersionGateProps {
  versionTooOld: VersionTooOld;
  onOpenSettings: () => void;
  onCheckAgain: () => void;
  isCheckingVersion: boolean;
}

export function HelpPanelVersionGate({
  versionTooOld,
  onOpenSettings,
  onCheckAgain,
  isCheckingVersion,
}: HelpPanelVersionGateProps) {
  return (
    <div
      className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center"
      data-testid="help-version-too-old"
    >
      <p className="text-sm text-daintree-text/70">
        Update {versionTooOld.agentName} to use Daintree Assistant
      </p>
      <p className="text-xs text-daintree-text/50 max-w-[32ch]">
        Daintree Assistant needs {versionTooOld.agentName} {versionTooOld.requiredVersion} or later.
        You're on {versionTooOld.installedVersion}.
      </p>
      <button
        type="button"
        onClick={onOpenSettings}
        className={cn(
          "mt-1 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-md)]",
          "text-xs font-medium border border-daintree-border text-daintree-text/80",
          "hover:bg-overlay-soft hover:text-daintree-text transition-colors",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
        )}
      >
        <Settings2 className="w-3.5 h-3.5" />
        <span>Update {versionTooOld.agentName}</span>
      </button>
      <button
        type="button"
        onClick={onCheckAgain}
        disabled={isCheckingVersion}
        className={cn(
          "text-2xs text-daintree-text/40 transition-colors",
          "hover:text-daintree-text/60",
          "disabled:opacity-50 disabled:cursor-default disabled:hover:text-daintree-text/40",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
        )}
      >
        Check again
      </button>
    </div>
  );
}
