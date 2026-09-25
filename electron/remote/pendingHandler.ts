import { AppError } from "../utils/errorTypes.js";

/**
 * Body of a Remote Hosts IPC op whose contract is frozen but whose
 * implementation has not landed. Throws a typed UNSUPPORTED error so a caller
 * sees a clear refusal instead of a hang.
 */
export function pendingRemoteHostsHandler(channel: string): never {
  throw new AppError({
    code: "UNSUPPORTED",
    message: `${channel} is not implemented yet`,
    userMessage: "This remote hosts feature isn't available yet.",
    context: { channel },
  });
}
