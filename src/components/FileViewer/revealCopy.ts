import { isHostMac, isHostWindows, isRemoteWindow } from "@/hooks/useHostPlatform";

export interface RevealCopy {
  label: string;
  errorTitle: string;
  retryAriaLabel: string;
}

/**
 * The file manager is named differently on every platform, and the button, its
 * failure title and the retry's accessible name all have to agree — so the three
 * strings are resolved together rather than as three ternaries that could drift.
 * Shared by every viewer surface with a "reveal" affordance (diff workspace,
 * file browser) so the wording can't fork between them. The file lives on the
 * project's host: for a remote window, whose file manager would open on a screen
 * nobody is looking at, main copies the host path instead of revealing it.
 */
export function revealCopy(): RevealCopy {
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
  if (isHostWindows()) {
    return {
      label: "Show in Explorer",
      errorTitle: "Couldn't show in Explorer",
      retryAriaLabel: "Retry showing in Explorer",
    };
  }
  return {
    label: "Show in folder",
    errorTitle: "Couldn't show in folder",
    retryAriaLabel: "Retry showing in folder",
  };
}
