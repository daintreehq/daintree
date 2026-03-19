type EscapeHandler = () => void;

interface EscapeEntry {
  id: symbol;
  handler: EscapeHandler;
}

const stack: EscapeEntry[] = [];

export function registerEscape(handler: EscapeHandler): { id: symbol; unregister: () => void } {
  const id = Symbol("escape");
  stack.push({ id, handler });
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
  const top = stack[stack.length - 1];
  top.handler();
  return true;
}

export function hasHandlers(): boolean {
  return stack.length > 0;
}

export function _resetForTests(): void {
  stack.length = 0;
}
