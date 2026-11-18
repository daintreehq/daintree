import { useCallback, useEffect, useRef, useState } from "react";
import { filesClient } from "@/clients/filesClient";
import { logWarn } from "@/utils/logger";

/** The file pane's picker and the plugin providers wait the same after a keystroke. */
const FILE_SEARCH_DEBOUNCE_MS = 150;
// The files:search IPC schema caps `limit` at 100.
const FILE_SEARCH_LIMIT = 100;
/** Most file rows the switcher lists, as many as the file pane's picker shows. */
export const FILE_RESULT_CAP = 50;

export interface FileSearchRequest {
  rootPath: string;
  query: string;
  /** Every request is a new one, even when it asks what an earlier one did. */
  seq: number;
}

export interface FileSearchAnswer extends FileSearchRequest {
  /** Root-relative, forward-slash file paths, best match first. */
  paths: readonly string[];
  failed: boolean;
}

export interface QuickSwitcherFileSearchState {
  /** What the switcher is asking right now; null while it asks nothing. */
  request: FileSearchRequest | null;
  /**
   * The newest answer for the request's root, possibly to an earlier query:
   * it stays on screen while the current one is on its way, so typing never
   * blanks the list.
   */
  answer: FileSearchAnswer | null;
}

export interface UseQuickSwitcherFileSearchReturn {
  state: QuickSwitcherFileSearchState;
  /**
   * Search `rootPath` for `query`, after the debounce for a typed query and at
   * once for an empty one (the root's shortest paths). Cancels whatever was
   * pending. A null root or query asks nothing and drops what was shown.
   */
  request: (rootPath: string | null, query: string | null) => void;
}

const IDLE: QuickSwitcherFileSearchState = { request: null, answer: null };

/**
 * The quick switcher's file search (#17329), over the same host-side index the
 * file pane's picker and `@file` autocomplete use. `filesClient.search` takes
 * no abort signal, so a superseded request is dropped when it lands rather than
 * cancelled in flight.
 */
export function useQuickSwitcherFileSearch(): UseQuickSwitcherFileSearchReturn {
  const [state, setState] = useState<QuickSwitcherFileSearchState>(IDLE);
  const seqRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const request = useCallback<UseQuickSwitcherFileSearchReturn["request"]>(
    (rootPath, query) => {
      const seq = ++seqRef.current;
      clearTimer();
      if (rootPath === null || query === null) {
        setState((prev) => (prev === IDLE ? prev : IDLE));
        return;
      }
      setState((prev) => ({
        request: { rootPath, query, seq },
        answer: prev.answer?.rootPath === rootPath ? prev.answer : null,
      }));
      const settle = (paths: readonly string[], failed: boolean) => {
        if (seq !== seqRef.current) return;
        setState((prev) =>
          prev.request?.seq === seq
            ? { ...prev, answer: { rootPath, query, seq, paths, failed } }
            : prev
        );
      };
      timerRef.current = setTimeout(
        () => {
          timerRef.current = null;
          filesClient
            .search({ cwd: rootPath, query, limit: FILE_SEARCH_LIMIT, filesOnly: true })
            .then(
              // Uncapped here: the switcher drops working-tree deletions first,
              // then keeps at most FILE_RESULT_CAP.
              ({ files }) =>
                settle(
                  files.filter((file) => !file.endsWith("/")),
                  false
                ),
              (error: unknown) => {
                if (seq !== seqRef.current) return;
                logWarn("[QuickSwitcher] File search failed", { error });
                settle([], true);
              }
            );
        },
        query === "" ? 0 : FILE_SEARCH_DEBOUNCE_MS
      );
    },
    [clearTimer]
  );

  useEffect(
    () => () => {
      seqRef.current += 1;
      clearTimer();
    },
    [clearTimer]
  );

  return { state, request };
}
