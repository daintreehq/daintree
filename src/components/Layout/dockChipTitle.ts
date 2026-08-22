import {
  isBrowserPanel,
  isFileBrowserPanel,
  isFilePanel,
  type BrowserPanelData,
  type FileBrowserPanelData,
  type FilePanelData,
  type PanelInstance,
} from "@shared/types/panel";
import { extractHostPort } from "@/components/Browser/browserUtils";
import { compactFileBrowserTitle } from "@/panels/file-browser/title";

/** Last segment of a path, tolerating either separator and trailing slashes. */
function basename(path: string | undefined): string | undefined {
  return path?.split(/[/\\]/).filter(Boolean).pop();
}

// File name beats the generic kind title in the chip, mirroring FilePane's own
// title layering (a user-locked rename still wins).
export function fileChipTitle(panel: FilePanelData): string {
  const fileName = basename(panel.filePath);
  return panel.titleMode === "user" ? panel.title : (fileName ?? panel.title);
}

// Host beats the generic "Browser" title in the chip, mirroring BrowserPane's
// displayTitle (a page-supplied title still wins; a user-locked rename always
// wins). Falls back to the kind title when there's no host to show (e.g.
// about:blank, whose URL.host is empty) so the chip is never blank.
export function browserChipTitle(panel: BrowserPanelData): string {
  if (panel.titleMode === "user") return panel.title;
  if (panel.title && panel.title !== "Browser") return panel.title;
  const currentUrl = panel.browserHistory?.present || panel.browserUrl || "";
  const host = currentUrl ? extractHostPort(currentUrl) : "";
  // Ultimate fallback so the chip is never blank (e.g. empty title + no URL).
  return host || panel.title || "Browser";
}

/**
 * The folder the tree is rooted at, not the file the viewer happens to be
 * showing (#11917).
 *
 * `browserSelectedPath` is the obvious analogue of the file panel's `filePath`,
 * and it is the wrong one: it changes on every arrow-key step through the tree,
 * so the chip would relabel while the user reads, and two browsers with nothing
 * selected would both collapse to the same label. Scoping the tree to a
 * subfolder is a deliberate, sticky gesture, so that name leads; otherwise the
 * composed title minus its "Files — " prefix is what names the worktree or
 * project, which is the only thing distinguishing one root browser from another.
 */
export function fileBrowserChipTitle(panel: FileBrowserPanelData): string {
  // Both explicit rungs of the title-ownership ladder, not just `"user"`:
  // `"custom"` is a name automation asked for (an MCP `terminal.rename`), and
  // the ladder freezes it against derived rewrites — which is exactly what
  // trimming it here would be. Only a `"default"` title is this module's to
  // take apart.
  if (panel.titleMode === "user" || panel.titleMode === "custom") return panel.title;
  // Trimmed before the truthiness test: a directory named entirely of spaces is
  // a legal path segment `canonicalizeRootPath` keeps, and it would otherwise
  // pass as a label and render the chip blank.
  const scopedRoot = basename(panel.browserRootPath)?.trim();
  if (scopedRoot) return scopedRoot;
  // Both fallbacks are load-bearing: a title that carried no prefix comes back
  // unchanged, and an empty one still owes the chip a label.
  return compactFileBrowserTitle(panel.title) || panel.title || "Files";
}

// Chip label for a non-PTY dock panel. File, browser and file-browser get their
// kind-specific derivations; every other dockable kind (dev-preview if opted
// in, plugin view panels — #11332) falls back to the panel title so the chip is
// never blank.
export function dockChipTitle(panel: PanelInstance): string {
  if (isFilePanel(panel)) return fileChipTitle(panel);
  if (isBrowserPanel(panel)) return browserChipTitle(panel);
  if (isFileBrowserPanel(panel)) return fileBrowserChipTitle(panel);
  return panel.title;
}
