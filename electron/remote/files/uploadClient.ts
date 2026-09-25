import fs from "node:fs/promises";
import path from "node:path";
import type {
  FileTransferEvent,
  TransferDestination,
  UploadBytesPayload,
  UploadLocalFilePayload,
  UploadResult,
} from "../../../shared/types/ipc/fileTransfer.js";
import {
  isValidRemoteHostId,
  UPLOAD_REFUSE_BYTES,
  type HostId,
} from "../../../shared/types/remoteHosts.js";
import { CHANNELS } from "../../ipc/channels.js";
import { AppError } from "../../utils/errorTypes.js";
import { resolveLiveWebContents } from "../../window/webContentsRegistry.js";
import { bytesTransferSource, fileTransferSource, type TransferSource } from "../link/transfer.js";
import { getRemoteService, registerRemoteService } from "../runtime.js";
import { ClientUploadTransport } from "./ClientUploadTransport.js";
import type { EndpointFeed } from "./clientInstall.js";

/**
 * What the Shell's file-transfer handler and the clipboard split reach
 * through the remote-hosts runtime to put local files on a host.
 */
export interface HostUploadClient {
  uploadLocalFile(webContentsId: number, payload: UploadLocalFilePayload): Promise<UploadResult>;
  uploadBytes(webContentsId: number, payload: UploadBytesPayload): Promise<UploadResult>;
  /** A pasted image, captured on this machine, into the host inbox's clipboard folder. */
  uploadClipboardImage(webContentsId: number, hostId: HostId, png: Uint8Array): Promise<string>;
  /** Cancel an upload by its operation id; false when none is running. */
  cancel(opId: string): boolean;
}

declare module "../runtime.js" {
  interface RemoteServices {
    hostUploadClient: HostUploadClient;
  }
}

export interface HostUploadClientDeps {
  transport: Pick<ClientUploadTransport, "upload">;
  hostForView(webContentsId: number): HostId | null;
  hostLabel(hostId: HostId): string;
  sendToView(webContentsId: number, event: FileTransferEvent): void;
  /** This machine, as messages name it ("This Mac"). */
  localLabel: string;
  maxUploadBytes?: number;
}

const PROGRESS_INTERVAL_MS = 100;
const MAX_BYTES_PAYLOAD = 64 * 1024 * 1024;
const MAX_NAME_LENGTH = 1024;

function invalid(message: string): AppError {
  return new AppError({ code: "VALIDATION", message });
}

function validateCommon(payload: {
  hostId?: unknown;
  opId?: unknown;
  destination?: unknown;
}): TransferDestination {
  if (typeof payload.hostId !== "string" || !isValidRemoteHostId(payload.hostId)) {
    throw invalid("Invalid host");
  }
  if (typeof payload.opId !== "string" || payload.opId.length === 0 || payload.opId.length > 128) {
    throw invalid("Invalid operation id");
  }
  const destination = payload.destination as TransferDestination | undefined;
  if (destination?.kind === "inbox") {
    if (destination.bucket !== "clipboard" && destination.bucket !== "files") {
      throw invalid("Invalid inbox bucket");
    }
    return { kind: "inbox", bucket: destination.bucket };
  }
  if (destination?.kind === "worktree") {
    const directory = destination.directory;
    if (
      typeof directory !== "string" ||
      !path.posix.isAbsolute(directory) ||
      directory.length > 4096 ||
      directory.includes("\0")
    ) {
      throw invalid("Invalid destination folder");
    }
    return { kind: "worktree", directory, overwrite: destination.overwrite === true };
  }
  throw invalid("Invalid destination");
}

function localBaseName(localPath: string): string {
  return path.basename(localPath) || "file";
}

