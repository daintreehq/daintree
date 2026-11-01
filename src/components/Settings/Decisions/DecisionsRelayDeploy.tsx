import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import type { SettingsTabClose } from "@/components/Settings/settingsTabClose";
import { actionService } from "@/services/ActionService";
import { useHomeDir } from "@/hooks/app/useHomeDir";
import { isRemoteWindow } from "@/hooks/useHostPlatform";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { selectViewProject, selectViewScratch } from "@/store/viewWorkspace";
import { DEPLOY_TO_CLOUDFLARE_URL, openRelayDeployTerminal } from "./relayDeploy";

interface DecisionsRelayDeployProps {
  disabled: boolean;
  /** Closes Settings, then runs what's handed to it; absent outside the dialog. */
  onClose?: SettingsTabClose;
  /** Cloudflare's page opened, so the address it ends with goes in next. */
  onDeployPageOpened: () => void;
}

/** Where a guided deploy's pane would go, or why it can't go anywhere this window shows. */
function useDeployPlacement():
  | { ready: true; cwd: string; worktreeId: string | undefined }
  | { ready: false; reason?: string } {
  const { homeDir } = useHomeDir();
  const hasProject = useProjectStore(
    (state) => selectViewProject(getViewWorkspaceId(), state) !== undefined
  );
  const hasScratch = useScratchStore(
    (state) => selectViewScratch(getViewWorkspaceId(), state) !== undefined
  );
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);

  // Its terminals run on the Host, where Wrangler's sign-in callback can't reach this browser.
  if (isRemoteWindow()) {
    return {
      ready: false,
      reason:
        "This window's terminals run on its Remote Host. Start it from a local project window, or use Deploy to Cloudflare.",
    };
  }
  if (!hasProject && !hasScratch) {
    return { ready: false, reason: "Open a project to watch the deploy in a terminal" };
  }
  // A project's grid shows one worktree's panes, so the pane waits until that's known.
  if (homeDir === undefined || (hasProject && activeWorktreeId === null)) return { ready: false };
  return { ready: true, cwd: homeDir, worktreeId: activeWorktreeId ?? undefined };
}

/**
 * "Don't have a relay yet?" (#16023): the two routes to a relay in the user's
 * own Cloudflare account. Cloudflare's page opens in the browser; the guided
 * deploy closes Settings and runs the published CLI in a pane the user
 * watches. Either way the relay is then checked and claimed above, with the
 * claim secret typed once into the claim form.
 */
export function DecisionsRelayDeploy({
  disabled,
  onClose,
  onDeployPageOpened,
}: DecisionsRelayDeployProps) {
  const placement = useDeployPlacement();
  const [pageOpened, setPageOpened] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const openDeployPage = () => {
    setPageError(null);
    actionService
      .dispatch("system.openExternal", { url: DEPLOY_TO_CLOUDFLARE_URL }, { source: "user" })
      .then(
        (result) => {
          if (result.ok) {
            setPageOpened(true);
            onDeployPageOpened();
          } else {
            setPageError(`Couldn't open Cloudflare's deploy page. ${result.error.message}`);
          }
        },
        () => setPageError("Couldn't open Cloudflare's deploy page")
      );
  };

  const startGuidedDeploy = () => {
    if (!placement.ready || starting) return;
    const { cwd, worktreeId } = placement;
    const open = () => void openRelayDeployTerminal({ cwd, worktreeId });
    if (!onClose) {
      open();
      return;
    }
    setStarting(true);
    // Settings goes first, so the pane is in view and keeps the focus it takes.
    onClose(open).then(
      (closed) => {
        if (!closed) setStarting(false);
      },
      () => setStarting(false)
    );
  };

  return (
    <SettingsGroup label="Don't have a relay yet?">
      <SettingsRow
        id="decisions-relay-deploy"
        label="Deploy one to your own Cloudflare account"
        description="Either way creates a Worker, its Durable Object and a private R2 bucket there. Cloudflare's free plan is enough for one person, though R2 needs a payment method on file."
      />
      <SettingsRow
        id="decisions-deploy-cloudflare"
        label="Deploy from Cloudflare's page"
        description="Opens Cloudflare's deploy page in your browser. It asks for one secret, CLAIM_SECRET: enter a long random string, such as the output of openssl rand -hex 32, and keep it to claim the relay here."
        error={pageError ?? undefined}
        disabled={disabled}
        control={({ descriptionId, disabled: rowDisabled }) => (
          <Button
            variant="outline"
            size="sm"
            disabled={rowDisabled}
            aria-describedby={descriptionId}
            onClick={openDeployPage}
          >
            Deploy to Cloudflare
          </Button>
        )}
      />
      {pageOpened && (
        <SettingsRow
          id="decisions-deploy-next"
          label="Then connect it here"
          description="When Cloudflare has deployed it, enter the Worker URL above and check it, then claim the relay with your CLAIM_SECRET."
        />
      )}
      <SettingsRow
        id="decisions-deploy-guided"
        label="Deploy from a terminal"
        description="Runs the published decisions deploy in a terminal you watch. It needs Node.js 22 or later, signs you in to Cloudflare in your browser, and shows the Worker URL and claim secret once. Daintree never sees a Cloudflare token and doesn't save what the terminal shows."
        disabled={disabled || !placement.ready || starting}
        disabledReason={placement.ready ? undefined : placement.reason}
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
    </SettingsGroup>
  );
}
