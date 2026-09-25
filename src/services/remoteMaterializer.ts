import type {
  HostId,
  MaterializeFn,
  MaterializeOptions,
  MaterializeResult,
  MaterializeSource,
} from "@shared/types/remoteHosts";
import {
  LOCAL_HOST_ID,
  UPLOAD_CONFIRM_BYTES,
  UPLOAD_REFUSE_BYTES,
} from "@shared/types/remoteHosts";
import type {
  FileTransferEvent,
  LocalFileStat,
  TransferDestination,
  UploadResult,
} from "@shared/types/ipc/fileTransfer";
import { formatBytes } from "@/lib/formatBytes";
import { notify } from "@/lib/notify";
import { isMac } from "@/lib/platform";
import { getHostPlatformInfo } from "@/hooks/useHostPlatform";
import { mintOperationId } from "@/clients/operationsClient";
import { askUploadQuestion } from "@/components/Terminal/uploads/uploadConfirm";

/**
 * `materialize` for a window attached to a remote host: whatever is dropped,
 * pasted or attached here becomes a file on the host, and the host path is
 * what gets inserted. Local files and bytes are uploaded into the host inbox
 * (or, for Add to project, into a folder of the project); a pasted image is
 * captured here and uploaded by the clipboard split; a path from this
 * window's own file browser is already on the host and passes through.
 *
 * Every failure names the host or this machine, and is reported once here;
 * nothing is inserted for a source that failed.
 */

export interface RemoteMaterializerDeps {
  hostId: HostId;
  hostLabel(): string;
  /** This machine, as messages name it ("This Mac"). */
  localLabel: string;
  fileTransfer: {
    statLocalFile(payload: { localPath: string }): Promise<LocalFileStat | null>;
    uploadLocalFile(payload: {
      hostId: HostId;
      localPath: string;
      destination: TransferDestination;
      opId: string;
    }): Promise<UploadResult>;
    uploadBytes(payload: {
      hostId: HostId;
      bytes: Uint8Array;
      name: string;
      mimeType: string | null;
      destination: TransferDestination;
      opId: string;
    }): Promise<UploadResult>;
    cancel(payload: { opId: string }): Promise<void>;
    onEvent(callback: (event: FileTransferEvent) => void): () => void;
  };
  saveClipboardImage(): Promise<{ filePath: string; thumbnailDataUrl: string }>;
  confirmLargeUpload(request: { name: string; bytes: number; hostLabel: string }): Promise<boolean>;
  confirmReplace(request: { name: string; folder: string; hostLabel: string }): Promise<boolean>;
  reportFailure(failure: { title: string; message: string }): void;
  mintOperationId(): string;
}

export class MaterializeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly userMessage: string = message
  ) {
    super(message);
    this.name = "MaterializeError";
  }
}

function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function dirname(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx > 0 ? p.slice(0, idx) : "/";
}

function codeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function userMessageOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("userMessage" in error)) return null;
  return typeof error.userMessage === "string" && error.userMessage ? error.userMessage : null;
}

function cancelled(): MaterializeError {
  return new MaterializeError("CANCELLED", "Upload cancelled");
}

export function isCancelledMaterialize(error: unknown): boolean {
  return codeOf(error) === "CANCELLED";
}

