import type { FileBrowserPanelData } from "@shared/types/panel";
import type { FileBrowserPanelOptions } from "@shared/types/addPanelOptions";
import { canonicalizeRootPath } from "./fileBrowserTree";
import {
  FILE_BROWSER_SIDEBAR_DEFAULT_WIDTH,
  normalizeFileBrowserSidebarWidth,
} from "./sidebarWidth";

export function createFileBrowserDefaults(
  options: FileBrowserPanelOptions
): Partial<FileBrowserPanelData> {
  const width = normalizeFileBrowserSidebarWidth(options.browserSidebarWidth);
  return {
    // `!= null` rather than truthiness: an explicit `false` for the dotfile
    // toggle is a deliberate choice, and dropping it here would let a later
    // default stand in for it.
    ...(options.browserSelectedPath != null && {
      browserSelectedPath: options.browserSelectedPath,
    }),
    ...(options.browserExpandedPaths != null && {
      browserExpandedPaths: options.browserExpandedPaths,
    }),
    ...(options.browserHideDotfiles != null && {
      browserHideDotfiles: options.browserHideDotfiles,
    }),
    // Canonicalized on the way in: tree row keys are canonical listing paths,
    // and the up-one-level control does plain segment math on this value.
    ...(options.browserRootPath != null && {
      browserRootPath: canonicalizeRootPath(options.browserRootPath),
    }),
    // Only a collapsed sidebar materializes a field: `false` and absent are the
    // same open state, so we never stamp a default the serializer then drops.
    ...(options.browserSidebarCollapsed === true && { browserSidebarCollapsed: true }),
    ...(options.browserTreeSnapshot != null && {
      browserTreeSnapshot: options.browserTreeSnapshot,
    }),
    // Only a non-default width materializes: 288 and absent are the same state,
    // so a default-width panel stays sparse just like the collapsed bit.
    ...(width != null &&
      width !== FILE_BROWSER_SIDEBAR_DEFAULT_WIDTH && { browserSidebarWidth: width }),
  };
}
