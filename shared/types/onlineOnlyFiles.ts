import type { CloudSyncService } from "../utils/cloudSyncDetection.js";

/** What the last walk of one side of a project saw. Observations only: nothing here says what the provider is doing. */
export interface OnlineOnlyFilesSide {
  files: number;
  /** Folders still online-only. Looking inside one would download its listing, so what it holds is in no count. */
  directories: number;
  /**
   * False when the walk couldn't see everything: it hit its time limit, met an
   * unreadable folder, or (for `.git`) couldn't reach the repository's metadata
   * without a download. The counts are then only what it saw, and a zero says nothing.
   */
  complete: boolean;
  /** The project folder itself is online-only, so nothing inside it could be looked at. Only ever set on `git`. */
  rootOnlineOnly?: boolean;
}

/** A project's online-only files. `null` from a read means none of this applies to the project. */
export interface ProjectOnlineOnlyFiles {
  projectId: string;
  /** The provider whose folder holds the project, from its path alone. */
  service: CloudSyncService;
  /** Rises with every change, so a read that raced a newer push can be dropped. */
  revision: number;
  /** The repository's `.git`, split out because it is what git blocks on. `null` until first seen. */
  git: OnlineOnlyFilesSide | null;
  /** Everything else under the project folder. `null` until first seen. */
  workingTree: OnlineOnlyFilesSide | null;
}
