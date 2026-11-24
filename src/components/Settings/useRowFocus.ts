import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Focus recovery for the settings list editors. Adding a row puts the caret in its
 * first field; deleting one moves focus to the row that took its place, the row
 * before it, or the add action when the list is now empty — instead of dropping
 * focus on `document.body` when the focused delete button unmounts.
 *
 * Rows register their first field by a stable key. The move happens after the
 * render that mounts or removes the row, so the target exists when it is focused.
 */
export function useRowFocus() {
  const fields = useRef(new Map<string, HTMLElement>());
  const fallback = useRef<HTMLElement | null>(null);
  const [pending, setPending] = useState<{
    keys: readonly string[];
    onlyIfStranded: boolean;
  } | null>(null);

  useEffect(() => {
    if (!pending) return;
    setPending(null);
    // A delete that lands after the user moved on must not pull focus back.
    if (pending.onlyIfStranded) {
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected) return;
    }
    // The first candidate still mounted: a neighbour captured before the delete
    // may itself be gone by the time the delete lands.
    const key = pending.keys.find((candidate) => fields.current.has(candidate));
    const target = (key !== undefined && fields.current.get(key)) || fallback.current;
    target?.focus();
  }, [pending]);

  const register = useCallback(
    (key: string) => (el: HTMLElement | null) => {
      if (el) fields.current.set(key, el);
      else fields.current.delete(key);
    },
    []
  );

  const registerFallback = useCallback((el: HTMLElement | null) => {
    fallback.current = el;
  }, []);

  /**
   * Focus the row registered under `key` once it has rendered, or the fallback if none is.
   * `onlyIfStranded` is for a move that follows a save: it holds back when the user
   * has put focus somewhere else while the save was out.
   */
  const focusRow = useCallback(
    (key: string, options?: { onlyIfStranded?: boolean }) =>
      setPending({ keys: [key], onlyIfStranded: options?.onlyIfStranded ?? false }),
    []
  );

  /**
   * `keys` is the list before the delete; `index` is the deleted row's position in it.
   * Goes to the next row, else the nearest one before, else the fallback — and only
   * while focus is still stranded, so a delete that saves slowly never steals it.
   */
  const focusAfterDelete = useCallback((keys: readonly string[], index: number) => {
    setPending({
      keys: [...keys.slice(index + 1), ...keys.slice(0, index).reverse()],
      onlyIfStranded: true,
    });
  }, []);

  return { register, registerFallback, focusRow, focusAfterDelete };
}
