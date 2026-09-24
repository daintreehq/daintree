import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw, Settings2 } from "lucide-react";
import { CircleArrowUp } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { CopyableCommand } from "@/components/Setup/CopyableCommand";
import { systemClient } from "@/clients/systemClient";
import { getAgentConfig } from "@/config/agents";
import { extractInspectUrl, isManualOnlyCommand } from "@/lib/agentInstall";
import { isWindows } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import type { VersionTooOld } from "@/controllers/HelpSessionController";

interface HelpPanelVersionGateProps {
  versionTooOld: VersionTooOld;
  onOpenSettings: () => void;
  onCheckAgain: () => void;
  isCheckingVersion: boolean;
}

const METHOD_LABELS: Record<string, string> = {
  npm: "npm",
  brew: "Homebrew",
  curl: "Install script",
  pypi: "pip",
  pip: "pip",
  pipx: "pipx",
  go: "Go",
};

interface UpdateMethod {
  label: string;
  command: string;
}

/**
 * The registry's update commands for this agent, minus the ones that cannot run on
 * this platform. Nothing here detects HOW the CLI was installed, so every method is
 * shown under its own label and the copy asks for the user's existing one — picking
 * npm for a Homebrew install would leave two copies on PATH and the old one winning.
 */
function updateMethods(agentId: string): UpdateMethod[] {
  const update = getAgentConfig(agentId)?.update;
  if (!update) return [];
  const windows = isWindows();
  return Object.entries(update)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .filter(
      ([method, command]) => !(windows && (method === "brew" || isManualOnlyCommand(command)))
    )
    .map(([method, command]) => ({ label: METHOD_LABELS[method] ?? method, command }));
}

export function HelpPanelVersionGate({
  versionTooOld,
  onOpenSettings,
  onCheckAgain,
  isCheckingVersion,
}: HelpPanelVersionGateProps) {
  const { agentId, agentName, installedVersion, requiredVersion } = versionTooOld;
  const methods = updateMethods(agentId);
  const docsUrl = getAgentConfig(agentId)?.install?.docsUrl;

  // A check that settles with the gate still up found nothing newer. Derived from
  // the falling edge during render (not an effect) so the result lands in the same
  // commit that clears the busy state.
  const [wasChecking, setWasChecking] = useState(isCheckingVersion);
  const [checkedWithoutChange, setCheckedWithoutChange] = useState(false);
  if (wasChecking !== isCheckingVersion) {
    setWasChecking(isCheckingVersion);
    setCheckedWithoutChange(wasChecking && !isCheckingVersion);
  }

  // The gate replaces a launch whose last word to AT was "Checking version…", so it
  // has to say what stopped the launch. Once per block, through the app announcer,
  // and without taking focus from wherever the user is.
  useEffect(() => {
    useAnnouncerStore
      .getState()
      .announce(
        `Update ${agentName} to use Daintree Assistant. Version ${installedVersion} is installed; version ${requiredVersion} or later is required.`
      );
  }, [agentName, installedVersion, requiredVersion]);

  // Always conditional on the install method, even with one command listed: the
  // registry cannot see a native or package-manager install it has no command for,
  // and an unqualified "run this" would update a copy that is not the one on PATH.
  const instruction =
    methods.length === 0
      ? `Update ${agentName} the way you installed it, then check again.`
      : "Update it the way you installed it, then check again.";

  // Says what is known, not what was concluded. A still-blocked result means the
  // last version detected is still short — not that no newer release exists, and
  // not necessarily a fresh reading (a failed probe keeps the previous block).
  const status = isCheckingVersion
    ? `Checking ${agentName} version…`
    : checkedWithoutChange
      ? `Last detected version ${installedVersion}`
      : "";

  return (
    // Same scroll-safe centring as `MissingCliGate`: `my-auto` on the child rather
    // than `justify-center` on the scrollport, so a tall command list in a short pane
    // degrades to top alignment instead of clipping its heading above the scroll origin.
    <div
      className="flex-1 min-h-0 flex flex-col items-center overflow-auto"
      data-testid="help-version-too-old"
    >
      <div className="my-auto w-full max-w-sm space-y-4 px-6 py-8">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 shrink-0 rounded-[var(--radius-md)] bg-overlay-subtle border border-border-default flex items-center justify-center">
            <CircleArrowUp className="w-4 h-4 text-text-secondary" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-text-primary">Update {agentName}</h2>
            <p className="text-xs text-text-secondary">
              Daintree Assistant needs version {requiredVersion} or later
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-xs text-text-secondary">
            Version {installedVersion} is installed. {instruction}
          </p>
          {methods.map((method) => (
            <div key={method.label} className="space-y-1">
              <p className="text-xs font-medium text-text-secondary">{method.label}</p>
              <CopyableCommand
                command={method.command}
                inspectUrl={extractInspectUrl(method.command)}
                wrap
              />
            </div>
          ))}
          {/* The registry only knows some install routes. Someone who used another
              one gets the agent's own docs rather than a dead end. */}
          {docsUrl && (
            <button
              type="button"
              onClick={() => void systemClient.openExternal(docsUrl)}
              className="inline-flex items-center gap-1 text-xs text-text-secondary underline underline-offset-2 hover:text-text-primary transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2 rounded-[var(--radius-sm)]"
            >
              Installed another way? {agentName} docs
              <ExternalLink className="w-3 h-3" aria-hidden="true" />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button size="sm" variant="ghost" onClick={onOpenSettings}>
            <Settings2 aria-hidden="true" />
            Assistant settings
          </Button>
          {/* `aria-disabled`, not `disabled`: a disabled button drops focus to <body>
              the instant it is pressed from the keyboard, which is exactly when the
              user is waiting on it. The controller already ignores repeat presses. */}
          <Button
            size="sm"
            variant="outline"
            className={cn("ml-auto", isCheckingVersion && "cursor-default")}
            aria-disabled={isCheckingVersion || undefined}
            onClick={() => {
              if (!isCheckingVersion) onCheckAgain();
            }}
          >
            <SpinningIcon icon={RefreshCw} active={isCheckingVersion} size={14} />
            Check again
          </Button>
        </div>

        {/* Its line is reserved even while empty, so a check starting or settling
            never re-centres the block under the pointer that just pressed it. */}
        <p role="status" className="min-h-4 text-xs text-text-secondary">
          {status}
        </p>
      </div>
    </div>
  );
}
