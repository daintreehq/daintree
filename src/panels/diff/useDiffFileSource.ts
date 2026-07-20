import { useCallback, useEffect, useRef, useState } from "react";
import { isAbsolute, join } from "@shared/utils/path";
import { filesClient } from "@/clients/filesClient";
import { isClientAppError } from "@/utils/clientAppError";
import { toFileReadErrorCode } from "@/components/FileViewer/fileReadErrors";
import type { FileReadErrorCode } from "@shared/types/ipc/files";

export interface DiffFileSourceSubject {
  worktreePath: string;
  /** Worktree-relative, as `DiffPanelData` stores it. */
  filePath: string;
}

export interface UseDiffFileSourceResult {
  /** New-side file content, or undefined while loading / when not requested. */
  source: string | undefined;
  /** Set when the read failed; `source` is undefined whenever this is set. */
  errorCode: FileReadErrorCode | null;
}

const IDLE: UseDiffFileSourceResult = {
  source: undefined,
  errorCode: null,
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
      return;
    }
    setSource(undefined);
    setErrorCode(null);
    try {
      // `files:read` rejects anything relative; panels store the path relative
      // to their worktree, so it has to be resolved before it crosses IPC.
      const absolutePath = isAbsolute(filePath) ? filePath : join(worktreePath, filePath);
      const result = await filesClient.read({ path: absolutePath, rootPath: worktreePath });
      if (requestRef.current !== requestId) return;
      setSource(result.content);
    } catch (error) {
      if (requestRef.current !== requestId) return;
      setErrorCode(isClientAppError(error) ? toFileReadErrorCode(error.code) : "INVALID_PATH");
    }
  }, [active, worktreePath, filePath]);

  useEffect(() => {
    // The ref object is captured, not its value: the cleanup has to bump
    // whatever the counter reads at teardown, which is the point.
    const sequence = requestRef;
    void fetchSource();
    // Invalidate whatever is in flight when the file changes or the scope is
    // switched off, so a resolving read can't land on the next file.
    return () => {
      sequence.current++;
    };
  }, [fetchSource]);

  if (!active) return IDLE;
  return { source, errorCode };
}
