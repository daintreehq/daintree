import type { TourPlatform } from "@daintreehq/tour";
import { isMac, isWindows } from "@/lib/platform";

export const TOUR_PLATFORMS: readonly TourPlatform[] = ["darwin", "linux", "win32"];

export function currentTourPlatform(): TourPlatform {
  if (isMac()) return "darwin";
  return isWindows() ? "win32" : "linux";
}

/**
 * The chapters that play on a platform, in order. The player, the timings, the
 * invitation and saved progress all index this list, so every one of them must
 * be built from the same selection or a skipped chapter shifts the audio.
 */
export function playableChapters<T extends { platforms?: readonly TourPlatform[] }>(
  chapters: readonly T[],
  platform: TourPlatform
): T[] {
  return chapters.filter((chapter) => !chapter.platforms || chapter.platforms.includes(platform));
}
