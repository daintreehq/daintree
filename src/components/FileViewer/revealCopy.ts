import { useMemo } from "react";
import { Copy, type LucideIcon } from "lucide-react";
import { FolderOpen } from "@/components/icons";
import { isWindows } from "@/lib/platform";
import { remoteConnectionKindOn } from "@shared/config/remoteHostsSupport";
import {
  getHostPlatformInfo,
  isHostMac,
  isHostWindows,
  isRemoteWindow,
  useHostPlatform,
  type HostPlatformInfo,
} from "@/hooks/useHostPlatform";

export interface RevealCopy {
  label: string;
  errorTitle: string;
  retryAriaLabel: string;
  /** The control's glyph: a folder where a file manager opens, a copy where it doesn't. */
  icon: LucideIcon;
  /**
   * What a successful reveal announces when it copies the host path instead of
   * opening anything, since nothing on screen changes; null for a real reveal,
   * whose file manager window is its own confirmation.
   */
  copiedAnnouncement: string | null;
}

type RevealWords = Pick<RevealCopy, "label" | "errorTitle" | "retryAriaLabel">;

const SHOW_IN_EXPLORER: RevealWords = {
  label: "Show in Explorer",
  errorTitle: "Couldn't show in Explorer",
  retryAriaLabel: "Retry showing in Explorer",
};

const COPY_HOST_PATH: RevealWords = {
  label: "Copy host path",
  errorTitle: "Couldn't copy host path",
  retryAriaLabel: "Retry copying host path",
};

const REVEAL_IN_FINDER: RevealWords = {
  label: "Reveal in Finder",
  errorTitle: "Couldn't reveal in Finder",
  retryAriaLabel: "Retry revealing in Finder",
};

const SHOW_IN_FOLDER: RevealWords = {
  label: "Show in folder",
  errorTitle: "Couldn't show in folder",
  retryAriaLabel: "Retry showing in folder",
};

// The glyphs are read when a reveal is resolved, never at module scope: menu
// handlers import this module for its decision alone, and a suite that mocks
// the icon set without them would otherwise fail on import.
function opensFileManager(words: RevealWords): RevealCopy {
  return { ...words, icon: FolderOpen, copiedAnnouncement: null };
}

function copiesHostPath(): RevealCopy {
  // The terminal menu's remote reveal copies through `copyWithToast("Host
  // path", …)`, which announces the same words.
  return { ...COPY_HOST_PATH, icon: Copy, copiedAnnouncement: "Host path copied" };
}

/**
 * Resolved from the snapshot it is handed: the seeded host platform the
 * `isHost*` helpers read only ever changes along with that snapshot.
 */
function revealCopyFor(host: HostPlatformInfo): RevealCopy {
  if (isRemoteWindow()) {
    // Main names the connection after the first render; until then the client
    // decides it, since Daintree for Windows reaches only WSL distros and every
    // other client only ssh hosts. A reveal claiming a copy main never makes
    // would confirm one that didn't happen.
    const kind = host.connection?.kind ?? remoteConnectionKindOn(isWindows() ? "win32" : "posix");
    return kind === "wsl" ? opensFileManager(SHOW_IN_EXPLORER) : copiesHostPath();
  }
  if (isHostMac()) return opensFileManager(REVEAL_IN_FINDER);
  if (isHostWindows()) return opensFileManager(SHOW_IN_EXPLORER);
  return opensFileManager(SHOW_IN_FOLDER);
}

/**
 * The file manager is named differently on every platform, and the button, its
 * failure title and the retry's accessible name all have to agree — so the three
 * strings are resolved together rather than as three ternaries that could drift.
 * Shared by every surface with a "reveal" affordance (diff workspace, file
 * browser, the terminal and composer menus) so the wording can't fork between
 * them. The file lives on the project's host: for a remote window, whose file
 * manager would open on a screen nobody is looking at, main copies the host path
 * instead of revealing it, so the control wears the copy glyph and confirms the
 * copy like any other. A WSL distro is the exception, since its files are on
 * this PC and main reveals them in Explorer.
 */
export function revealCopy(): RevealCopy {
  return revealCopyFor(getHostPlatformInfo());
}

/**
 * `revealCopy` for a render path: it reads the host through its subscription
 * rather than a getter the compiler could cache, so the reveal follows what
 * main reports about the host after the first render.
 */
export function useRevealCopy(): RevealCopy {
  const host = useHostPlatform();
  return useMemo(() => revealCopyFor(host), [host]);
}
