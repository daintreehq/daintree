import { logError } from "@/utils/logger";

type EscapeHandler = () => void;

interface EscapeEntry {
  id: symbol;
  handler: EscapeHandler;
}

const stack: EscapeEntry[] = [];

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

export function _resetForTests(): void {
  stack.length = 0;
}
