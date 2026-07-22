import path from "path";
import { randomUUID } from "node:crypto";
import { broadcastToRenderer } from "../ipc/utils.js";
import { CHANNELS } from "../ipc/channels.js";
import { appendPendingError } from "../ipc/pendingErrorsStore.js";
import { getAllAppWebContents } from "../window/webContentsRegistry.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { getPaintedPrimaryWebContents, registerPaintedFlushListener } from "./deepLinkInstall.js";
import type { MainProcessToastPayload } from "../../shared/types/ipc/maps.js";
import type { ErrorRecord } from "../../shared/types/ipc/errors.js";
import type { PluginArchiveInstallIntent } from "../../shared/types/plugin.js";

/**
 * Consent gate for `.dntr` archives the OS hands us (#11280).
 *
 * Both double-click paths — macOS `open-file` and the Windows/Linux argv scan —
 * funnel here instead of calling the installer. Each archive's manifest is read
 * without extracting it, then pushed to the primary window as a preview so the
 * user approves real identity and capabilities before anything is written. The
 * renderer completes an approved install through `plugin.installFromPath`,
 * which re-runs every trust gate in main.
 *
 * Nothing here writes to disk, and no failure path falls through to an install.
 */

interface PreviewJob {
  archivePath: string;
  dedupeKey: string;
}

// Archives whose manifest hasn't been read yet, in arrival order.
const previewQueue: PreviewJob[] = [];
// Previewed intents waiting for a painted primary window, in arrival order.
// FIFO rather than latest-wins: a deep link is one discrete action, but a
// multi-select double-click is N archives that each need their own decision.
const pendingIntents: PluginArchiveInstallIntent[] = [];
// Paths currently previewing or awaiting delivery. Suppresses the duplicate
// events the OS can emit for one double-click; released once the intent reaches
// a renderer (or its preview fails), so re-opening the same file later still
// prompts.
const activeKeys = new Set<string>();
let workerPromise: Promise<void> | null = null;

// Windows paths are case-insensitive, so only the dedupe key is folded — the
// path itself stays verbatim for the installer.
function dedupeKeyFor(archivePath: string): string {
  return process.platform === "win32" ? archivePath.toLowerCase() : archivePath;
}

function hasLiveRenderer(): boolean {
  return getAllAppWebContents().some((wc) => !wc.isDestroyed());
}

function showToast(payload: MainProcessToastPayload): void {
  broadcastToRenderer(CHANNELS.NOTIFICATION_SHOW_TOAST, payload);
}

/**
 * Surface a preview failure. On a cold launch the drain can finish before the
 * first window paints, and on macOS the app stays alive with no windows — in
 * both cases `broadcastToRenderer` has no targets and the toast is dropped. So
 * when no renderer is live, persist via `appendPendingError` (the durable inbox
 * `globalErrorHandlers` uses for pre-ready fatals) so it surfaces on the next
 * renderer mount instead of vanishing.
 */
