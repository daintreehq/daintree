import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  FileTransferEvent,
  LocalFileStat,
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
 *
 * A remote window's page runs code the host supplied (its plugins' views), so
 * a local path from the page is never enough to send a file. Only a path the
 * Shell itself saw the person choose in that same view can be read: one the
 * preload resolved from a real dropped or pasted File, or one the attach
 * dialog returned. Those are recorded here per view ({@link grantLocalSources})
 * and everything else is refused.
 */
export interface HostUploadClient {
  uploadLocalFile(webContentsId: number, payload: UploadLocalFilePayload): Promise<UploadResult>;
  uploadBytes(webContentsId: number, payload: UploadBytesPayload): Promise<UploadResult>;
  /**
   * A pasted image, captured on this machine, into the host inbox's clipboard
   * folder. With the view's operation id it reports progress and can be
   * cancelled like any other upload.
   */
  uploadClipboardImage(
    webContentsId: number,
    hostId: HostId,
    png: Uint8Array,
    opId?: string
  ): Promise<string>;
  /** Cancel the view's own upload by its operation id; false when it has none running. */
  cancel(opId: string, webContentsId: number): boolean;
  /**
   * Local files the person chose in this remote-bound view (a drop or paste
   * the preload resolved, an attach dialog's answer). Ignored for a view that
   * isn't attached to a host.
   */
  grantLocalSources(webContentsId: number, paths: unknown): void;
  /** Size and kind of a local file this view was granted, or null when there is none. */
  statLocalSource(webContentsId: number, localPath: unknown): Promise<LocalFileStat | null>;
}

declare module "../runtime.js" {
  interface RemoteServices {
    hostUploadClient: HostUploadClient;
  }
}

export interface HostUploadClientDeps {
  transport: Pick<ClientUploadTransport, "upload"> &
    Partial<Pick<ClientUploadTransport, "whenReachable">>;
  hostForView(webContentsId: number): HostId | null;
  hostLabel(hostId: HostId): string;
  sendToView(webContentsId: number, event: FileTransferEvent): void;
  /** This machine, as messages name it ("This Mac"). */
  localLabel: string;
  maxUploadBytes?: number;
  /** How long a granted local file stays sendable from its view. */
  grantTtlMs?: number;
  /** How long an upload whose answer was lost waits for its host to come back. */
  reconnectWaitMs?: number;
}

const PROGRESS_INTERVAL_MS = 100;
const MAX_BYTES_PAYLOAD = 64 * 1024 * 1024;
const MAX_NAME_LENGTH = 1024;
const MAX_PATH_LENGTH = 4096;
const DEFAULT_GRANT_TTL_MS = 30 * 60_000;
const MAX_GRANTS_PER_VIEW = 1_000;
const MAX_GRANT_VIEWS = 64;
const MAX_GRANT_BATCH = 1_000;
const DEFAULT_RECONNECT_WAIT_MS = 30_000;
/** Answers lost in transit are reconciled with the host at most this many times. */
const MAX_RECONCILE_ATTEMPTS = 2;
const REPLACE_TOKEN = /^[0-9a-f]{32}$/;
const CLIPBOARD_DESTINATION: TransferDestination = { kind: "inbox", bucket: "clipboard" };
/** Cancels that arrived before their upload started, kept this long for it to catch up. */
const EARLY_CANCEL_TTL_MS = 60_000;
const MAX_EARLY_CANCELS = 256;

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
    const replaceToken = destination.replaceToken;
    if (replaceToken === undefined) return { kind: "worktree", directory };
    if (typeof replaceToken !== "string" || !REPLACE_TOKEN.test(replaceToken)) {
      throw invalid("Invalid replace token");
    }
    return { kind: "worktree", directory, replaceToken };
  }
  throw invalid("Invalid destination");
}

function localBaseName(localPath: string): string {
  return path.basename(localPath) || "file";
}

