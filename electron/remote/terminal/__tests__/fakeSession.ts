import { vi } from "vitest";
import type { LinkSession } from "../../link/session.js";

/** The slice of a LinkSession the relays and bridges touch, with nothing on the wire. */
export function fakeSession(): LinkSession {
  return {
    isOpen: true,
    on: vi.fn(() => () => {}),
    onClose: vi.fn(() => () => {}),
    onWritable: vi.fn(() => () => {}),
    post: vi.fn(() => "queued"),
    call: vi.fn(async () => ({ terminals: [] })),
    queuedBytes: vi.fn(() => 0),
    registerCallHandler: vi.fn(() => () => {}),
  } as unknown as LinkSession;
}

type Listener = (...args: unknown[]) => void;

/** A WebContents that records its listeners so a test can fire navigation events. */
export function fakeWebContents(id: number) {
  const listeners = new Map<string, Set<Listener>>();
  const add = (event: string, listener: Listener) => {
    let set = listeners.get(event);
    if (!set) listeners.set(event, (set = new Set()));
    set.add(listener);
  };
  return {
    id,
    isDestroyed: () => false,
    on: vi.fn(add),
    once: vi.fn(add),
    removeListener: vi.fn((event: string, listener: Listener) => {
      listeners.get(event)?.delete(listener);
    }),
    emit: (event: string, ...args: unknown[]) => {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
    },
  } as unknown as Electron.WebContents & { emit: (event: string, ...args: unknown[]) => void };
}
