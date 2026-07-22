import type {
  FileBrowserListDirectoryPayload,
  FileBrowserListDirectoryResult,
  FileBrowserStatPathsPayload,
  FileBrowserStatPathsResult,
} from "@shared/types/ipc/fileBrowser";

export const fileBrowserClient = {
  listDirectory: (
    payload: FileBrowserListDirectoryPayload
  ): Promise<FileBrowserListDirectoryResult> => {
    return window.electron.fileBrowser.listDirectory(payload);
  },
  statPaths: (payload: FileBrowserStatPathsPayload): Promise<FileBrowserStatPathsResult> => {
    return window.electron.fileBrowser.statPaths(payload);
  },
};
