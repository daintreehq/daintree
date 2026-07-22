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
          displayName: manifest.displayName,
          version: manifest.version,
          authors: manifest.authors ?? [],
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
}

/**
 * Queue one `.dntr` archive for install confirmation. Resolves once the preview
 * worker has drained, so callers sequencing several archives keep their order.
 * Never throws — every failure is surfaced to the user instead.
 */
export async function enqueueArchiveInstallIntent(archivePath: string): Promise<void> {
  const resolved = path.resolve(archivePath);
  const dedupeKey = dedupeKeyFor(resolved);
  if (activeKeys.has(dedupeKey)) return;
  activeKeys.add(dedupeKey);
  previewQueue.push({ archivePath: resolved, dedupeKey });

  workerPromise ??= runPreviewWorker().finally(() => {
    workerPromise = null;
  });
  await workerPromise;
}

/** Test-only: reset module state between cases. */
export function _resetArchiveInstallIntentStateForTest(): void {
  previewQueue.length = 0;
  pendingIntents.length = 0;
  activeKeys.clear();
  workerPromise = null;
}
