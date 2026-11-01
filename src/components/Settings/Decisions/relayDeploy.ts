import { usePanelStore } from "@/store/panelStore";
import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";
import { isWindows } from "@/lib/platform";
import { DECISIONS_DEPLOY_TERMINAL_PREFIX } from "@shared/config/terminalScreenPersistence";

/** Where the Decisions README's Deploy to Cloudflare button goes. */
export const DEPLOY_TO_CLOUDFLARE_URL =
  "https://deploy.workers.cloudflare.com/?url=https://github.com/daintreehq/decisions";

/**
 * The published CLI the guided deploy runs. Pinned, never `latest`: its
 * `deploy` uploads the relay of its own version, and the relay and the
 * libraries are released together, so it matches the protocol package this
 * build pins and the relay check expects.
 */
export const DECISIONS_CLI_VERSION = "0.1.0";

export const RELAY_DEPLOY_TERMINAL_TITLE = "Deploy Decisions relay";

/**
 * A Worker and bucket name no relay in the account is likely to have. The CLI
 * treats a Worker that already exists under its name as an update, and
 * Daintree never updates a deployed Worker, so a guided deploy never reuses a
 * name, not even the CLI's default.
 */
export function freshRelayName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `daintree-decisions-${suffix}`;
}

/**
 * What the pane runs, in full and in view. No token, account or claim flag:
 * Wrangler signs in through the browser, and the relay is claimed afterwards
 * in Settings, with this computer's own keys. On Windows it names npm's batch
 * shim, since PowerShell would otherwise pick `npx.ps1`, which its default
 * execution policy refuses to run.
 */
export function relayDeployCommand(name: string, windows: boolean): string {
  const npx = windows ? "npx.cmd" : "npx";
  return `${npx} --yes @daintreehq/decisions-cli@${DECISIONS_CLI_VERSION} deploy --name ${name} --bucket ${name}`;
}

export interface RelayDeployPlacement {
  /** The user's home folder: a project's own npm config has no say in what runs. */
  cwd: string;
  /** Where the pane shows, so it lands in the grid being looked at. */
  worktreeId: string | undefined;
}

/**
 * Opens a focused terminal running the guided deploy. Its id carries the
 * prefix that keeps its screen, and so the claim secret it prints, off disk.
 * Resolves the pane's id, or null when the panel limit refused it (which says
 * so itself).
 */
export async function openRelayDeployTerminal(
  placement: RelayDeployPlacement
): Promise<string | null> {
  const name = freshRelayName();
  try {
    return await usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: `${DECISIONS_DEPLOY_TERMINAL_PREFIX}${crypto.randomUUID()}`,
      title: RELAY_DEPLOY_TERMINAL_TITLE,
      titleMode: "custom",
      cwd: placement.cwd,
      worktreeId: placement.worktreeId,
      location: "grid",
      // Only a local window offers the guided deploy, so this machine is the PTY's.
      command: relayDeployCommand(name, isWindows()),
      focusPolicy: "take",
    });
  } catch (error) {
    logError("Failed to open the Decisions relay deploy terminal", error);
    notify({
      type: "error",
      priority: "high",
      title: "Couldn't open the deploy terminal",
      message: "The guided deploy didn't start. Deploy to Cloudflare in Settings works without it.",
      context: { eventKind: "settings" },
      action: {
        label: "Try again",
        onClick: () => void openRelayDeployTerminal(placement),
      },
    });
    return null;
  }
}
