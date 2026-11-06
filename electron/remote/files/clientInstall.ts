import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import type {
  AnswerHostPickPayload,
  DownloadPayload,
  DownloadResult,
  FileTransferEvent,
  GrantClickedFilePayload,
} from "../../../shared/types/ipc/fileTransfer.js";
import type { HostPickRequest } from "../../../shared/types/ipc/hostFiles.js";
import { isValidRemoteHostId, type HostId } from "../../../shared/types/remoteHosts.js";
import { CHANNELS } from "../../ipc/channels.js";
import { setHostFileRequestProxy } from "../../setup/protocols.js";
import { AppError } from "../../utils/errorTypes.js";
import { ensureOwnerOnlyDir } from "../../utils/fs.js";
import { resolveLiveWebContents } from "../../window/webContentsRegistry.js";
import { onWebContentsDestroyed } from "../../window/webContentsDestroyed.js";
import type { LinkSession } from "../link/session.js";
import { registerRemoteService } from "../runtime.js";
import {
  ClientFileTransport,
  type DownloadOptions,
  type DownloadOutcome,
} from "./ClientFileTransport.js";
import { createHostFileProxy } from "./hostFileProxy.js";
import { HostPickerBridge } from "./HostPickerBridge.js";
import { ViewFileCapabilities } from "./viewCapabilities.js";

/**
 * What the Shell's core handlers (file-transfer, the copytree split, the
 * picker splits) reach through the remote-hosts runtime.
 */
export interface HostFileClient {
  /** "Save locally": a host file into this machine's Downloads folder. */
  download(webContentsId: number, payload: DownloadPayload): Promise<DownloadResult>;
  /** Save a host file into a private temp folder here (for the clipboard, not the user). */
  downloadToTemp(hostId: HostId, hostPath: string, webContentsId: number): Promise<DownloadOutcome>;
  /** The person clicked a link to a host file in this view's terminal: the host lets the view open it. */
  grantClickedFile(webContentsId: number, payload: GrantClickedFilePayload): Promise<void>;
  /** Cancel the view's own download by its operation id; false when it has none running. */
  cancel(opId: string, webContentsId: number): boolean;
  pickHostPaths(webContentsId: number, request: HostPickRequest): Promise<string[] | null>;
  answerHostPick(webContentsId: number, payload: AnswerHostPickPayload): void;
  /**
   * The capability a remote view puts in its host-scoped preview URLs
   * (`…://host/<hostId>/<capability>/load…`), so its previews run under its own
   * endpoint on the host. Null for a view that isn't bound to a remote host.
   */
  previewCapability(webContentsId: number): string | null;
}

declare module "../runtime.js" {
  interface RemoteServices {
    hostFileClient: HostFileClient;
  }
}

export interface EndpointFeed {
  onEndpointOpened(
    listener: (
      hostId: HostId,
      info: { session: LinkSession; webContentsId: number; endpointId: string }
    ) => void
  ): () => void;
  onEndpointClosed(
    listener: (hostId: HostId, info: { webContentsId: number; endpointId: string }) => void
  ): () => void;
}

export interface HostFileClientDeps {
  transport: ClientFileTransport;
  pickers: HostPickerBridge;
  capabilities: ViewFileCapabilities;
  /** The host a view is bound to, or null for a local view. */
  hostForView(webContentsId: number): HostId | null;
  sendToView(webContentsId: number, event: FileTransferEvent): void;
  downloadsDir(): string;
  tempDir(): string;
  /** How long a download whose link dropped waits for its host to come back. */
  reconnectWaitMs?: number;
}

const PROGRESS_INTERVAL_MS = 100;
const TEMP_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RECONNECT_WAIT_MS = 30_000;
/** A download its link cut off is started over at most this many times. */
const MAX_RESTARTS = 2;

function codeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function cancelled(): AppError {
  return new AppError({ code: "CANCELLED", message: "Download cancelled" });
}

