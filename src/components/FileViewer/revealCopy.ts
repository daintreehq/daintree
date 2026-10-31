import { useMemo } from "react";
import { Copy, type LucideIcon } from "lucide-react";
import { FolderOpen } from "@/components/icons";
import { isWindows } from "@/lib/platform";
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

const SHOW_IN_EXPLORER: RevealCopy = {
  label: "Show in Explorer",
  errorTitle: "Couldn't show in Explorer",
  retryAriaLabel: "Retry showing in Explorer",
  icon: FolderOpen,
  copiedAnnouncement: null,
};

const COPY_HOST_PATH: RevealCopy = {
  label: "Copy host path",
  errorTitle: "Couldn't copy host path",
  retryAriaLabel: "Retry copying host path",
  icon: Copy,
  // The terminal menu's remote reveal copies through `copyWithToast("Host
  // path", …)`, which announces the same words.
  copiedAnnouncement: "Host path copied",
};

/**
 * A remote window on a Windows PC before main has said how its host is reached:
 * a WSL distro reveals in Explorer, an ssh host copies, and until the answer
 * lands the control keeps its old folder glyph and claims no copy, rather than
 * confirm one that main then doesn't make.
 */
const COPY_HOST_PATH_UNRESOLVED: RevealCopy = {
  ...COPY_HOST_PATH,
  icon: FolderOpen,
  copiedAnnouncement: null,
};

const REVEAL_IN_FINDER: RevealCopy = {
  label: "Reveal in Finder",
  errorTitle: "Couldn't reveal in Finder",
  retryAriaLabel: "Retry revealing in Finder",
  icon: FolderOpen,
  copiedAnnouncement: null,
};

const SHOW_IN_FOLDER: RevealCopy = {
  label: "Show in folder",
  errorTitle: "Couldn't show in folder",
  retryAriaLabel: "Retry showing in folder",
  icon: FolderOpen,
  copiedAnnouncement: null,
};

/**
 * Resolved from the snapshot it is handed: the seeded host platform the
 * `isHost*` helpers read only ever changes along with that snapshot.
 */
function revealCopyFor(host: HostPlatformInfo): RevealCopy {
  if (isRemoteWindow()) {
    if (host.connection?.kind === "wsl") return SHOW_IN_EXPLORER;
    // A WSL distro is only ever reached from a Windows PC (`wsl.exe`), so
    // anywhere else a host whose connection is still unknown is an ssh one.
    if (host.connection === null && isWindows()) return COPY_HOST_PATH_UNRESOLVED;
    return COPY_HOST_PATH;
  }
  if (isHostMac()) return REVEAL_IN_FINDER;
  if (isHostWindows()) return SHOW_IN_EXPLORER;
  return SHOW_IN_FOLDER;
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
 * `revealCopy` for a render path. A WSL window is told apart by a connection
 * kind main reports after the first render, and a reveal still wearing "Copy
 * host path" there would confirm a copy that never happened — so this reads the
 * host through its subscription rather than a getter the compiler could cache.
 */
export function useRevealCopy(): RevealCopy {
  const host = useHostPlatform();
  return useMemo(() => revealCopyFor(host), [host]);
}
