import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import type {
  AnswerHostPickPayload,
  DownloadPayload,
  DownloadResult,
  FileTransferEvent,
} from "../../../shared/types/ipc/fileTransfer.js";
import type { HostPickRequest } from "../../../shared/types/ipc/hostFiles.js";
import { isValidRemoteHostId, type HostId } from "../../../shared/types/remoteHosts.js";
import { CHANNELS } from "../../ipc/channels.js";
import { setHostFileRequestProxy } from "../../setup/protocols.js";
import { AppError } from "../../utils/errorTypes.js";
import { ensureOwnerOnlyDir } from "../../utils/fs.js";
import { resolveLiveWebContents } from "../../window/webContentsRegistry.js";
import type { LinkSession } from "../link/session.js";
import { registerRemoteService } from "../runtime.js";
import { ClientFileTransport, type DownloadOutcome } from "./ClientFileTransport.js";
import { createHostFileProxy } from "./hostFileProxy.js";
import { HostPickerBridge } from "./HostPickerBridge.js";

/**
 * What the Shell's core handlers (file-transfer, the copytree split, the
 * picker splits) reach through the remote-hosts runtime.
 */
export interface HostFileClient {
  /** "Save locally": a host file into this machine's Downloads folder. */
  download(webContentsId: number, payload: DownloadPayload): Promise<DownloadResult>;
  /** Save a host file into a private temp folder here (for the clipboard, not the user). */
  downloadToTemp(hostId: HostId, hostPath: string, webContentsId: number): Promise<DownloadOutcome>;
  /** Cancel a download by its operation id; false when none is running. */
  cancel(opId: string): boolean;
  pickHostPaths(webContentsId: number, request: HostPickRequest): Promise<string[] | null>;
  answerHostPick(webContentsId: number, payload: AnswerHostPickPayload): void;
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
  /** The host a view is bound to, or null for a local view. */
  hostForView(webContentsId: number): HostId | null;
  sendToView(webContentsId: number, event: FileTransferEvent): void;
  downloadsDir(): string;
  tempDir(): string;
}

const PROGRESS_INTERVAL_MS = 100;
const TEMP_RETENTION_MS = 24 * 60 * 60 * 1000;

function validateDownload(payload: DownloadPayload): DownloadPayload {
  if (
    !payload ||
    typeof payload.hostId !== "string" ||
    !isValidRemoteHostId(payload.hostId) ||
    typeof payload.hostPath !== "string" ||
    payload.hostPath.length === 0 ||
    payload.hostPath.length > 4096 ||
    payload.hostPath.includes("\0") ||
    !path.posix.isAbsolute(payload.hostPath) ||
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
    { promise: Promise<DownloadResult>; controller: AbortController }
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

  return {
    download(webContentsId, rawPayload) {
      const payload = validateDownload(rawPayload);
      const existing = running.get(payload.opId);
      if (existing) return existing.promise;
      requireBoundHost(webContentsId, payload.hostId);
      const controller = new AbortController();
      let lastSent = 0;
      const promise = deps.transport
        .download(payload.hostId, payload.hostPath, {
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
        .finally(() => running.delete(payload.opId));
      running.set(payload.opId, { promise, controller });
      return promise;
    },

    async downloadToTemp(hostId, hostPath, webContentsId) {
      requireBoundHost(webContentsId, hostId);
      const dir = deps.tempDir();
      await ensureOwnerOnlyDir(dir);
      await pruneTempDir(dir);
      return deps.transport.download(hostId, hostPath, {
        webContentsId,
        destinationDir: dir,
      });
    },

    cancel(opId) {
      const entry = running.get(opId);
      if (!entry) return false;
      entry.controller.abort();
      return true;
    },

    pickHostPaths(webContentsId, request) {
      return deps.pickers.pick(webContentsId, request);
    },

    answerHostPick(webContentsId, payload) {
      deps.pickers.answer(webContentsId, payload);
    },
  };
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
    watch(webContentsId, onGone) {
      const wc = resolveLiveWebContents(webContentsId);
      if (!wc) {
        queueMicrotask(onGone);
        return () => {};
      }
      wc.once("destroyed", onGone);
      return () => {
        try {
          wc.removeListener("destroyed", onGone);
        } catch {
          // Already torn down.
        }
      };
    },
  });
  const client = createHostFileClient({
    transport,
    pickers,
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
    setHostFileRequestProxy(createHostFileProxy(transport)),
    registerRemoteService("hostFileClient", client),
  ];
  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
    pickers.dispose();
  };
}
