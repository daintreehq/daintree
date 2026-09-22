import { store } from "../store.js";
import {
  DEFAULT_OPEN_FOLDERS_IN_NEW_WINDOW,
  isOpenFoldersInNewWindowMode,
  type WindowOpeningConfig,
} from "../../shared/types/ipc/windowOpening.js";

/**
 * The stored window-opening preference, read fresh on every call so a change
 * made in Settings applies to the very next open.
 *
 * A store that predates the key, or one hand-edited to something that isn't a
 * known mode, has not asked for anything, so it reads as the default. The
 * Settings select and whatever routes folder opens both read through here, so
 * they can never disagree about what an unrecognised value means.
 */
export function readWindowOpeningConfig(): WindowOpeningConfig {
  const stored: unknown = store.get("windowOpening")?.openFoldersInNewWindow;
  return {
    openFoldersInNewWindow: isOpenFoldersInNewWindowMode(stored)
      ? stored
      : DEFAULT_OPEN_FOLDERS_IN_NEW_WINDOW,
  };
}
