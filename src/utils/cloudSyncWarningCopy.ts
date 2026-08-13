import type { CloudSyncService } from "@/utils/cloudSyncDetection";

export interface CloudSyncWarningCopy {
  title: string;
  description: string;
}

/**
 * Copy for the cloud-sync warning, shared by the banner and the inbox entry so
 * the two surfaces can't drift apart.
 *
 * `detectCloudSyncService` only matches the project path against known
 * cloud-folder name prefixes — it never establishes that sync is running. The
 * wording asserts the location (which the match does establish) and hedges the
 * sync (which it doesn't): Windows redirects Documents into OneDrive by
 * default, so the match fires whether or not sync is paused, unlinked, or
 * switched off.
 *
 * "your ${service} folder" also keeps the sentence article-free — "a iCloud
 * Drive folder" would be wrong, and the roots are all under the home dir.
 */
export function getCloudSyncWarningCopy(service: CloudSyncService): CloudSyncWarningCopy {
  return {
    title: "Project in a cloud folder",
    description: `This project is inside your ${service} folder, which may be syncing. That can interfere with terminal operations and git, so consider moving it to a local folder.`,
  };
}
