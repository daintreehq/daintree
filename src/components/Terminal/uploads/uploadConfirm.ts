import { useSyncExternalStore } from "react";
import type { FolderUploadCheck } from "@shared/types/ipc/fileTransfer";

/**
 * Questions an upload asks before it goes ahead: a large file (above the
 * confirm threshold), for Add to project replacing a file already in the
 * folder, and what a folder holds before any of it is sent. A module queue, first one showing, answered by whichever mounted
 * {@link UploadConfirmHost} holds the lead — several surfaces mount one, and
 * exactly one renders.
 */

export type UploadQuestion =
  | { kind: "large"; name: string; bytes: number; hostLabel: string }
  | { kind: "replace"; name: string; folder: string; hostLabel: string }
  /**
   * Asked for every folder, whatever its size. A refused check is still shown,
   * so the person sees which limit or which names stopped it, and its only
   * answer is no.
   */
  | { kind: "folder"; check: FolderUploadCheck; hostLabel: string };

function canProceed(question: UploadQuestion): boolean {
  return question.kind !== "folder" || question.check.status === "ready";
}

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
 * ask, so the answer is no: an upload never proceeds unconfirmed. `signal`
 * withdraws the question, shown or still waiting, and answers no: the upload
 * it was for was cancelled from its chip.
 */
export function askUploadQuestion(
  question: UploadQuestion,
  options: { signal?: AbortSignal } = {}
): Promise<boolean> {
  const { signal } = options;
  if (hosts.length === 0 || signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const withdraw = () => entry.answer(false);
    const entry: QueuedQuestion = {
      id: nextId++,
      question,
      answer: (yes) => {
        const before = queue.length;
        queue = queue.filter((candidate) => candidate !== entry);
        if (queue.length === before) return;
        signal?.removeEventListener("abort", withdraw);
        emit();
        resolve(yes && canProceed(question));
      },
    };
    signal?.addEventListener("abort", withdraw, { once: true });
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
