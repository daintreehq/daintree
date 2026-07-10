import type { DiffMediaFileVersions, DiffMediaReadFileVersionsPayload } from "@shared/types";

export const diffMediaClient = {
  readFileVersions: (payload: DiffMediaReadFileVersionsPayload): Promise<DiffMediaFileVersions> => {
    return window.electron.diffMedia.readFileVersions(payload);
  },
};