function isHostFileRef(
  payload: { hostId: unknown; hostPath: unknown } | null | undefined
): boolean {
  return (
    !!payload &&
    typeof payload.hostId === "string" &&
    isValidRemoteHostId(payload.hostId) &&
    typeof payload.hostPath === "string" &&
    payload.hostPath.length > 0 &&
    payload.hostPath.length <= 4096 &&
    !payload.hostPath.includes("\0") &&
    path.posix.isAbsolute(payload.hostPath)
  );
}

function validateDownload(payload: DownloadPayload): DownloadPayload {
  if (
    !isHostFileRef(payload) ||
    typeof payload.opId !== "string" ||
    payload.opId.length === 0 ||
    payload.opId.length > 128
  ) {
    throw new AppError({ code: "VALIDATION", message: "Invalid download request" });
  }
  return payload;
}

async function pruneTempDir(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - TEMP_RETENTION_MS;
  await Promise.all(
    names.map(async (name) => {
      const target = path.join(dir, name);
      const stat = await fs.lstat(target).catch(() => null);
      if (stat?.isFile() && stat.mtimeMs < cutoff) await fs.rm(target, { force: true });
    })
  );
}

export function createHostFileClient(deps: HostFileClientDeps): HostFileClient {
  const running = new Map<
    string,
    {
      webContentsId: number;
      fingerprint: string;
      promise: Promise<DownloadResult>;
      controller: AbortController;
    }
  >();

  const requireBoundHost = (webContentsId: number, hostId: HostId): void => {
    const bound = deps.hostForView(webContentsId);
    if (bound !== hostId) {
      throw new AppError({
        code: "VALIDATION",
        message: `The view is not attached to host ${hostId}`,
        userMessage: "That file is on another host than this window's.",
      });
    }
  };

  /**
   * A transfer can't pick up mid-file, and a resumed link is a new session: a
   * download its link cut off starts over from the first byte once the view is
   * back on the host, under the same caller promise.
   */
  const downloadAcrossDrops = async (
    hostId: HostId,
    hostPath: string,
    options: DownloadOptions
  ): Promise<DownloadOutcome> => {
    const { webContentsId, signal } = options;
    for (let restarts = 0; ; restarts++) {
      if (signal?.aborted) throw cancelled();
      // A restart goes nowhere once its view has left the host.
      requireBoundHost(webContentsId, hostId);
      try {
        return await deps.transport.download(hostId, hostPath, options);
      } catch (error) {
        if (signal?.aborted) throw cancelled();
        if (codeOf(error) !== "HOST_DISCONNECTED") throw error;
        if (restarts >= MAX_RESTARTS) {
          throw new AppError({
            code: "HOST_DISCONNECTED",
            message: `The link to host ${hostId} dropped ${restarts + 1} times during one download`,
            userMessage: "The connection to the host kept dropping. Try again once it's steady.",
          });
        }
        const waitMs = deps.reconnectWaitMs ?? DEFAULT_RECONNECT_WAIT_MS;
        if (!(await deps.transport.whenReachable(hostId, webContentsId, waitMs, signal))) {
          if (signal?.aborted) throw cancelled();
          throw new AppError({
            code: "HOST_DISCONNECTED",
            message: `Host ${hostId} didn't reconnect within ${waitMs} ms`,
            userMessage: "The host didn't reconnect in time. Try again once it's connected.",
          });
        }
      }
    }
  };

  return {
    download(webContentsId, rawPayload) {
      const payload = validateDownload(rawPayload);
      requireBoundHost(webContentsId, payload.hostId);
      const fingerprint = JSON.stringify([payload.hostId, payload.hostPath]);
      const existing = running.get(payload.opId);
      if (existing) {
        // One id is one download, for the view that started it.
        if (existing.webContentsId !== webContentsId || existing.fingerprint !== fingerprint) {
          return Promise.reject(
            new AppError({
              code: "VALIDATION",
              message: "That operation id belongs to another download",
            })
          );
        }
        return existing.promise;
      }
      const controller = new AbortController();
      let lastSent = 0;
      const promise = downloadAcrossDrops(payload.hostId, payload.hostPath, {
        webContentsId,
        destinationDir: deps.downloadsDir(),
        signal: controller.signal,
        onProgress: (transferredBytes, totalBytes) => {
          const now = Date.now();
          if (transferredBytes < totalBytes && now - lastSent < PROGRESS_INTERVAL_MS) return;
          lastSent = now;
          deps.sendToView(webContentsId, {
            type: "progress",
            opId: payload.opId,
            transferredBytes,
            totalBytes,
          });
        },
      })
        .then((outcome) => ({ localPath: outcome.localPath, bytes: outcome.bytes }))
        .finally(() => {
          if (running.get(payload.opId)?.promise === promise) running.delete(payload.opId);
        });
      running.set(payload.opId, { webContentsId, fingerprint, promise, controller });
      return promise;
    },

    async downloadToTemp(hostId, hostPath, webContentsId) {
      requireBoundHost(webContentsId, hostId);
      const dir = deps.tempDir();
      await ensureOwnerOnlyDir(dir);
      await pruneTempDir(dir);
      return downloadAcrossDrops(hostId, hostPath, { webContentsId, destinationDir: dir });
    },

    async grantClickedFile(webContentsId, payload) {
      if (!isHostFileRef(payload)) {
        throw new AppError({ code: "VALIDATION", message: "Invalid file" });
      }
      requireBoundHost(webContentsId, payload.hostId);
      await deps.transport.grantClicked(payload.hostId, payload.hostPath, webContentsId);
    },

    cancel(opId, webContentsId) {
      const entry = running.get(opId);
      if (!entry || entry.webContentsId !== webContentsId) return false;
      entry.controller.abort();
      return true;
    },

    pickHostPaths(webContentsId, request) {
      return deps.pickers.pick(webContentsId, request);
    },

    answerHostPick(webContentsId, payload) {
      deps.pickers.answer(webContentsId, payload);
    },

    previewCapability(webContentsId) {
      if (deps.hostForView(webContentsId) === null) return null;
      return deps.capabilities.capabilityFor(webContentsId);
    },
  };
}

