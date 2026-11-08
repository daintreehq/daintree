import type { OnlineOnlyFilesSide, ProjectOnlineOnlyFiles } from "@shared/types/onlineOnlyFiles";
import type { CloudSyncService } from "@shared/utils/cloudSyncDetection";
import { gitStatusWaitsForDownload, hasOnlineOnlyEntries } from "@shared/utils/onlineOnlyFiles";
import { pluralize } from "@/lib/pluralize";

export const WAITING_FOR_DOWNLOAD_LABEL = "Waiting for files to download";

/**
 * Each provider's own control for keeping a folder on the Mac, as its vendor
 * documents it. macOS has no supported way to ask for a folder's download
 * (`fileproviderctl materialize` went in macOS 14.4), so the notice points here
 * rather than offering a button of its own.
 */
const PROVIDER_DOWNLOAD_CONTROL: Record<CloudSyncService, string> = {
  Dropbox: "Make available offline",
  "iCloud Drive": "Download Now",
  OneDrive: "Always Keep on This Device",
  "Google Drive": "Available offline",
};

export interface OnlineOnlyFilesCopy {
  title: string;
  description: string;
}

function providerControlSentence(service: CloudSyncService, isRemote: boolean): string {
  const where = isRemote ? "Finder on the host" : "Finder";
  return `To download them now, right-click the project folder in ${where} and choose "${PROVIDER_DOWNLOAD_CONTROL[service]}".`;
}

/** "479 files and 3 folders", with "at least" when the walk couldn't see everything. */
function describeSide(side: OnlineOnlyFilesSide, qualifier: string): string {
  const counts = [
    side.files > 0 ? pluralize(side.files, `${qualifier}file`) : null,
    side.directories > 0 ? pluralize(side.directories, `${qualifier}folder`) : null,
  ].filter((count) => count !== null);
  return `${side.complete ? "" : "at least "}${counts.join(" and ")}`;
}

/**
 * What the notice says, or null when no walk has seen anything still online-only.
 * It reports what has and hasn't downloaded and never why, because nothing here
 * can tell whether the provider is syncing, paused or stuck. A side that hasn't
 * answered, or an incomplete zero, is simply left out.
 */
export function getOnlineOnlyFilesCopy(
  files: ProjectOnlineOnlyFiles,
  isRemote = false
): OnlineOnlyFilesCopy | null {
  const { git, service, workingTree } = files;
  const title = "Some files aren't downloaded yet";

  if (git?.rootOnlineOnly) {
    return {
      title,
      description: `${service} hasn't downloaded this project's folder yet. Git status is waiting for it. ${providerControlSentence(service, isRemote)}`,
    };
  }

  const seen = [
    git && hasOnlineOnlyEntries(git) ? `${describeSide(git, "")} in .git` : null,
    workingTree && hasOnlineOnlyEntries(workingTree) ? describeSide(workingTree, "project ") : null,
  ].filter((part) => part !== null);
  if (seen.length === 0) return null;

  const waiting = gitStatusWaitsForDownload(files) ? " Git status is waiting for them." : "";
  // Each side can already hold an "and", so a second one would blur where they split.
  const joined = seen.join(seen.some((part) => part.includes(" and ")) ? ", and " : " and ");
  return {
    title,
    description: `${service} hasn't downloaded ${joined} yet.${waiting} ${providerControlSentence(service, isRemote)}`,
  };
}

/**
 * The inbox's record of a notice. It outlives the counts and can't be updated as
 * they change, so it says what was seen and leaves the live numbers to the banner.
 */
export function getOnlineOnlyFilesInboxCopy(
  service: CloudSyncService,
  isRemote = false
): OnlineOnlyFilesCopy {
  return {
    title: "Some files weren't downloaded",
    description: `Some of this project's files were still online-only in your ${service} folder. ${providerControlSentence(service, isRemote)}`,
  };
}
