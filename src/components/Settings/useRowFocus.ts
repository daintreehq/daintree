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
  const [pending, setPending] = useState<{ key: string | null } | null>(null);

  useEffect(() => {
    if (!pending) return;
    const target = (pending.key !== null && fields.current.get(pending.key)) || fallback.current;
    target?.focus();
    setPending(null);
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

  /** Focus the row registered under `key` once it has rendered, or the fallback if none is. */
  const focusRow = useCallback((key: string) => setPending({ key }), []);

  /** `keys` is the list before the delete; `index` is the deleted row's position in it. */
  const focusAfterDelete = useCallback((keys: readonly string[], index: number) => {
    const next = keys[index + 1] ?? keys[index - 1] ?? null;
    setPending({ key: next });
  }, []);

  return { register, registerFallback, focusRow, focusAfterDelete };
}
