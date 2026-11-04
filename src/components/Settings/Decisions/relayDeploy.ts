import { usePanelStore } from "@/store/panelStore";
import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";
import { isWindows } from "@/lib/platform";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { DECISIONS_DEPLOY_TERMINAL_PREFIX } from "@shared/config/terminalScreenPersistence";

/**
 * The published CLI the guided deploy runs. Pinned, never `latest`: its
 * `deploy` uploads the relay of its own version, and the relay and the
 * libraries are released together, so it matches the protocol package this
 * build pins and the relay check expects. 0.3.0 was the first to ask its setup
 * questions before changing anything (daintreehq/decisions#21) and to take
 * its defaults from, and hand its result to, a host app (daintreehq/decisions#22).
 */
export const DECISIONS_CLI_VERSION = "0.4.0";

export const RELAY_DEPLOY_TERMINAL_TITLE = "Deploy Decisions relay";

/**
 * A Worker and bucket name no relay in the account is likely to have. The CLI
 * treats a Worker that already exists under its name as an update, so the
 * name it suggests is never one an earlier deploy used, not even the CLI's
 * default. The person can still change it at the CLI's prompt.
 */
export function freshRelayName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `daintree-decisions-${suffix}`;
}

/**
 * What the pane runs, in full and in view. No token, account, claim flag or
 * key: Wrangler signs in through the browser, and the answers Daintree knows
 * and the result it gets back travel over the host channel, whose path is no
 * secret and is safe unquoted in any shell. On Windows it names npm's batch
 * shim, since PowerShell would otherwise pick `npx.ps1`, which its default
 * execution policy refuses to run.
 */
export function relayDeployCommand(name: string, windows: boolean, hostChannel: string): string {
  const npx = windows ? "npx.cmd" : "npx";
  return `${npx} --yes @daintreehq/decisions-cli@${DECISIONS_CLI_VERSION} deploy --name ${name} --bucket ${name} --host-channel ${hostChannel}`;
}

export interface RelayDeployPlacement {
  /** The user's home folder: a project's own npm config has no say in what runs. */
  cwd: string;
  /** Where the pane shows, so it lands in the grid being looked at. */
  worktreeId: string | undefined;
}

function cancelPrepared(deployId: string): void {
  window.electron.decisions.cancelRelayDeploy(deployId).catch(() => {});
}

/**
 * Opens main's channel for the deploy, then a focused terminal running the
 * guided deploy against it. Its id carries the prefix that keeps its screen
 * off disk. Resolves the pane's id, or null when it didn't open: the panel
 * limit refused it (which says so itself) or the channel couldn't be opened.
 */
export async function openRelayDeployTerminal(
  placement: RelayDeployPlacement
): Promise<string | null> {
  let deployId: string | null = null;
  try {
    const prepared = await window.electron.decisions.prepareRelayDeploy();
    deployId = prepared.id;
    const paneId = await usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: `${DECISIONS_DEPLOY_TERMINAL_PREFIX}${crypto.randomUUID()}`,
      title: RELAY_DEPLOY_TERMINAL_TITLE,
      titleMode: "custom",
      cwd: placement.cwd,
      worktreeId: placement.worktreeId,
      location: "grid",
      // Only a local window offers the guided deploy, so this machine is the PTY's.
      command: relayDeployCommand(freshRelayName(), isWindows(), prepared.hostChannel),
      focusPolicy: "take",
    });
    if (paneId === null) cancelPrepared(prepared.id);
    return paneId;
  } catch (error) {
    if (deployId !== null) cancelPrepared(deployId);
    logError("Failed to open the Decisions relay deploy terminal", error);
    notify({
      type: "error",
      priority: "high",
      title: "Couldn't open the deploy terminal",
      message: formatErrorMessage(error, "The guided deploy didn't start."),
      context: { eventKind: "settings" },
      action: {
        label: "Try again",
        onClick: () => void openRelayDeployTerminal(placement),
      },
    });
    return null;
  }
}
