import type { FileBrowserPanelData } from "@shared/types/panel";
import type { FileBrowserPanelOptions } from "@shared/types/addPanelOptions";

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
    ...(options.browserRootPath != null && {
      browserRootPath: options.browserRootPath,
    }),
  };
}