function surfaceArchiveError(fileName: string, detail: string): void {
  const message = `Couldn't read "${fileName}": ${detail}. Nothing was installed.`;
  // Reporting is best-effort and must never throw: an exception here would
  // reject the shared worker promise, strand every job still queued behind this
  // one, and surface as an unhandled rejection in the fire-and-forget callers.
  try {
    if (hasLiveRenderer()) {
      showToast({ type: "error", title: "Plugin install blocked", message });
      return;
    }
    const record: ErrorRecord = {
      id: `plugin-archive-preview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      type: "validation",
      message,
      source: "main-process",
      retryability: "none",
      dismissed: false,
    };
    appendPendingError(record);
  } catch (err) {
    console.error("[MAIN] Failed to surface a plugin-archive preview error:", err);
  }
}

// Manifest strings are attacker-controlled and only bounded by the archive size
// cap, so clamp what crosses IPC into the dialog. The full value still reaches
// the installer, which does its own validation.
const PREVIEW_TEXT_MAX = 200;

function clampPreviewText(value: string): string {
  return value.length > PREVIEW_TEXT_MAX ? `${value.slice(0, PREVIEW_TEXT_MAX)}…` : value;
}

/**
 * Deliver previewed intents to the primary window, oldest first. Stops at the
 * head the moment there is no painted primary or a send throws, so a teardown
 * race re-delivers on the next paint rather than dropping an archive. Delivery
 * targets the primary only (lesson #9533): broadcasting would raise the same
 * prompt in every window and risk concurrent installs of one file.
 */
export function flushArchiveInstallIntents(): void {
  while (pendingIntents.length > 0) {
    const webContents = getPaintedPrimaryWebContents();
    if (!webContents) return;
    const next = pendingIntents[0]!;
    try {
      webContents.send(CHANNELS.EVENTS_PUSH, {
        name: "plugin:archive-install-intent",
        payload: next,
      });
    } catch {
      return;
    }
    pendingIntents.shift();
    activeKeys.delete(dedupeKeyFor(next.archivePath));
  }
}

registerPaintedFlushListener(flushArchiveInstallIntents);

/**
 * Read each queued archive's manifest, one at a time. Serial so a slow first
 * manifest can't be overtaken by a later archive — arrival order is what the
 * user sees in the confirmation queue. `PluginArchive` is imported lazily to
 * keep `yauzl` and the manifest schema off the startup path (#9285).
 */
async function runPreviewWorker(): Promise<void> {
  try {
    while (previewQueue.length > 0) {
      const job = previewQueue.shift()!;
      const fileName = path.basename(job.archivePath);
      try {
        const { readArchiveManifest } = await import("../services/PluginArchive.js");
        const manifest = await readArchiveManifest(job.archivePath);
        pendingIntents.push({
          intentId: randomUUID(),
          archivePath: job.archivePath,
          archiveFileName: fileName,
          manifest: {
            name: manifest.name,
            displayName: manifest.displayName && clampPreviewText(manifest.displayName),
            version: manifest.version,
            authors: (manifest.authors ?? []).map((author) => ({
              ...author,
              name: clampPreviewText(author.name),
            })),
            capabilities: manifest.capabilities ?? [],
          },
        });
        flushArchiveInstallIntents();
      } catch (err) {
        // Fail closed: an unreadable, oversized, or schema-invalid archive never
        // reaches a renderer, so there is no path the user could approve. The
        // next job still runs — one bad file in a multi-select shouldn't strand
        // the rest.
        activeKeys.delete(job.dedupeKey);
        surfaceArchiveError(fileName, formatErrorMessage(err, "it isn't a valid plugin archive"));
      }
    }
  } finally {
    // Cleared here, not in a `.finally()` on the returned promise: that runs a
    // microtask later, and a job appended in the gap would see a non-null
    // `workerPromise`, start no worker, and sit unprocessed until an unrelated
    // archive arrived. Nothing awaits between the loop test and this line, so
    // an enqueue always either joins the running loop or starts a fresh one.
    workerPromise = null;
  }
}

/** Resolve, dedupe and queue one path. Returns false when it was a duplicate. */
function queueJob(archivePath: string): boolean {
  const resolved = path.resolve(archivePath);
  const dedupeKey = dedupeKeyFor(resolved);
  if (activeKeys.has(dedupeKey)) return false;
  activeKeys.add(dedupeKey);
  previewQueue.push({ archivePath: resolved, dedupeKey });
  return true;
}

/**
 * Queue a batch of `.dntr` archives for install confirmation. The whole batch is
 * appended before the worker is awaited, so a live event arriving mid-drain
 * queues *behind* the batch instead of splitting it — the prompts then follow
 * the order the archives actually arrived in.
 *
 * Never throws — every failure is surfaced to the user instead.
 */
export async function enqueueArchiveInstallIntents(archivePaths: readonly string[]): Promise<void> {
  let queued = false;
  for (const archivePath of archivePaths) {
    if (queueJob(archivePath)) queued = true;
  }
  if (!queued) return;
  const pending = (workerPromise ??= runPreviewWorker());
  await pending;
}

/** Queue a single `.dntr` archive for install confirmation. */
export function enqueueArchiveInstallIntent(archivePath: string): Promise<void> {
  return enqueueArchiveInstallIntents([archivePath]);
}

/** Test-only: reset module state between cases. */
export function _resetArchiveInstallIntentStateForTest(): void {
  previewQueue.length = 0;
  pendingIntents.length = 0;
  activeKeys.clear();
  workerPromise = null;
}
