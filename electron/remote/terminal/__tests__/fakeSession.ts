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

export function fakeWebContents(id: number) {
  return {
    id,
    isDestroyed: () => false,
    once: vi.fn(),
    removeListener: vi.fn(),
  } as unknown as Electron.WebContents;
}
