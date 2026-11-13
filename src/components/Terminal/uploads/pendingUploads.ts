import { useSyncExternalStore } from "react";
import type {
  FolderMaterializeProgress,
  FolderUploadProgress,
} from "@shared/types/ipc/fileTransfer";
import type { MaterializeOptions } from "@shared/types/remoteHosts";

export type { FolderUploadProgress };

/**
 * Uploads in flight to a remote window's host, per surface (a composer, a
 * terminal, a file browser), and a composer's attachments that are still being
 * prepared or were held back. A module store rather than a zustand one: it is
 * written from drop and paste handlers, and read by the chips of whichever
 * surface the upload belongs to.
 *
 * An upload stays invisible for its first {@link UPLOAD_PROGRESS_DELAY_MS}:
 * the common case (a screenshot, a source file over a LAN) finishes in tens
 * of milliseconds, and a chip flashing up and away is noise.
 */

export const UPLOAD_PROGRESS_DELAY_MS = 250;

/** A folder send's progress, cut down to what its chip says. */
export type FolderUploadStage =
  | { phase: "waiting" }
  | { phase: "reading" }
  | { phase: "packing" }
  | { phase: "sending"; percent: number | null }
  | { phase: "unpacking"; filesDone: number | null; filesTotal: number };

export interface PendingUpload {
  id: number;
  name: string;
  /** 0..1 once the host has confirmed any bytes; null before. */
  fraction: number | null;
  /** A folder send's phase. Absent for a file, whose progress is {@link fraction}. */
  folder?: FolderUploadStage;
  visible: boolean;
  cancel(): void;
}

/** An attachment ready to go into a draft: what its chip shows and where it points. */
export type PreparedAttachment =
  | { type: "image"; filePath: string; thumbnailDataUrl: string }
  | { type: "file"; filePath: string; fileName: string; fileSize: number | undefined };

const EMPTY: readonly PendingUpload[] = [];
const NO_ATTACHMENTS: readonly PreparedAttachment[] = [];
const bySurface = new Map<string, readonly PendingUpload[]>();
const sendHolds = new Map<string, number>();
const heldBack = new Map<string, readonly PreparedAttachment[]>();
const listeners = new Set<() => void>();
let nextId = 1;
/** Bumped by the test reset, so an upload from before it can't touch what comes after. */
let generation = 0;
const timers = new Set<ReturnType<typeof setTimeout>>();

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
 * A chip on `surface` for one upload, shown after the delay and gone once
 * `run` settles, whose cancel aborts the signal `run` is handed.
 */
function track<T>(
  surface: string,
  name: string,
  folder: FolderUploadStage | undefined,
  run: (signal: AbortSignal, patch: (patch: Partial<PendingUpload>) => void) => Promise<T>
): Promise<T> {
  const id = nextId++;
  const controller = new AbortController();
  const entry: PendingUpload = {
    id,
    name,
    fraction: null,
    ...(folder && { folder }),
    visible: false,
    cancel: () => controller.abort(),
  };
  bySurface.set(surface, [...(bySurface.get(surface) ?? EMPTY), entry]);
  emit();
  let settled = false;
  const born = generation;
  const timer = setTimeout(() => {
    timers.delete(timer);
    update(surface, id, { visible: true });
  }, UPLOAD_PROGRESS_DELAY_MS);
  timers.add(timer);
  // A report that lands after the upload settled has no chip left to change.
  const patch = (next: Partial<PendingUpload>) => {
    if (!settled && born === generation) update(surface, id, next);
  };
  let running: Promise<T>;
  try {
    running = run(controller.signal, patch);
  } catch (error) {
    running = Promise.reject(error);
  }
  return running.finally(() => {
    settled = true;
    clearTimeout(timer);
    timers.delete(timer);
    if (born === generation) update(surface, id, null);
  });
}

/**
 * Run one upload under a chip on `surface`. `run` gets the progress callbacks
 * and the signal the chip's cancel button aborts; the chip goes away however
 * the upload ends. A dropped path is only known to be a folder once
 * `materialize` looks at it, so the chip becomes a folder's on its first
 * folder report, keeping its place, its delay and its cancel.
 */
export function trackUpload<T>(
  surface: string,
  name: string,
  run: (
    options: Pick<MaterializeOptions, "onProgress" | "onFolderProgress" | "signal">
  ) => Promise<T>
): Promise<T> {
  return track(surface, name, undefined, (signal, patch) => {
    let lastPercent = -1;
    const onProgress = (fraction: number) => {
      const percent = Math.floor(Math.max(0, Math.min(1, fraction)) * 100);
      if (percent === lastPercent) return;
      lastPercent = percent;
      patch({ fraction: percent / 100 });
    };
    return run({ onProgress, onFolderProgress: folderReporter(null, patch), signal });
  });
}