export function createHostUploadClient(deps: HostUploadClientDeps): HostUploadClient {
  const running = new Map<
    string,
    { promise: Promise<UploadResult>; controller: AbortController }
  >();
  const maxBytes = deps.maxUploadBytes ?? UPLOAD_REFUSE_BYTES;

  const requireBoundHost = (webContentsId: number, hostId: HostId): void => {
    if (deps.hostForView(webContentsId) !== hostId) {
      const bound = deps.hostForView(webContentsId);
      throw new AppError({
        code: "VALIDATION",
        message: `The view is not attached to host ${hostId}`,
        userMessage: bound
          ? `This window is on ${deps.hostLabel(bound)}, not ${deps.hostLabel(hostId)}.`
          : `This window isn't attached to ${deps.hostLabel(hostId)}.`,
      });
    }
  };

  const tooLarge = (name: string, hostId: HostId) =>
    new AppError({
      code: "PAYLOAD_TOO_LARGE",
      message: "The file is larger than the upload limit",
      userMessage: `${name} is too large to send to ${deps.hostLabel(hostId)}.`,
    });

  const run = (
    webContentsId: number,
    hostId: HostId,
    opId: string,
    name: string,
    destination: TransferDestination,
    openSource: () => Promise<TransferSource>
  ): Promise<UploadResult> => {
    const existing = running.get(opId);
    if (existing) return existing.promise;
    const controller = new AbortController();
    let lastSent = 0;
    const promise = (async () => {
      const source = await openSource();
      try {
        if (controller.signal.aborted) {
          throw new AppError({ code: "CANCELLED", message: "Upload cancelled" });
        }
        return await deps.transport.upload(hostId, source, {
          webContentsId,
          hostLabel: deps.hostLabel(hostId),
          name,
          destination,
          signal: controller.signal,
          onProgress: (transferredBytes, totalBytes) => {
            const now = Date.now();
            if (transferredBytes < totalBytes && now - lastSent < PROGRESS_INTERVAL_MS) return;
            lastSent = now;
            deps.sendToView(webContentsId, {
              type: "progress",
              opId,
              transferredBytes,
              totalBytes,
            });
          },
        });
      } finally {
        await Promise.resolve(source.close?.()).catch(() => {});
      }
    })().finally(() => running.delete(opId));
    running.set(opId, { promise, controller });
    return promise;
  };

  return {
    async uploadLocalFile(webContentsId, payload) {
      const destination = validateCommon(payload ?? {});
      const localPath = payload.localPath;
      if (
        typeof localPath !== "string" ||
        !path.isAbsolute(localPath) ||
        localPath.includes("\0")
      ) {
        throw invalid("Invalid local path");
      }
      requireBoundHost(webContentsId, payload.hostId);
      const name = localBaseName(localPath);
      const couldNotRead = () =>
        new AppError({
          code: "INVALID_PATH",
          message: "The local file could not be read",
          userMessage: `Couldn't read ${name} on ${deps.localLabel}.`,
        });
      return run(webContentsId, payload.hostId, payload.opId, name, destination, async () => {
        const stat = await fs.stat(localPath).catch(() => null);
        if (!stat) throw couldNotRead();
        if (stat.isDirectory()) {
          throw new AppError({
            code: "UNSUPPORTED",
            message: "Folders can't be uploaded",
            userMessage: `${name} is a folder. Sending folders to ${deps.hostLabel(payload.hostId)} isn't available yet.`,
          });
        }
        if (!stat.isFile()) throw couldNotRead();
        if (stat.size > maxBytes) throw tooLarge(name, payload.hostId);
        try {
          return await fileTransferSource(localPath);
        } catch {
          throw couldNotRead();
        }
      });
    },

    async uploadBytes(webContentsId, payload) {
      const destination = validateCommon(payload ?? {});
      if (!(payload.bytes instanceof Uint8Array)) throw invalid("Bytes must be a Uint8Array");
      if (
        typeof payload.name !== "string" ||
        payload.name.length === 0 ||
        payload.name.length > MAX_NAME_LENGTH
      ) {
        throw invalid("Invalid file name");
      }
      requireBoundHost(webContentsId, payload.hostId);
      if (payload.bytes.byteLength > Math.min(maxBytes, MAX_BYTES_PAYLOAD)) {
        throw tooLarge(payload.name, payload.hostId);
      }
      const bytes = payload.bytes;
      return run(webContentsId, payload.hostId, payload.opId, payload.name, destination, async () =>
        bytesTransferSource(bytes)
      );
    },

    async uploadClipboardImage(webContentsId, hostId, png) {
      requireBoundHost(webContentsId, hostId);
      const result = await deps.transport.upload(hostId, bytesTransferSource(png), {
        webContentsId,
        hostLabel: deps.hostLabel(hostId),
        name: "clipboard.png",
        destination: { kind: "inbox", bucket: "clipboard" },
      });
      return result.hostPath;
    },

    cancel(opId) {
      const entry = running.get(opId);
      if (!entry) return false;
      entry.controller.abort();
      return true;
    },
  };
}

function hostLabelFor(hostId: HostId): string {
  const entry = getRemoteService("remoteHostsClient")
    ?.list()
    .find((candidate) => candidate.descriptor.id === hostId);
  return entry?.descriptor.name || hostId;
}

/**
 * Shell side: upload local files for remote windows. `feed` is the
 * remote-hosts client's endpoint lifecycle.
 */
export function installHostUploadClient(
  feed: EndpointFeed,
  hostForView: (webContentsId: number) => HostId | null
): () => void {
  const transport = new ClientUploadTransport();
  const client = createHostUploadClient({
    transport,
    hostForView,
    hostLabel: hostLabelFor,
    localLabel: process.platform === "darwin" ? "This Mac" : "this computer",
    sendToView(webContentsId, event) {
      try {
        resolveLiveWebContents(webContentsId)?.send(CHANNELS.FILE_TRANSFER_EVENT, event);
      } catch {
        // A view mid-teardown.
      }
    },
  });
  const disposers = [
    feed.onEndpointOpened((hostId, info) => transport.noteEndpointOpened(hostId, info)),
    feed.onEndpointClosed((hostId, info) => transport.noteEndpointClosed(hostId, info)),
    registerRemoteService("hostUploadClient", client),
  ];
  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
  };
}
