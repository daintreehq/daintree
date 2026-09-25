import { useSyncExternalStore } from "react";

/**
 * Questions an upload asks before it goes ahead: a large file (above the
 * confirm threshold) and, for Add to project, replacing a file already in the
 * folder. A module queue, first one showing, answered by whichever mounted
 * {@link UploadConfirmHost} holds the lead — several surfaces mount one, and
 * exactly one renders.
 */

export type UploadQuestion =
  | { kind: "large"; name: string; bytes: number; hostLabel: string }
  | { kind: "replace"; name: string; folder: string; hostLabel: string };

interface QueuedQuestion {
  id: number;
  question: UploadQuestion;
  answer(yes: boolean): void;
}

let queue: QueuedQuestion[] = [];
let nextId = 1;
const hosts: symbol[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/**
 * Ask, and resolve with the answer. With no host mounted there is nobody to
 * ask, so the answer is no: an upload never proceeds unconfirmed.
 */
export function askUploadQuestion(question: UploadQuestion): Promise<boolean> {
  if (hosts.length === 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const entry: QueuedQuestion = {
      id: nextId++,
      question,
      answer: (yes) => {
        const before = queue.length;
        queue = queue.filter((candidate) => candidate !== entry);
        if (queue.length === before) return;
        emit();
        resolve(yes);
      },
    };
    queue = [...queue, entry];
    emit();
  });
}

export function currentUploadQuestion(): QueuedQuestion | null {
  return queue[0] ?? null;
}

export function registerUploadConfirmHost(token: symbol): () => void {
  hosts.push(token);
  emit();
  return () => {
    const index = hosts.indexOf(token);
    if (index >= 0) hosts.splice(index, 1);
    // The last host is gone: nothing can show what is waiting, so it is declined.
    if (hosts.length === 0) for (const entry of [...queue]) entry.answer(false);
    emit();
  };
}

export function leadUploadConfirmHost(): symbol | null {
  return hosts[0] ?? null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useUploadConfirmState(): { lead: symbol | null; head: QueuedQuestion | null } {
  const lead = useSyncExternalStore(subscribe, leadUploadConfirmHost, () => null);
  const head = useSyncExternalStore(subscribe, currentUploadQuestion, () => null);
  return { lead, head };
}

/** @internal Tests only. */
export function _resetUploadConfirmForTests(): void {
  queue = [];
  hosts.length = 0;
  listeners.clear();
  nextId = 1;
}