export function createRemoteMaterializer(deps: RemoteMaterializerDeps): MaterializeFn {
  const label = (hostId: HostId) =>
    hostId === deps.hostId ? deps.hostLabel() : hostId === LOCAL_HOST_ID ? deps.localLabel : hostId;

  const toDestination = (
    options: MaterializeOptions | undefined,
    overwrite = false
  ): TransferDestination =>
    options?.destination?.kind === "worktree"
      ? { kind: "worktree", directory: options.destination.directory, overwrite }
      : { kind: "inbox", bucket: "files" };

  /** Run one upload under an operation id: progress follows it, and the signal cancels it. */
  const upload = async (
    options: MaterializeOptions | undefined,
    start: (opId: string) => Promise<UploadResult>
  ): Promise<UploadResult> => {
    const { signal, onProgress } = options ?? {};
    if (signal?.aborted) throw cancelled();
    const opId = deps.mintOperationId();
    const offProgress = deps.fileTransfer.onEvent((event) => {
      if (event.type !== "progress" || event.opId !== opId || event.totalBytes <= 0) return;
      try {
        onProgress?.(event.transferredBytes / event.totalBytes);
      } catch {
        // Progress is advisory.
      }
    });
    const onAbort = () => void deps.fileTransfer.cancel({ opId }).catch(() => {});
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await start(opId);
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      throw error;
    } finally {
      offProgress();
      signal?.removeEventListener("abort", onAbort);
    }
  };

  /** Add to project met a file of the same name: replace it only if the user says so. */
  const resolveConflict = async (
    result: UploadResult,
    retry: () => Promise<UploadResult>
  ): Promise<UploadResult> => {
    if (!result.conflict) return result;
    const replace = await deps.confirmReplace({
      name: basename(result.hostPath),
      folder: dirname(result.hostPath),
      hostLabel: deps.hostLabel(),
    });
    if (!replace) throw cancelled();
    const replaced = await retry();
    if (replaced.conflict) throw cancelled();
    return replaced;
  };

  const materializeLocalFile = async (
    localPath: string,
    options: MaterializeOptions | undefined
  ): Promise<MaterializeResult> => {
    const name = basename(localPath) || localPath;
    const host = deps.hostLabel();
    const stat = await deps.fileTransfer.statLocalFile({ localPath });
    if (!stat) {
      throw new MaterializeError("INVALID_PATH", `Couldn't read ${name} on ${deps.localLabel}.`);
    }
    if (stat.isDirectory) {
      throw new MaterializeError(
        "UNSUPPORTED",
        `${name} is a folder. Sending folders to ${host} isn't available yet.`
      );
    }
    if (stat.size > UPLOAD_REFUSE_BYTES) {
      throw new MaterializeError(
        "PAYLOAD_TOO_LARGE",
        `${name} is ${formatBytes(stat.size)}, over the ${formatBytes(UPLOAD_REFUSE_BYTES)} limit for sending to ${host}.`
      );
    }
    if (stat.size > UPLOAD_CONFIRM_BYTES) {
      const go = await deps.confirmLargeUpload({ name, bytes: stat.size, hostLabel: host });
      if (!go) throw cancelled();
    }
    const send = (overwrite: boolean) =>
      upload(options, (opId) =>
        deps.fileTransfer.uploadLocalFile({
          hostId: deps.hostId,
          localPath,
          destination: toDestination(options, overwrite),
          opId,
        })
      );
    const result = await resolveConflict(await send(false), () => send(true));
    return { hostPath: result.hostPath, displayName: name, bytes: result.bytes };
  };

  const materializeBytes = async (
    source: Extract<MaterializeSource, { kind: "local-bytes" }>,
    options: MaterializeOptions | undefined
  ): Promise<MaterializeResult> => {
    const host = deps.hostLabel();
    if (source.bytes.byteLength > UPLOAD_REFUSE_BYTES) {
      throw new MaterializeError(
        "PAYLOAD_TOO_LARGE",
        `${source.name} is too large to send to ${host}.`
      );
    }
    if (source.bytes.byteLength > UPLOAD_CONFIRM_BYTES) {
      const go = await deps.confirmLargeUpload({
        name: source.name,
        bytes: source.bytes.byteLength,
        hostLabel: host,
      });
      if (!go) throw cancelled();
    }
    const send = (overwrite: boolean) =>
      upload(options, (opId) =>
        deps.fileTransfer.uploadBytes({
          hostId: deps.hostId,
          bytes: source.bytes,
          name: source.name,
          mimeType: source.mimeType,
          destination: toDestination(options, overwrite),
          opId,
        })
      );
    const result = await resolveConflict(await send(false), () => send(true));
    return { hostPath: result.hostPath, displayName: source.name, bytes: result.bytes };
  };

  const resolve = async (
    source: MaterializeSource,
    options: MaterializeOptions | undefined
  ): Promise<MaterializeResult> => {
    switch (source.kind) {
      case "host-file":
        if (source.hostId !== deps.hostId) {
          throw new MaterializeError(
            "VALIDATION",
            `That file is on ${label(source.hostId)}; this window is ${deps.hostLabel()}.`
          );
        }
        return { hostPath: source.path, displayName: basename(source.path), bytes: null };
      case "local-file":
        return materializeLocalFile(source.path, options);
      case "local-bytes":
        return materializeBytes(source, options);
      case "clipboard-image": {
        const { filePath, thumbnailDataUrl } = await deps.saveClipboardImage();
        return {
          hostPath: filePath,
          displayName: basename(filePath),
          bytes: null,
          thumbnail: thumbnailDataUrl,
        };
      }
    }
  };

  return async (source, options) => {
    try {
      return await resolve(source, options);
    } catch (error) {
      const code = codeOf(error);
      // Nothing to say: the user cancelled, or pasted with no image to send.
      if (code !== "CANCELLED" && code !== "CLIPBOARD_EMPTY") {
        const name =
          source.kind === "local-file" || source.kind === "host-file"
            ? basename(source.path)
            : source.kind === "local-bytes"
              ? source.name
              : "the image";
        deps.reportFailure({
          title: `Couldn't send ${name}`,
          message:
            userMessageOf(error) ??
            (error instanceof MaterializeError
              ? error.message
              : `Couldn't send ${name} to ${deps.hostLabel()}.`),
        });
      }
      throw error;
    }
  };
}

/**
 * The materializer a remote view installs for itself: its host from the view,
 * its questions through the upload confirm host, its failures as toasts.
 */
export function createViewRemoteMaterializer(hostId: HostId): MaterializeFn {
  return createRemoteMaterializer({
    hostId,
    hostLabel: () => getHostPlatformInfo().hostName ?? hostId,
    localLabel: isMac() ? "This Mac" : "this computer",
    fileTransfer: window.electron.fileTransfer,
    saveClipboardImage: () => window.electron.clipboard.saveImage(),
    confirmLargeUpload: (request) => askUploadQuestion({ kind: "large", ...request }),
    confirmReplace: (request) => askUploadQuestion({ kind: "replace", ...request }),
    reportFailure: ({ title, message }) => {
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({ type: "error", title, message, context: { eventKind: "host" } });
    },
    mintOperationId,
  });
}
