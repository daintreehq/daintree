import type { FileBrowserPanelData } from "@shared/types/panel";
import type { FileBrowserPanelOptions } from "@shared/types/addPanelOptions";
import { canonicalizeRootPath } from "./fileBrowserTree";

export function createFileBrowserDefaults(
  options: FileBrowserPanelOptions
): Partial<FileBrowserPanelData> {
  return {
    // `!= null` rather than truthiness: an explicit `false` for the ignored
    // toggle is a deliberate choice, and dropping it here would let a later
    // default stand in for it.
    ...(options.browserSelectedPath != null && {
      browserSelectedPath: options.browserSelectedPath,
    }),
    ...(options.browserExpandedPaths != null && {
      browserExpandedPaths: options.browserExpandedPaths,
    }),
    ...(options.browserShowIgnored != null && {
      browserShowIgnored: options.browserShowIgnored,
    }),
    // Canonicalized on the way in: tree row keys are canonical listing paths,
    // and the up-one-level control does plain segment math on this value.
    ...(options.browserRootPath != null && {
      browserRootPath: canonicalizeRootPath(options.browserRootPath),
    }),
  };
}
