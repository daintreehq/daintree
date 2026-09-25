import type { HostPickRequest } from "@shared/types/ipc/hostFiles";

/**
 * The open host-picker requests, first one showing. A module queue rather
 * than a store: one mounted host renders the head, and anything in the
 * renderer that needs a host path awaits {@link pickHostPaths}.
 */

export interface QueuedHostPick {
  id: number;
  request: HostPickRequest;
  resolve(paths: string[] | null): void;
}

let queue: QueuedHostPick[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/**
 * Show Daintree's picker over the window's host and resolve with the chosen
 * absolute host paths, or null when it is dismissed. Needs a mounted
 * `HostFilePickerHost`.
 */
export function pickHostPaths(request: HostPickRequest): Promise<string[] | null> {
  return new Promise((resolve) => {
    const entry: QueuedHostPick = {
      id: nextId++,
      request,
      resolve: (paths) => {
        const before = queue.length;
        queue = queue.filter((candidate) => candidate !== entry);
        if (queue.length === before) return;
        emit();
        resolve(paths);
      },
    };
    queue = [...queue, entry];
    emit();
  });
}

export function subscribeHostPicks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function currentHostPick(): QueuedHostPick | null {
  return queue[0] ?? null;
}

/** Dismiss every open picker (the view is going away). */
export function dismissAllHostPicks(): void {
  for (const entry of [...queue]) entry.resolve(null);
}
