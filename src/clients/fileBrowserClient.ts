import type {
  FileBrowserListDirectoryPayload,
  FileBrowserListDirectoryResult,
} from "@shared/types/ipc/fileBrowser";

export const fileBrowserClient = {
  listDirectory: (
    payload: FileBrowserListDirectoryPayload
  ): Promise<FileBrowserListDirectoryResult> => {
    return window.electron.fileBrowser.listDirectory(payload);
  },
};
