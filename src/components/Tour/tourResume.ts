import type { TourOnboardingState } from "@shared/types";

/**
 * The chapter a reopened tour starts at. Progress resumes by chapter id, so
 * reordered chapters land where the user left off, and only while it was
 * recorded against the tour's current content version — a record from before
 * versioning counts as unversioned. A run finished under this version starts
 * over; a record holding only an index (written before ids were kept) resumes
 * by index while that chapter still exists.
 */
export function resumeChapter(
  progress: TourOnboardingState,
  chapters: readonly { id: string }[],
  version: string | undefined
): number {
  if (progress.contentVersion !== version) return 0;
  if (progress.completed && progress.completedVersion === version) return 0;
  if (progress.lastChapterId !== undefined) {
    return Math.max(
      0,
      chapters.findIndex((chapter) => chapter.id === progress.lastChapterId)
    );
  }
  return progress.lastChapter < chapters.length ? progress.lastChapter : 0;
}
