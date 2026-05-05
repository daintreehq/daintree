import type { Scratch } from "@shared/types";

/**
 * Thin renderer-side wrapper for `window.electron.scratch`. Mirrors the
 * shape of `projectClient` so that callers (Zustand store, palette hook,
 * action definitions) get a uniform import surface for the scratch entity.
 */
export const scratchClient = {
  getAll(): Promise<Scratch[]> {
    return window.electron.scratch.getAll();
  },
  getCurrent(): Promise<Scratch | null> {
    return window.electron.scratch.getCurrent();
  },
  create(name?: string): Promise<Scratch> {
    return window.electron.scratch.create(name);
  },
  update(scratchId: string, updates: { name?: string; lastOpened?: number }): Promise<Scratch> {
    return window.electron.scratch.update(scratchId, updates);
  },
  remove(scratchId: string): Promise<void> {
    return window.electron.scratch.remove(scratchId);
  },
  switch(scratchId: string): Promise<Scratch> {
    return window.electron.scratch.switch(scratchId);
  },
  onUpdated(callback: (scratch: Scratch) => void): () => void {
    return window.electron.scratch.onUpdated(callback);
  },
  onRemoved(callback: (scratchId: string) => void): () => void {
    return window.electron.scratch.onRemoved(callback);
  },
};