function watchView(webContentsId: number, onGone: () => void): () => void {
  const wc = resolveLiveWebContents(webContentsId);
  if (!wc) {
    queueMicrotask(onGone);
    return () => {};
  }
  return onWebContentsDestroyed(wc, onGone);
}

/**
 * Shell side: serve remote windows' host-scoped preview URLs, downloads and
 * host pickers. `feed` is the remote-hosts client's endpoint lifecycle.
 */
export function installHostFileClient(
  feed: EndpointFeed,
  hostForView: (webContentsId: number) => HostId | null
): () => void {
  const transport = new ClientFileTransport();
  const pickers = new HostPickerBridge({
    send(webContentsId, event) {
      const wc = resolveLiveWebContents(webContentsId);
      if (!wc) return false;
      try {
        wc.send(CHANNELS.FILE_TRANSFER_EVENT, event);
        return true;
      } catch {
        return false;
      }
    },
    watch: watchView,
  });
  const capabilities = new ViewFileCapabilities(watchView);
  const client = createHostFileClient({
    transport,
    pickers,
    capabilities,
    hostForView,
    sendToView(webContentsId, event) {
      try {
        resolveLiveWebContents(webContentsId)?.send(CHANNELS.FILE_TRANSFER_EVENT, event);
      } catch {
        // A view mid-teardown.
      }
    },
    downloadsDir: () => app.getPath("downloads"),
    tempDir: () => path.join(app.getPath("temp"), "daintree-host-files"),
  });

  const disposers = [
    feed.onEndpointOpened((hostId, info) => transport.noteEndpointOpened(hostId, info)),
    feed.onEndpointClosed((hostId, info) => transport.noteEndpointClosed(hostId, info)),
    setHostFileRequestProxy(
      createHostFileProxy(transport, {
        viewForCapability: (capability) => capabilities.viewFor(capability),
        hostForView,
      })
    ),
    registerRemoteService("hostFileClient", client),
  ];
  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
    pickers.dispose();
    capabilities.dispose();
  };
}
