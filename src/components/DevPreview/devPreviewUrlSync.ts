import type { DevPreviewStatus } from "@shared/types/ipc/devPreview";

function getOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

interface ShouldAdoptServerUrlArgs {
  currentUrl: string;
  nextUrl: string;
  status: DevPreviewStatus;
  isUrlStale: boolean;
}

/**
 * Decide whether the terminal-reported dev server URL should replace the current URL.
 * This keeps terminal output as the source of truth during startup and when ports change.
 */
export function shouldAdoptServerUrl({
  currentUrl,
  nextUrl,
  status,
  isUrlStale,
}: ShouldAdoptServerUrlArgs): boolean {
  if (!currentUrl) return true;
  if (isUrlStale) return true;
  if (status === "starting" || status === "installing") return true;

  const currentOrigin = getOrigin(currentUrl);
  const nextOrigin = getOrigin(nextUrl);

  if (currentOrigin && nextOrigin) {
    return currentOrigin !== nextOrigin;
  }

  return currentUrl !== nextUrl;
}
