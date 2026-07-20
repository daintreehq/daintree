import { useCallback, useEffect, useRef, useState } from "react";
import { filesClient } from "@/clients/filesClient";
import { isClientAppError } from "@/utils/clientAppError";
import { toFileReadErrorCode } from "@/components/FileViewer/fileReadErrors";
import type { FileReadErrorCode } from "@shared/types/ipc/files";

export interface DiffFileSourceSubject {
  worktreePath: string;
  filePath: string;
}

export interface UseDiffFileSourceResult {
  /** New-side file content, or undefined while loading / when not requested. */
  source: string | undefined;
  /** Set when the read failed; `source` is undefined whenever this is set. */
  errorCode: FileReadErrorCode | null;
  loading: boolean;
  retry: () => void;
}

const IDLE: UseDiffFileSourceResult = {
  source: undefined,
  errorCode: null,
  loading: false,
  retry: () => {},
};

/**
 * Reads the whole new-side file backing one diff, for the surfaces where that
 * side is the file on disk. Only fetches while `enabled` — the content is
 * several hundred KB and is worthless until the user asks to see beyond the
 * hunks.
 *
 * Callers must gate `enabled` on the diff source actually being disk-backed
 * (see `getFullFileAvailability`); this hook does not re-derive that, and
 * reading disk for a staged or base-branch diff would return content the diff
 * was never generated from.
 */
export function useDiffFileSource(
  subject: DiffFileSourceSubject | null,
  enabled: boolean
): UseDiffFileSourceResult {
  const [source, setSource] = useState<string | undefined>(undefined);
  const [errorCode, setErrorCode] = useState<FileReadErrorCode | null>(null);
  const [loading, setLoading] = useState(false);
  // IPC reads can't be aborted, so late responses are dropped by sequence
  // number instead — the same discipline `useDiffContent` uses.
  const requestRef = useRef(0);

  const worktreePath = subject?.worktreePath;
  const filePath = subject?.filePath;
  const active = enabled && worktreePath !== undefined && filePath !== undefined;

  const fetchSource = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (!active || worktreePath === undefined || filePath === undefined) {
      setSource(undefined);
      setErrorCode(null);
      setLoading(false);
      return;
    }
    setSource(undefined);
    setErrorCode(null);
    setLoading(true);
    try {
      const result = await filesClient.read({ path: filePath, rootPath: worktreePath });
      if (requestRef.current !== requestId) return;
      setSource(result.content);
      setLoading(false);
    } catch (error) {
      if (requestRef.current !== requestId) return;
      setErrorCode(isClientAppError(error) ? toFileReadErrorCode(error.code) : "INVALID_PATH");
      setLoading(false);
    }
  }, [active, worktreePath, filePath]);

  useEffect(() => {
    void fetchSource();
    // Invalidate whatever is in flight when the file changes or the scope is
    // switched off, so a resolving read can't land on the next file.
    return () => {
      requestRef.current++;
    };
  }, [fetchSource]);

  const retry = useCallback(() => {
    void fetchSource();
  }, [fetchSource]);

  if (!active) return IDLE;
  return { source, errorCode, loading, retry };
}
