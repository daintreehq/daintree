import { useSyncExternalStore } from "react";
import type { MaterializeOptions } from "@shared/types/remoteHosts";

/**
 * Uploads in flight to a remote window's host, per surface (a composer, a
 * terminal, a file browser). A module store rather than a zustand one: it is
 * written from drop and paste handlers, and read by the chips of whichever
 * surface the upload belongs to.
 *
 * An upload stays invisible for its first {@link UPLOAD_PROGRESS_DELAY_MS}:
 * the common case (a screenshot, a source file over a LAN) finishes in tens
 * of milliseconds, and a chip flashing up and away is noise.
 */

export const UPLOAD_PROGRESS_DELAY_MS = 250;

export interface PendingUpload {
  id: number;
  name: string;
  /** 0..1 once the host has confirmed any bytes; null before. */
  fraction: number | null;
  visible: boolean;
  cancel(): void;
}

const EMPTY: readonly PendingUpload[] = [];
const bySurface = new Map<string, readonly PendingUpload[]>();
const listeners = new Set<() => void>();
let nextId = 1;

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function update(surface: string, id: number, patch: Partial<PendingUpload> | null): void {
  const current = bySurface.get(surface) ?? EMPTY;
  const next =
    patch === null
      ? current.filter((entry) => entry.id !== id)
      : current.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
  if (next.length === 0) bySurface.delete(surface);
  else bySurface.set(surface, next);
  emit();
}

/**
 * Run one upload under a chip on `surface`. `run` gets the progress callback
 * and the signal the chip's cancel button aborts; the chip goes away however
 * the upload ends.
 */
export function trackUpload<T>(
  surface: string,
  name: string,
  run: (options: Pick<MaterializeOptions, "onProgress" | "signal">) => Promise<T>
): Promise<T> {
  const id = nextId++;
  const controller = new AbortController();
  const entry: PendingUpload = {
    id,
    name,
    fraction: null,
    visible: false,
    cancel: () => controller.abort(),
  };
  bySurface.set(surface, [...(bySurface.get(surface) ?? EMPTY), entry]);
  emit();
  const timer = setTimeout(() => update(surface, id, { visible: true }), UPLOAD_PROGRESS_DELAY_MS);
  let lastPercent = -1;
  const onProgress = (fraction: number) => {
    const percent = Math.floor(Math.max(0, Math.min(1, fraction)) * 100);
    if (percent === lastPercent) return;
    lastPercent = percent;
    update(surface, id, { fraction: percent / 100 });
  };
  return run({ onProgress, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
    update(surface, id, null);
  });
}

export function getPendingUploads(surface: string): readonly PendingUpload[] {
  return bySurface.get(surface) ?? EMPTY;
}

/** Whether anything is still uploading for `surface` — shown or not yet. */
export function hasPendingUploads(surface: string): boolean {
  return (bySurface.get(surface)?.length ?? 0) > 0;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePendingUploads(surface: string): readonly PendingUpload[] {
  return useSyncExternalStore(
    subscribe,
    () => getPendingUploads(surface),
    () => EMPTY
  );
}

/** Surface keys, so a composer and the terminal under it never share chips. */
export const composerUploadSurface = (terminalId: string) => `composer:${terminalId}`;
export const terminalUploadSurface = (terminalId: string) => `terminal:${terminalId}`;
export const fileBrowserUploadSurface = (panelId: string) => `file-browser:${panelId}`;

/** @internal Tests only. */
export function _resetPendingUploadsForTests(): void {
  bySurface.clear();
  listeners.clear();
  nextId = 1;
}
