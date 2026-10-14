import { AppError } from "../../utils/errorTypes.js";
import { sshRefusalLine } from "../../../shared/utils/sshRefusal.js";

/**
 * ssh reached the host and couldn't log in. Said in ssh's own words, at once:
 * the link has stopped retrying, so waiting out the connect timeout would
 * only end in "unreachable", which it isn't.
 */
export function sshAccessDenied(hostName: string, stderr: string | null | undefined): AppError {
  const said = sshRefusalLine(stderr);
  return new AppError({
    code: "HOST_SSH_ACCESS_DENIED",
    message: `ssh couldn't log in to ${hostName}`,
    userMessage: said
      ? `ssh couldn't log in to ${hostName}: ${said}.`
      : `ssh couldn't log in to ${hostName}. Check its key and host key in Settings.`,
  });
}
