import type { FileWatchFingerprintPayload, FileWatchFingerprintResult } from "@shared/types";

export const fileWatchClient = {
  fingerprint: (payload: FileWatchFingerprintPayload): Promise<FileWatchFingerprintResult> => {
    return window.electron.fileWatch.fingerprint(payload);
  },
};
