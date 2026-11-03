import { usePanelStore } from "@/store/panelStore";
import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";
import { isWindows } from "@/lib/platform";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { DECISIONS_REMOVE_TERMINAL_PREFIX } from "@shared/config/terminalScreenPersistence";
import { isRemovableRelayOrigin } from "@shared/config/decisionsRelayRemoval";

/**
 * The published CLI the guided removal runs. Pinned apart from the deploy's
 * `DECISIONS_CLI_VERSION`: `remove` first shipped in 0.3.0, and it uploads no
 * relay, so its version has nothing to match in the libraries this build pins.
 */
export const DECISIONS_REMOVE_CLI_VERSION = "0.3.0";

export const RELAY_REMOVE_TERMINAL_TITLE = "Remove Decisions relay";

/**
 * What the pane runs. The origin is the only thing from outside, and only one
 * `isRemovableRelayOrigin` accepts, which nothing in it means anything to a
 * shell. `--yes` is npx's consent to install the CLI; the removal asks for its
 * own confirmations at the terminal, which nothing here answers. On Windows it
 * names npm's batch shim, as the deploy does.
 */
export function relayRemoveCommand(origin: string, windows: boolean): string {
  if (!isRemovableRelayOrigin(origin)) {
    throw new Error(`${origin} isn't a relay address the removal can take`);
  }
  const npx = windows ? "npx.cmd" : "npx";
  return `${npx} --yes @daintreehq/decisions-cli@${DECISIONS_REMOVE_CLI_VERSION} remove ${origin}`;
}

export interface RelayRemovePlacement {
  /** The user's home folder: a project's own npm config has no say in what runs. */
  cwd: string;
  /** Where the pane shows, so it lands in the grid being looked at. */
  worktreeId: string | undefined;
}

export interface RelayRemoveRequest {
  origin: string;
  /** Also delete this computer's decision history once the removal exits 0. */
  deleteLocalHistory: boolean;
}

function notifyNotStarted(message: string, retry: () => void): void {
  notify({
    type: "error",
    priority: "high",
    title: "Couldn't start the relay removal",
    message: `${message} Nothing was removed.`,
    context: { eventKind: "settings" },
    action: { label: "Try again", onClick: retry },
  });
}

/**
 * Opens a focused terminal running the guided removal (#16202). Main watches
 * the pane's id before it exists, so it sees how the removal ends and forgets
 * the relay only on an exit with status 0. The pane keeps its screen after the
 * command ends, since that's where the CLI says what was removed and what's
 * left. Resolves the pane's id, or null when nothing started (which says so).
 */
export async function openRelayRemoveTerminal(
  request: RelayRemoveRequest,
  placement: RelayRemovePlacement
): Promise<string | null> {
  const retry = () => void openRelayRemoveTerminal(request, placement);
  const terminalId = `${DECISIONS_REMOVE_TERMINAL_PREFIX}${crypto.randomUUID()}`;
  let command: string;
  try {
    command = relayRemoveCommand(request.origin, isWindows());
    await window.electron.decisions.startRelayRemoval({
      terminalId,
      origin: request.origin,
      deleteLocalHistory: request.deleteLocalHistory,
    });
  } catch (error) {
    logError("Failed to start watching a Decisions relay removal", error);
    notifyNotStarted(formatErrorMessage(error, "Daintree couldn't watch the removal."), retry);
    return null;
  }
  try {
    return await usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: terminalId,
      title: RELAY_REMOVE_TERMINAL_TITLE,
      titleMode: "custom",
      cwd: placement.cwd,
      worktreeId: placement.worktreeId,
      location: "grid",
      // Only a local window offers the removal, so this machine is the PTY's.
      command,
      // A plain terminal that exits 0 goes to the trash; this one keeps the CLI's report.
      exitBehavior: "keep",
      focusPolicy: "take",
    });
  } catch (error) {
    logError("Failed to open the Decisions relay removal terminal", error);
    notifyNotStarted("The removal terminal didn't open.", retry);
    return null;
  }
}
