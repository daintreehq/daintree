import type {
  FileSearchPayload,
  FileSearchResult,
  FileReadPayload,
  FileReadResult,
} from "@shared/types";

export const filesClient = {
  search: (payload: FileSearchPayload): Promise<FileSearchResult> => {
    return window.electron.files.search(payload);
  },
  read: (payload: FileReadPayload): Promise<FileReadResult> => {
    return window.electron.files.read(payload);
  },
};
