import { isMac, isWindows } from "@/lib/platform";

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
 * file browser) so the wording can't fork between them.
 */
export function revealCopy(): RevealCopy {
  if (isMac()) {
    return {
      label: "Reveal in Finder",
      errorTitle: "Couldn't reveal in Finder",
      retryAriaLabel: "Retry revealing in Finder",
    };
  }
  if (isWindows()) {
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