/** What a folder's chip shows for a report: only what changes its words. */
export function folderUploadStage(progress: FolderMaterializeProgress): FolderUploadStage {
  switch (progress.phase) {
    case "waiting":
    case "reading":
    case "packing":
      return { phase: progress.phase };
    case "sending": {
      const { transferredBytes, totalBytes } = progress;
      if (transferredBytes === null || totalBytes <= 0) return { phase: "sending", percent: null };
      const fraction = Math.max(0, Math.min(1, transferredBytes / totalBytes));
      return { phase: "sending", percent: Math.floor(fraction * 100) };
    }
    case "unpacking": {
      const { filesDone, filesTotal } = progress;
      return {
        phase: "unpacking",
        filesDone: filesDone === null ? null : Math.max(0, Math.min(filesTotal, filesDone)),
        filesTotal,
      };
    }
  }
}

function sameStage(a: FolderUploadStage, b: FolderUploadStage): boolean {
  if (a.phase === "sending" && b.phase === "sending") return a.percent === b.percent;
  if (a.phase === "unpacking" && b.phase === "unpacking") {
    return a.filesDone === b.filesDone && a.filesTotal === b.filesTotal;
  }
  return a.phase === b.phase;
}

/** Follows a folder's reports on its chip, redrawing only when its words change. */
function folderReporter(
  initial: FolderUploadStage | null,
  patch: (patch: Partial<PendingUpload>) => void
): (progress: FolderMaterializeProgress) => void {
  let stage = initial;
  return (progress) => {
    const next = folderUploadStage(progress);
    if (stage !== null && sameStage(stage, next)) return;
    stage = next;
    patch({ folder: next });
  };
}

/**
 * Run one folder send under a chip on `surface`, which follows it through
 * packing, sending and unpacking. A send starts by packing, so that is what
 * the chip says until the first report. The cancel and the delay are a
 * file's: one signal stops the send in whichever phase it is.
 */
export function trackFolderUpload<T>(
  surface: string,
  name: string,
  run: (options: {
    onFolderProgress: (progress: FolderMaterializeProgress) => void;
    signal: AbortSignal;
  }) => Promise<T>
): Promise<T> {
  const stage: FolderUploadStage = { phase: "packing" };
  return track(surface, name, stage, (signal, patch) =>
    run({ onFolderProgress: folderReporter(stage, patch), signal })
  );
}

export function getPendingUploads(surface: string): readonly PendingUpload[] {
  return bySurface.get(surface) ?? EMPTY;
}

/** Whether anything is still uploading for `surface` — shown or not yet. */
export function hasPendingUploads(surface: string): boolean {
  return (bySurface.get(surface)?.length ?? 0) > 0;
}

/**
 * Holds the composer on `surface` from sending while an attachment for it is
 * prepared. An upload settling is not the end of that: a thumbnail still has
 * to come back, from the host in a remote window, before anything is in the
 * draft. The returned release is safe to call more than once.
 */
export function holdComposerSend(surface: string): () => void {
  sendHolds.set(surface, (sendHolds.get(surface) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (sendHolds.get(surface) ?? 1) - 1;
    if (left > 0) sendHolds.set(surface, left);
    else sendHolds.delete(surface);
  };
}

/** Whether a send from the composer on `surface` would leave an attachment out. */
export function isComposerSendHeld(surface: string): boolean {
  return hasPendingUploads(surface) || sendHolds.has(surface);
}

/**
 * Keeps attachments whose draft was sent or replaced before they were ready,
 * for the composer to offer instead of adding them to whatever draft it shows
 * now. Later ones join the end, so they still go in the order they came.
 */
export function holdBackAttachments(
  surface: string,
  attachments: readonly PreparedAttachment[]
): void {
  if (attachments.length === 0) return;
  heldBack.set(surface, [...(heldBack.get(surface) ?? NO_ATTACHMENTS), ...attachments]);
  emit();
}

export function getHeldBackAttachments(surface: string): readonly PreparedAttachment[] {
  return heldBack.get(surface) ?? NO_ATTACHMENTS;
}

/** Hands back everything held back for `surface` and forgets it. */
export function takeHeldBackAttachments(surface: string): readonly PreparedAttachment[] {
  const held = getHeldBackAttachments(surface);
  if (heldBack.delete(surface)) emit();
  return held;
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

export function useHeldBackAttachments(surface: string): readonly PreparedAttachment[] {
  return useSyncExternalStore(
    subscribe,
    () => getHeldBackAttachments(surface),
    () => NO_ATTACHMENTS
  );
}

/** Surface keys, so a composer and the terminal under it never share chips. */
export const composerUploadSurface = (terminalId: string) => `composer:${terminalId}`;
/** Canopy's reply box for a terminal, whose uploads are not its pane composer's to wait on. */
export const isolatedComposerUploadSurface = (terminalId: string) =>
  `isolated-composer:${terminalId}`;
export const terminalUploadSurface = (terminalId: string) => `terminal:${terminalId}`;
export const fileBrowserUploadSurface = (panelId: string) => `file-browser:${panelId}`;

/**
 * What was held back for a panel's composers outlives their remounts, not the
 * panel: closing it lets them go (#16883).
 */
export function dropComposerHeldBack(terminalId: string): void {
  takeHeldBackAttachments(composerUploadSurface(terminalId));
  takeHeldBackAttachments(isolatedComposerUploadSurface(terminalId));
}

/** @internal Tests only. */
export function _resetPendingUploadsForTests(): void {
  generation++;
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  bySurface.clear();
  sendHolds.clear();
  heldBack.clear();
  listeners.clear();
  nextId = 1;
}
