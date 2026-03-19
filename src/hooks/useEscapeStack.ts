import { useEffect, useRef } from "react";
import { registerEscape, updateHandler } from "@/lib/escapeStack";

export function useEscapeStack(enabled: boolean, handler: () => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const entryRef = useRef<{ id: symbol; unregister: () => void } | null>(null);

  useEffect(() => {
    if (enabled) {
      if (!entryRef.current) {
        entryRef.current = registerEscape(() => handlerRef.current());
      }
    } else {
      if (entryRef.current) {
        entryRef.current.unregister();
        entryRef.current = null;
      }
    }
  }, [enabled]);

  useEffect(() => {
    if (entryRef.current) {
      updateHandler(entryRef.current.id, () => handlerRef.current());
    }
  });

  useEffect(() => {
    return () => {
      if (entryRef.current) {
        entryRef.current.unregister();
        entryRef.current = null;
      }
    };
  }, []);
}
