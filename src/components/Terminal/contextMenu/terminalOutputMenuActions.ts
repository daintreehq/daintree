import { revealCopy } from "@/components/FileViewer/revealCopy";
import { actionService } from "@/services/ActionService";
import { reportFileLinkFailure } from "@/services/terminal/FileLinksAddon";
import type { OpenLinkOptions } from "@/services/terminal/TerminalLinkHandler";
import type { TerminalLink } from "@/services/terminal/types";
import type { WorktreeScope } from "@shared/utils/path";
import type { MenuActionSourceValue } from "@/components/ui/menu-source";
import { copyWithToast } from "@/lib/copyWithToast";

/** The terminal a menu's output items act on: a grid pane, or Canopy's live view of a run. */
export interface TerminalOutputMenuTarget {
  /** Opens the link that was under the pointer when the menu opened. */
  openHoveredLink(): void;
  /** Opens a URL the menu captured when it opened, from the run's own host. */
  openLink(url: string, options?: OpenLinkOptions): void;
}

/**
 * Opens the link a menu captured when it opened, through its own activation so
 * a URL, an OSC 8 link and a file path each route as a click on them would.
 * The terminal's live hover is not read: it ends as the pointer reaches the menu.
 */
export function activateCapturedLink(link: TerminalLink): void {
  void Promise.resolve()
    .then(() => link.activate(new MouseEvent("click"), link.text))
    .catch((error: unknown) =>
      reportFileLinkFailure("Failed to activate hovered link", error, link.text)
    );
}

/**
 * Runs one of the items `TerminalSelectionMenuItems` offers for what the
 * pointer found in the output; false for any other item.
 */
export function runTerminalOutputMenuAction(
  actionId: string,
  target: TerminalOutputMenuTarget,
  source: MenuActionSourceValue
): boolean {
  if (actionId === "open-link") {
    target.openHoveredLink();
    return true;
  }

  // The URL was captured when the menu opened; the hover itself ends as
  // soon as the pointer moves onto the menu.
  if (actionId.startsWith("open-link-claimed:")) {
    target.openLink(actionId.slice("open-link-claimed:".length));
    return true;
  }

  if (actionId.startsWith("open-link-external:")) {
    target.openLink(actionId.slice("open-link-external:".length), { external: true });
    return true;
  }

  if (actionId.startsWith("copy-link:")) {
    const url = actionId.slice("copy-link:".length);
    void actionService.dispatch("terminal.copyLink", { url }, { source });
    return true;
  }

  if (actionId.startsWith("reveal-in-finder:")) {
    const path = actionId.slice("reveal-in-finder:".length);
    // The path is the host's; a remote host's file manager is on a screen
    // nobody is looking at, so hand the path over instead. A WSL distro's
    // files are on this PC, so those reveal in Explorer like local ones. The
    // row is labelled from the same resolver, so its words and its action
    // agree even before main has named the window's connection.
    if (revealCopy().copiedAnnouncement !== null) {
      copyWithToast("Host path", path);
      return true;
    }
    // Unlike copy-link, guard rejections (OUTSIDE_ROOT) and a since-deleted
    // file (NOT_FOUND) are real, expected failure modes here — surface them
    // rather than fire-and-forget. dispatch wraps the thrown error as
    // EXECUTION_ERROR, so the original coded error lives on `.details`.
    void actionService.dispatch("file.showItemInFolder", { path }, { source }).then((result) => {
      if (!result.ok) {
        reportFileLinkFailure("Failed to reveal in file manager", result.error.details, path);
      }
    });
    return true;
  }

  return false;
}

/** Opens the worktree's file browser at a path the menu found in the output. */
export function openTerminalPathInFileBrowser(
  scope: WorktreeScope,
  path: string,
  kind: "file" | "directory" | null,
  source: MenuActionSourceValue
): void {
  void actionService
    .dispatch(
      "worktree.openFileBrowser",
      {
        worktreeId: scope.worktreeId,
        revealPath: scope.relativePath || undefined,
        // Carried through rather than assumed: a directory is expanded as
        // well as selected, so guessing "file" would leave a right-clicked
        // folder collapsed while left-clicking the same link opens it.
        revealKind: kind ?? "file",
      },
      { source }
    )
    .then((result) => {
      if (!result.ok) {
        reportFileLinkFailure(
          "Failed to open file browser",
          result.error.details,
          path,
          kind === "directory" ? "folder" : "file"
        );
      }
    });
}
