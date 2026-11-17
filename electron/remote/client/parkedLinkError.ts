import type { HostConnectionBlocker } from "../../../shared/types/remoteHosts.js";
import { AppError } from "../../utils/errorTypes.js";
import { sshAccessDenied } from "./sshAccessError.js";

/**
 * Why a host whose link stopped retrying can't be used, in the words of what
 * stopped it (Host mode off is answered before this). Only an ssh refusal is
 * said as one: a WSL host never ran ssh.
 */
export function parkedLinkError(
  hostName: string,
  blocker: HostConnectionBlocker | undefined,
  detail: string | null
): AppError {
  switch (blocker?.kind) {
    case "ssh-access":
      return sshAccessDenied(hostName, detail);
    case "wsl-distro-missing":
      return new AppError({
        code: "HOST_CONNECTION_UNUSABLE",
        message: `WSL has no distribution named ${blocker.distro}`,
        userMessage: `WSL couldn't find ${blocker.distro}. Restore it under that name, then try again.`,
      });
    case "unusable":
      return new AppError({
        code: "HOST_CONNECTION_UNUSABLE",
        message: `${hostName} can't be reached as set up`,
        userMessage: `Couldn't connect to ${hostName}. ${sentence(blocker.message)}`,
      });
    default:
      return new AppError({
        code: "HOST_CONNECTION_UNUSABLE",
        message: `${hostName} stopped retrying`,
        userMessage: `Couldn't connect to ${hostName}, and automatic retries have stopped.`,
      });
  }
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}
