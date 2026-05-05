import type { Scratch } from "@shared/types";
import type { ScratchSaveAsProjectResult } from "@shared/types/ipc/scratch";

/**
 * Thin renderer-side wrapper for `window.electron.scratch`. Mirrors the
 * shape of `projectClient` so that callers (Zustand store, palette hook,
 * action definitions) get a uniform import surface for the scratch entity.
 *
 * Each accessor reads `window.electron.scratch` lazily and degrades
 * gracefully when the namespace is absent. Many existing test files supply
 * a partial `window.electron` mock that predates this entity; without the
 * lazy guard, palette/store code paths that fire `getAll`/`getCurrent` on
 * mount would surface as Unhandled Rejections in those tests and fail the
 * whole vitest run.
 */
type ScratchApi = NonNullable<Window["electron"]["scratch"]>;

function api(): ScratchApi | null {
  if (typeof window === "undefined") return null;
  return window.electron?.scratch ?? null;
}

const NOOP_CLEANUP = () => {};

export const scratchClient = {
  getAll(): Promise<Scratch[]> {
    return api()?.getAll() ?? Promise.resolve([]);
  },
  getCurrent(): Promise<Scratch | null> {
    return api()?.getCurrent() ?? Promise.resolve(null);
  },
  create(name?: string): Promise<Scratch> {
    const a = api();
    if (!a) return Promise.reject(new Error("scratch IPC unavailable"));
    return a.create(name);
  },
  update(scratchId: string, updates: { name?: string; lastOpened?: number }): Promise<Scratch> {
    const a = api();
    if (!a) return Promise.reject(new Error("scratch IPC unavailable"));
    return a.update(scratchId, updates);
  },
  remove(scratchId: string): Promise<void> {
    return api()?.remove(scratchId) ?? Promise.resolve();
  },
  switch(scratchId: string): Promise<Scratch> {
    const a = api();
    if (!a) return Promise.reject(new Error("scratch IPC unavailable"));
    return a.switch(scratchId);
  },
  saveAsProject(scratchId: string): Promise<ScratchSaveAsProjectResult> {
    const a = api();
    if (!a) return Promise.reject(new Error("scratch IPC unavailable"));
    return a.saveAsProject(scratchId);
  },
  onUpdated(callback: (scratch: Scratch) => void): () => void {
    return api()?.onUpdated(callback) ?? NOOP_CLEANUP;
  },
  onRemoved(callback: (scratchId: string) => void): () => void {
    return api()?.onRemoved(callback) ?? NOOP_CLEANUP;
  },
};
