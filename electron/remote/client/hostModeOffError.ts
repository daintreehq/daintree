import type { HostId } from "../../../shared/types/remoteHosts.js";
import { AppError } from "../../utils/errorTypes.js";

/**
 * ssh reached the host and found no Daintree listening there, and the link
 * stopped trying. A host this machine has never heard from most likely isn't
 * set up yet. One it has heard from is set up already: its Daintree was quit,
 * or hasn't started since a reboot, and setting it up again is no answer.
 */
export function hostModeOff(hostName: string, everSeen: boolean): AppError {
  return new AppError({
    code: "HOST_MODE_OFF",
    message: `Daintree isn't running in Host mode on ${hostName}`,
    userMessage: everSeen
      ? `Daintree isn't listening on ${hostName}. Try again once it's running there.`
      : `Daintree isn't running in Host mode on ${hostName}. Set it up to work there.`,
  });
}

/**
 * The host stopped listening moments after it was last heard from and the
 * link is still trying, which is what a restart looks like: said as what was
 * seen, with trying again as the way on.
 */
export function hostRestarting(hostId: HostId, hostName: string): AppError {
  return new AppError({
    code: "HOST_DISCONNECTED",
    message: `Host ${hostId} did not connect (not listening since it was last heard from)`,
    userMessage: `Daintree on ${hostName} stopped listening moments ago and hasn't come back yet. If it's restarting, try again in a moment.`,
  });
}
