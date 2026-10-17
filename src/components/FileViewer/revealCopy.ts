import { isHostMac, isHostWindows, isRemoteWindow, isWslWindow } from "@/hooks/useHostPlatform";

export interface RevealCopy {
  label: string;
  errorTitle: string;
  retryAriaLabel: string;
}

const SHOW_IN_EXPLORER: RevealCopy = {
  label: "Show in Explorer",
  errorTitle: "Couldn't show in Explorer",
  retryAriaLabel: "Retry showing in Explorer",
};

/**
 * The file manager is named differently on every platform, and the button, its
 * failure title and the retry's accessible name all have to agree — so the three
 * strings are resolved together rather than as three ternaries that could drift.
 * Shared by every surface with a "reveal" affordance (diff workspace, file
 * browser, the terminal and composer menus) so the wording can't fork between
 * them. The file lives on the project's host: for a remote window, whose file
 * manager would open on a screen nobody is looking at, main copies the host path
 * instead of revealing it. A WSL distro is the exception, since its files are on
 * this PC and main reveals them in Explorer.
 */
export function revealCopy(): RevealCopy {
  if (isWslWindow()) return SHOW_IN_EXPLORER;
  if (isRemoteWindow()) {
    return {
      label: "Copy host path",
      errorTitle: "Couldn't copy host path",
      retryAriaLabel: "Retry copying host path",
    };
  }
  if (isHostMac()) {
    return {
      label: "Reveal in Finder",
      errorTitle: "Couldn't reveal in Finder",
      retryAriaLabel: "Retry revealing in Finder",
    };
  }
  if (isHostWindows()) return SHOW_IN_EXPLORER;
  return {
    label: "Show in folder",
    errorTitle: "Couldn't show in folder",
    retryAriaLabel: "Retry showing in folder",
  };
}
