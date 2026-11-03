import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import type { SettingsTabClose } from "@/components/Settings/settingsTabClose";
import { SeverityMark } from "@/lib/statusSeverity";
import { useHomeDir } from "@/hooks/app/useHomeDir";
import { isRemoteWindow } from "@/hooks/useHostPlatform";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { selectViewProject, selectViewScratch } from "@/store/viewWorkspace";
import type { DecisionsRelayDeploy as RelayDeployState } from "@shared/types/decisions";
import { openRelayDeployTerminal } from "./relayDeploy";
import { describeRelayDeploy } from "./relayDeployCopy";

interface DecisionsRelayDeployProps {
  disabled: boolean;
  /** Closes Settings, then runs what's handed to it; absent outside the dialog. */
  onClose?: SettingsTabClose;
  /** The guided deploy this session started, as main reports it. */
  deploy?: RelayDeployState;
  /** Puts the deployed relay's URL in the field above and checks it. */
  onUseRelay: (url: string) => void;
}

/** Where a guided deploy's pane would go, or why it can't go anywhere this window shows. */
function useDeployPlacement():
  { ready: true; cwd: string; worktreeId: string | undefined } | { ready: false; reason?: string } {
  const { homeDir } = useHomeDir();
  const hasProject = useProjectStore(
    (state) => selectViewProject(getViewWorkspaceId(), state) !== undefined
  );
  const hasScratch = useScratchStore(
    (state) => selectViewScratch(getViewWorkspaceId(), state) !== undefined
  );
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);

  // Its terminals run on the Host, which can't reach the channel Daintree opens here.
  if (isRemoteWindow()) {
    return {
      ready: false,
      reason:
        "This window's terminals run on its Remote Host. Run the guided deploy from Settings → Decisions in a local project window",
    };
  }
  if (!hasProject && !hasScratch) {
    return {
      ready: false,
      reason:
        "It runs in a terminal in this window. Open a project or a scratch here first, then start it",
    };
  }
  // A project's grid shows one worktree's panes, so the pane waits until that's known.
  if (homeDir === undefined || (hasProject && activeWorktreeId === null)) return { ready: false };
  return { ready: true, cwd: homeDir, worktreeId: activeWorktreeId ?? undefined };
}

/**
 * "Don't have a relay yet?" (#16023, #16199): the guided deploy, the one route
 * to a relay in the user's own Cloudflare account. It closes Settings and runs
 * the published CLI in a pane the user watches, its answers prefilled from the
 * voice settings over a channel main holds, and what the CLI reports back
 * shows here, so the relay it created can be checked and claimed above with
 * the claim secret main received.
 */
export function DecisionsRelayDeploy({
  disabled,
  onClose,
  deploy,
  onUseRelay,
}: DecisionsRelayDeployProps) {
  const placement = useDeployPlacement();
  const [starting, setStarting] = useState(false);
  const running = deploy?.state === "running";
  const outcome = deploy ? describeRelayDeploy(deploy) : null;

  const startGuidedDeploy = () => {
    if (!placement.ready || starting || running) return;
    const { cwd, worktreeId } = placement;
    const open = () => void openRelayDeployTerminal({ cwd, worktreeId });
    if (!onClose) {
      open();
      return;
    }
    setStarting(true);
    // Settings goes first, so the pane is in view and keeps the focus it takes.
    // Reopened before it had gone, it starts nothing and can be asked again.
    onClose((closed) => (closed ? open() : setStarting(false))).then(
      (closing) => {
        if (!closing) setStarting(false);
      },
      () => setStarting(false)
    );
  };

  return (
    <SettingsGroup label="Don't have a relay yet?">
      <SettingsRow
        id="decisions-relay-deploy"
        label="Deploy one to your own Cloudflare account"
        description="It creates a Worker (the relay, its Durable Object and the phone app) and a private R2 bucket there. Cloudflare's free plan is enough for one person, though R2 needs a payment method on file."
      />
      <SettingsRow
        id="decisions-deploy-guided"
        label="Guided deploy"
        description="Runs the published decisions deploy in a terminal you watch. It signs you in to Cloudflare in your browser, then asks for the Worker and bucket names and whether to turn on dictation transcription (xAI or OpenAI) and transcript cleanup (Anthropic or OpenAI), with their API keys. Your voice settings fill in the answers, a key Daintree holds shows only as present, and you can change any of them. Nothing is created until you confirm the summary. Needs Node.js 22 or later."
        disabled={disabled || !placement.ready || starting || running}
        disabledReason={
          !placement.ready
            ? placement.reason
            : running
              ? "A guided deploy is running. Finish or close its terminal to start another"
              : undefined
        }
        control={({ descriptionId, disabled: rowDisabled }) => (
          <Button
            variant="outline"
            size="sm"
            loading={starting}
            disabled={rowDisabled}
            aria-describedby={descriptionId}
            onClick={startGuidedDeploy}
          >
            Guided deploy
          </Button>
        )}
      />
      {outcome && (
        <SettingsRow
          id="decisions-deploy-outcome"
          label={outcome.label}
          accessory={
            outcome.severity ? (
              <SeverityMark
                severity={outcome.severity}
                label={outcome.label}
                className="h-3.5 w-3.5"
                decorative
              />
            ) : undefined
          }
          description={outcome.detail}
          disabled={disabled}
          control={
            outcome.url !== undefined
              ? ({ descriptionId, disabled: rowDisabled }) => (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={rowDisabled}
                    aria-describedby={descriptionId}
                    onClick={() => {
                      if (outcome.url !== undefined) onUseRelay(outcome.url);
                    }}
                  >
                    Use this relay
                  </Button>
                )
              : undefined
          }
        />
      )}
    </SettingsGroup>
  );
}
