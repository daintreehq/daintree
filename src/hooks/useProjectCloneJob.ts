import { useEffect, useState } from "react";
import { projectClient } from "@/clients";
import type { ProjectCloneJobSnapshot } from "@shared/types/ipc/projectClone";

/**
 * The live state of a project's background clone (#16352), as main holds it.
 * Subscribes before asking, so an update that lands while the first answer is
 * in flight is never lost, and keeps whichever of the two is newer: switching
 * away and back, or a view reloaded mid-clone, shows the clone where it is
 * now. `null` until main has answered, and for a project with no clone.
 */
export function useProjectCloneJob(projectId: string | null): ProjectCloneJobSnapshot | null {
  const [latest, setLatest] = useState<ProjectCloneJobSnapshot | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let disposed = false;
    let latestSequence = -1;

    const accept = (next: ProjectCloneJobSnapshot | null): void => {
      if (disposed || !next || next.projectId !== projectId) return;
      if (next.sequence < latestSequence) return;
      latestSequence = next.sequence;
      setLatest(next);
    };

    const unsubscribe = projectClient.onCloneJobUpdated(accept);
    projectClient
      .getCloneJob(projectId)
      .then(accept)
      .catch(() => {
        // The view keeps the project's own clone state; the next update fills in.
      });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [projectId]);

  // Keyed by project, so a view that moves to another project never shows the
  // previous one's clone while the new answer is on its way.
  return latest !== null && latest.projectId === projectId ? latest : null;
}
