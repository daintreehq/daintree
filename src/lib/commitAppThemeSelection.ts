import { injectSchemeToDOM, resolveCommittedScheme, useAppThemeStore } from "@/store/appThemeStore";
import { logError } from "@/utils/logger";
import { notify } from "@/lib/notify";
import { appThemeClient } from "@/clients/appThemeClient";
import { runThemeReveal } from "@/lib/appThemeViewTransition";

let themeCommitEpoch = 0;

/**
 * Apply a theme the user chose, then save it. The picker (browser or palette) has already
 * closed by the time a write settles, so this lives outside the component and a
 * failure reports through a toast whose Retry outlives it.
 *
 * Turning system matching off and saving the scheme are separate durable writes:
 * if either fails, every field goes back to what is on disk, so the theme on
 * screen is the one the app boots with. The recent-themes list only feeds the
 * browser's ordering, so failing to save it stays out of the user's way.
 */
export async function commitAppThemeSelection(
  targetId: string,
  origin: { x: number; y: number } | null,
  options: { reveal?: boolean } = {}
): Promise<void> {
  const epoch = ++themeCommitEpoch;
  const before = useAppThemeStore.getState();
  const previous = {
    selectedSchemeId: before.selectedSchemeId,
    recentSchemeIds: before.recentSchemeIds,
    followSystem: before.followSystem,
  };
  let followSystemOffOnDisk = false;

  // Clear preview state BEFORE the View Transition fires. Otherwise the
  // mutation callback would still see `previewSchemeId` in the store and
  // `injectSchemeToDOM` could be undone (see PR #5087).
  before.setPreviewSchemeId(null);
  if (previous.followSystem) before.setFollowSystem(false);
  before.commitSchemeSelection(targetId);
  const targetRecents = useAppThemeStore.getState().recentSchemeIds;

  // A project with its own theme keeps showing it; the pick is the global theme.
  // Resolved when the reveal paints, so a project theme pushed meanwhile wins.
  const paint = () =>
    injectSchemeToDOM(resolveCommittedScheme(useAppThemeStore.getState()), { immediate: true });
  // The palette has already painted the theme as a live preview, so it skips the wipe.
  if (options.reveal === false) paint();
  else runThemeReveal(origin, paint);

  // Another pick (a newer browser commit, the Appearance picker, the palette)
  // owns the selection now, and a late failure here must not drag it back.
  const ownsSelection = () =>
    epoch === themeCommitEpoch && useAppThemeStore.getState().selectedSchemeId === targetId;

  try {
    if (previous.followSystem) {
      await appThemeClient.setFollowSystem(false);
      followSystemOffOnDisk = true;
    }
    if (!ownsSelection()) return;
    await appThemeClient.setColorScheme(targetId);
  } catch (error) {
    logError("Failed to persist app theme", error);
    if (!ownsSelection()) return;

    const state = useAppThemeStore.getState();
    // Only put system matching back if this commit is what turned it off, and
    // only as far as disk agrees: once the turn-off landed it stays off.
    if (previous.followSystem && !state.followSystem) {
      state.setFollowSystem(!followSystemOffOnDisk);
    }
    // commitSchemeSelection re-seeds the MRU as a side effect, so the recents
    // list has to be put back after it, not before.
    state.commitSchemeSelection(previous.selectedSchemeId);
    state.setRecentSchemeIds(previous.recentSchemeIds);
    const restored = useAppThemeStore.getState();
    // A preview in a reopened browser owns the DOM until it ends.
    if (restored.previewSchemeId === null) {
      injectSchemeToDOM(resolveCommittedScheme(restored), { immediate: true });
    }

    const restoredSchemeId = restored.selectedSchemeId;
    notify({
      type: "error",
      title: "Couldn't save theme",
      message: "The previous theme was restored, so it won't change on restart.",
      // `settings` is passive; without this the failure would be an inbox row.
      priority: "high",
      urgent: true,
      replaceKey: "theme-browser-save-failed",
      context: { eventKind: "settings" },
      action: {
        label: "Retry",
        onClick: () => {
          // A theme picked since this failure is the user's newer intent.
          const current = useAppThemeStore.getState();
          if (epoch !== themeCommitEpoch || current.selectedSchemeId !== restoredSchemeId) return;
          return commitAppThemeSelection(targetId, null, options);
        },
      },
    });
    return;
  }

  if (!ownsSelection()) return;
  try {
    await appThemeClient.setRecentSchemeIds(targetRecents);
  } catch (error) {
    logError("Failed to persist recent app themes", error);
    if (ownsSelection() && useAppThemeStore.getState().recentSchemeIds === targetRecents) {
      useAppThemeStore.getState().setRecentSchemeIds(previous.recentSchemeIds);
    }
  }
}
