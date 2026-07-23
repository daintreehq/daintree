import type { FileBrowserPanelData } from "@shared/types/panel";
import type { FileBrowserPanelOptions } from "@shared/types/addPanelOptions";
import { canonicalizeRootPath } from "./fileBrowserTree";

export function createFileBrowserDefaults(
  options: FileBrowserPanelOptions
): Partial<FileBrowserPanelData> {
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
  };
}
