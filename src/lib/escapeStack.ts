import { logError } from "@/utils/logger";

type EscapeHandler = () => void;

interface EscapeEntry {
  id: symbol;
  handler: EscapeHandler;
}

const stack: EscapeEntry[] = [];

/**
 * Consulted only when the stack is empty and nothing else claimed the key.
 * Kept out of `hasHandlers()` on purpose: the keybinding capture handler
 * dispatches the stack whenever it has entries, which would take Escape away
 * from an open Radix menu or popover before it could close itself.
 */
const fallbacks: Array<() => boolean> = [];

export function registerEscape(
  handler: EscapeHandler,
  /**
   * `bottom` for a surface painted beneath every dialog and palette whenever
   * it opened: one already open when it registers still closes first.
   */
  { position = "top" }: { position?: "top" | "bottom" } = {}
): { id: symbol; unregister: () => void } {
  const id = Symbol("escape");
  if (position === "bottom") stack.unshift({ id, handler });
  else stack.push({ id, handler });
  return {
    id,
    unregister: () => {
      const idx = stack.findIndex((e) => e.id === id);
      if (idx !== -1) stack.splice(idx, 1);
    },
  };
}

export function updateHandler(id: symbol, handler: EscapeHandler): void {
  const entry = stack.find((e) => e.id === id);
  if (entry) entry.handler = handler;
}

export function dispatchEscape(): boolean {
  if (stack.length === 0) return false;
  const top = stack[stack.length - 1]!;
  try {
    top.handler();
  } catch (err) {
    logError("Escape handler threw", err);
  }
  return true;
}

export function hasHandlers(): boolean {
  return stack.length > 0;
}

/** The handler returns whether it acted, so an idle fallback leaves the key alone. */
export function registerEscapeFallback(handler: () => boolean): () => void {
  fallbacks.push(handler);
  return () => {
    const idx = fallbacks.lastIndexOf(handler);
    if (idx !== -1) fallbacks.splice(idx, 1);
  };
}

export function dispatchEscapeFallback(): boolean {
  for (let i = fallbacks.length - 1; i >= 0; i--) {
    try {
      if (fallbacks[i]!()) return true;
    } catch (err) {
      logError("Escape fallback threw", err);
      return true;
    }
  }
  return false;
}

export function _resetForTests(): void {
  stack.length = 0;
  fallbacks.length = 0;
}