function isLocalPath(candidate: unknown): candidate is string {
  return (
    typeof candidate === "string" &&
    candidate.length <= MAX_PATH_LENGTH &&
    path.isAbsolute(candidate) &&
    !candidate.includes("\0")
  );
}

function codeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

export function createHostUploadClient(deps: HostUploadClientDeps): HostUploadClient {
  const running = new Map<
    string,
    {
      webContentsId: number;
      fingerprint: string;
      promise: Promise<UploadResult>;
      controller: AbortController;
    }
  >();
  /** Per operation id, the view whose cancel arrived first, and until when it counts. */
  const earlyCancels = new Map<string, { webContentsId: number; until: number }>();
  const noteEarlyCancel = (opId: string, webContentsId: number): void => {
    if (typeof opId !== "string" || opId.length === 0 || opId.length > 128) return;
    const now = Date.now();
    for (const [id, entry] of earlyCancels) {
      if (entry.until <= now || earlyCancels.size >= MAX_EARLY_CANCELS) earlyCancels.delete(id);
    }
    earlyCancels.set(opId, { webContentsId, until: now + EARLY_CANCEL_TTL_MS });
  };
  const takeEarlyCancel = (opId: string, webContentsId: number): boolean => {
    const entry = earlyCancels.get(opId);
    if (!entry) return false;
    earlyCancels.delete(opId);
    return entry.webContentsId === webContentsId && entry.until > Date.now();
  };
  const maxBytes = deps.maxUploadBytes ?? UPLOAD_REFUSE_BYTES;
  const grantTtlMs = deps.grantTtlMs ?? DEFAULT_GRANT_TTL_MS;
  /** Per view, the local files the person chose there, and until when. */
  const grants = new Map<number, Map<string, number>>();

  const isGranted = (webContentsId: number, localPath: string): boolean => {
    const forView = grants.get(webContentsId);
    const expiresAt = forView?.get(localPath);
    if (forView === undefined || expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      forView.delete(localPath);
      return false;
    }
    return true;
  };

  const notGranted = (localPath: string) =>
    new AppError({
      code: "PERMISSION",
      message: "The local file was not chosen in this window",
      userMessage: `Couldn't send ${localBaseName(localPath)}: it wasn't dropped, pasted or attached in this window.`,
    });

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
    source: string,
    name: string,
    destination: TransferDestination,
    openSource: () => Promise<TransferSource>
  ): Promise<UploadResult> => {
    // One id is one upload: the same view asking again for the same thing
    // shares it, and anything else claiming the id is refused.
    const fingerprint = JSON.stringify([hostId, source, destination]);
    const existing = running.get(opId);
    if (existing) {
      if (existing.webContentsId !== webContentsId || existing.fingerprint !== fingerprint) {
        return Promise.reject(invalid("That operation id belongs to another upload"));
      }
      return existing.promise;
    }
    const controller = new AbortController();
    if (takeEarlyCancel(opId, webContentsId)) controller.abort();
    let lastSent = 0;
    const attempt = async (): Promise<UploadResult> => {
      const opened = await openSource();
      try {
        if (controller.signal.aborted) {
          throw new AppError({ code: "CANCELLED", message: "Upload cancelled" });
        }
        return await deps.transport.upload(hostId, opened, {
          webContentsId,
          opId,
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
        await Promise.resolve(opened.close?.()).catch(() => {});
      }
    };
    const promise = (async () => {
      let reconciled = 0;
      for (;;) {
        try {
          return await attempt();
        } catch (error) {
          // The file may have landed and only the answer was lost. Ask the host
          // again under the same id once it is reachable: it answers from what
          // it recorded instead of placing (or replacing) the file a second time.
          if (
            codeOf(error) !== "OUTCOME_UNKNOWN" ||
            controller.signal.aborted ||
            reconciled >= MAX_RECONCILE_ATTEMPTS ||
            !deps.transport.whenReachable ||
            !(await deps.transport.whenReachable(
              hostId,
              webContentsId,
              deps.reconnectWaitMs ?? DEFAULT_RECONNECT_WAIT_MS,
              controller.signal
            ))
          ) {
            throw error;
          }
          reconciled += 1;
        }
      }
    })().finally(() => {
      if (running.get(opId)?.promise === promise) running.delete(opId);
    });
    running.set(opId, { webContentsId, fingerprint, promise, controller });
    return promise;
  };

  return {
    async uploadLocalFile(webContentsId, payload) {
      const destination = validateCommon(payload ?? {});
      const localPath = payload.localPath;
      if (!isLocalPath(localPath)) throw invalid("Invalid local path");
      requireBoundHost(webContentsId, payload.hostId);
      if (!isGranted(webContentsId, localPath)) throw notGranted(localPath);
      const name = localBaseName(localPath);
      const couldNotRead = () =>
        new AppError({
          code: "INVALID_PATH",
          message: "The local file could not be read",
          userMessage: `Couldn't read ${name} on ${deps.localLabel}.`,
        });
      const source = `file:${localPath}`;
      return run(
        webContentsId,
        payload.hostId,
        payload.opId,
        source,
        name,
        destination,
        async () => {
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
        }
      );
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
      const digest = crypto.createHash("sha256").update(bytes).digest("hex");
      const source = `bytes:${payload.name}:${digest}`;
      return run(
        webContentsId,
        payload.hostId,
        payload.opId,
        source,
        payload.name,
        destination,
        async () => bytesTransferSource(bytes)
      );
    },

    async uploadClipboardImage(webContentsId, hostId, png, opId) {
      const operation = opId ?? `clipboard-${crypto.randomUUID()}`;
      validateCommon({ hostId, opId: operation, destination: CLIPBOARD_DESTINATION });
      requireBoundHost(webContentsId, hostId);
      const digest = crypto.createHash("sha256").update(png).digest("hex");
      const result = await run(
        webContentsId,
        hostId,
        operation,
        `clipboard:${digest}`,
        "clipboard.png",
        CLIPBOARD_DESTINATION,
        async () => bytesTransferSource(png)
      );
      return result.hostPath;
    },

    cancel(opId, webContentsId) {
      const entry = running.get(opId);
      if (!entry) {
        // The cancel can overtake its own upload, which is still on its way
        // here: remember it for that view, so the upload starts cancelled.
        noteEarlyCancel(opId, webContentsId);
        return false;
      }
      // Only the view that started an upload can stop it.
      if (entry.webContentsId !== webContentsId) return false;
      entry.controller.abort();
      return true;
    },

    grantLocalSources(webContentsId, paths) {
      if (deps.hostForView(webContentsId) === null) return;
      if (!Array.isArray(paths) || paths.length > MAX_GRANT_BATCH) return;
      let forView = grants.get(webContentsId);
      if (!forView) {
        while (grants.size >= MAX_GRANT_VIEWS) {
          const oldest = grants.keys().next().value;
          if (oldest === undefined) break;
          grants.delete(oldest);
        }
        forView = new Map();
        grants.set(webContentsId, forView);
      }
      const expiresAt = Date.now() + grantTtlMs;
      for (const candidate of paths) {
        if (!isLocalPath(candidate)) continue;
        forView.delete(candidate);
        forView.set(candidate, expiresAt);
      }
      const now = Date.now();
      for (const [granted, until] of forView) {
        if (forView.size <= MAX_GRANTS_PER_VIEW && until > now) continue;
        forView.delete(granted);
      }
    },

    async statLocalSource(webContentsId, localPath) {
      if (!isLocalPath(localPath)) throw invalid("Invalid local path");
      if (!isGranted(webContentsId, localPath)) throw notGranted(localPath);
      const stat = await fs.stat(localPath).catch(() => null);
      if (!stat) return null;
      return { size: stat.size, isDirectory: stat.isDirectory() };
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
