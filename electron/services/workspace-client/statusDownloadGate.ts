import { homedir } from "node:os";
import type { StatusDownloadGate } from "../../../shared/types/workspace-host.js";
import type { ProjectOnlineOnlyFiles } from "../../../shared/types/onlineOnlyFiles.js";
import { detectCloudSyncService } from "../../../shared/utils/cloudSyncDetection.js";
import { gitStatusWaitsForDownload } from "../../../shared/utils/onlineOnlyFiles.js";
import {
  getProjectOnlineOnlyService,
  type ProjectOnlineOnlyService,
} from "../ProjectOnlineOnlyService.js";

// The first `.git` verdict takes a 5s probe and a 15s walk, plus any wait behind
// another project's walk. Past this a project gets the status it would get
// without the gate, because a scan that can't answer must not cost it one.
const FIRST_VERDICT_DEADLINE_MS = 25_000;

/**
 * Closes `apply`'s gate for as long as `.git` holds online-only files, starting
 * at `pending` so a load's first status pass can't get ahead of the first walk.
 * Returns the release, or null for a project this can't apply to: those stay
 * `open`, and this check is all they pay.
 */
export function gateGitStatusOnDownload(
  root: string,
  projectId: string,
  apply: (gate: StatusDownloadGate) => void,
  getService: () => Pick<ProjectOnlineOnlyService, "observe"> = getProjectOnlineOnlyService
): (() => void) | null {
  // Only macOS flags placeholders.
  if (process.platform !== "darwin") return null;
  const service = detectCloudSyncService(root, homedir(), "mac");
  if (!service) return null;

  let deadline: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    deadline = null;
    apply("open");
  }, FIRST_VERDICT_DEADLINE_MS);
  deadline.unref?.();

  const report = (files: ProjectOnlineOnlyFiles): void => {
    if (files.git === null) return;
    if (deadline !== null) {
      clearTimeout(deadline);
      deadline = null;
    }
    apply(gitStatusWaitsForDownload(files) ? "held" : "open");
  };

  apply("pending");
  const { files, release } = getService().observe({ id: projectId, path: root, service }, report);
  report(files);

  return () => {
    if (deadline !== null) clearTimeout(deadline);
    deadline = null;
    release();
  };
}
