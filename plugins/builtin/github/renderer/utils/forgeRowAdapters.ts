import type { CIStatusState } from "@shared/types/forge";
import type { GitHubPRCIStatus } from "../../shared/types.js";

/**
 * Normalized forge CI roll-up → the GitHub-flavored enum the plugin's
 * `prCIStatus` visual helpers consume. `neutral`/`unknown` collapse to
 * `undefined` ("no checks"), matching the row badge's vocabulary.
 */
export function toGitHubCIStatus(status: CIStatusState | undefined): GitHubPRCIStatus | undefined {
  switch (status) {
    case "success":
      return "SUCCESS";
    case "failure":
      return "FAILURE";
    case "pending":
      return "PENDING";
    default:
      return undefined;
  }
}
