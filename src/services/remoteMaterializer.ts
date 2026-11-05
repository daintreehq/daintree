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
  FolderMaterializeProgress,
  FolderPackChange,
  FolderUploadCheck,
  FolderUploadSummary,
  LocalFileStat,
  LocalFolderSummaryResult,
  SummarizeLocalFolderPayload,
  TransferDestination,
  UploadLocalFolderPayload,
  UploadLocalFolderResult,
  UploadResult,
} from "@shared/types/ipc/fileTransfer";
import type { FolderUploadProblem } from "@shared/types/folderUpload";
import { formatBytes } from "@/lib/formatBytes";
import { notify } from "@/lib/notify";
import { isMac } from "@/lib/platform";
import { getHostPlatformInfo } from "@/hooks/useHostPlatform";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { isClientAppError } from "@/utils/clientAppError";
import { mintOperationId } from "@/clients/operationsClient";
import { askUploadQuestion } from "@/components/Terminal/uploads/uploadConfirm";
import { folderRefusal } from "@/components/Terminal/uploads/folderRefusal";

/**
 * `materialize` for a window attached to a remote host: whatever is dropped,
 * pasted or attached here becomes a file on the host, and the host path is
 * what gets inserted. Local files and bytes are uploaded into the host inbox
 * (or, for Add to project, into a folder of the project); a local folder is
 * read here, asked about, and sent whole into the inbox once confirmed; a
 * pasted image is captured here and uploaded by the clipboard split; a path
 * from this window's own file browser is already on the host and passes
 * through.
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
    summarizeLocalFolder(payload: SummarizeLocalFolderPayload): Promise<LocalFolderSummaryResult>;
    uploadLocalFolder(payload: UploadLocalFolderPayload): Promise<UploadLocalFolderResult>;
    cancel(payload: { opId: string }): Promise<void>;
    onEvent(callback: (event: FileTransferEvent) => void): () => void;
  };
  /** Captures this machine's clipboard image and uploads it under `opId`. */
  saveClipboardImage(options: {
    opId: string;
  }): Promise<{ filePath: string; thumbnailDataUrl: string }>;
  confirmLargeUpload(request: { name: string; bytes: number; hostLabel: string }): Promise<boolean>;
  confirmReplace(request: { name: string; folder: string; hostLabel: string }): Promise<boolean>;
  /** The folder question; `signal` withdraws it when the folder's chip is cancelled. */
  confirmFolder(
    request: { check: FolderUploadCheck; hostLabel: string },
    signal: AbortSignal | undefined
  ): Promise<boolean>;
  /** The key held for Add to project, as this machine's keyboard names it ("Option"). */
  addToProjectKey: string;
  reportFailure(failure: { title: string; message: string; code?: string }): void;
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

// The bridge strips `code` and `userMessage` off an IPC error and leaves them
// in an `[AppError|…]` message prefix; the guard decodes them back onto it.
function codeOf(error: unknown): string | null {
  isClientAppError(error);
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function userMessageOf(error: unknown): string | null {
  isClientAppError(error);
  if (typeof error !== "object" || error === null || !("userMessage" in error)) return null;
  return typeof error.userMessage === "string" && error.userMessage ? error.userMessage : null;
}

function cancelled(): MaterializeError {
  return new MaterializeError("CANCELLED", "Upload cancelled");
}

export function isCancelledMaterialize(error: unknown): boolean {
  return codeOf(error) === "CANCELLED";
}

/**
 * Main reads and packs at most two folders at once for a view and refuses a
 * third outright, and keeps only the newest eight summaries a view made. A
 * folder holds its turn from being read until its send ends, so a drop of
 * several folders takes turns here and a summary still waiting on its
 * question is never the one main lets go.
 */
const FOLDERS_AT_ONCE = 2;

/**
 * A cancelled walk keeps its place in main until it has actually stopped, and
 * other views count against main's overall cap, so a read refused as busy is
 * asked again a few times before the refusal stands.
 */
const BUSY_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 2_000, 2_000];

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelled());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Up to `size` holders at once, admitted in the order they asked. A wait the
 * signal aborts leaves the line, cancelled.
 */
function createTurns(size: number): (signal: AbortSignal | undefined) => Promise<() => void> {
  let free = size;
  const waiting: Array<() => void> = [];
  const passOn = () => {
    const admit = waiting.shift();
    if (admit) admit();
    else free++;
  };
  return (signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(cancelled());
        return;
      }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        passOn();
      };
      if (free > 0) {
        free--;
        resolve(release);
        return;
      }
      const admit = () => {
        signal?.removeEventListener("abort", leave);
        resolve(release);
      };
      const leave = () => {
        const index = waiting.indexOf(admit);
        if (index >= 0) waiting.splice(index, 1);
        reject(cancelled());
      };
      waiting.push(admit);
      signal?.addEventListener("abort", leave, { once: true });
    });
}

const CHANGE_TEXT: Record<FolderPackChange, string> = {
  gone: "was removed",
  modified: "was changed",
  type: "was swapped for a different kind of item",
  new: "was added",
};

/** A host's refusal of what arrived, in the folder question's own words. */
function hostRefusalText(
  problem: FolderUploadProblem,
  summary: FolderUploadSummary,
  hostLabel: string
): string {
  const { title, detail, paths } = folderRefusal(problem, summary);
  const shown = paths.slice(0, 3).join(", ");
  const named = paths.length > 3 ? `${shown} and ${paths.length - 3} more` : shown;
  const what = title.charAt(0).toLowerCase() + title.slice(1);
  return `${hostLabel} refused the folder: ${what}${named ? ` (${named})` : ""}. ${detail}`;
}

export function createRemoteMaterializer(deps: RemoteMaterializerDeps): MaterializeFn {
  const label = (hostId: HostId) =>
    hostId === deps.hostId ? deps.hostLabel() : hostId === LOCAL_HOST_ID ? deps.localLabel : hostId;

  const toDestination = (
    options: MaterializeOptions | undefined,
    replaceToken?: string
  ): TransferDestination =>
    options?.destination?.kind === "worktree"
      ? replaceToken === undefined
        ? { kind: "worktree", directory: options.destination.directory }
        : { kind: "worktree", directory: options.destination.directory, replaceToken }
      : { kind: "inbox", bucket: "files" };

  /**
   * Run one upload under an operation id: progress follows it, and the signal
   * cancels it. Once cancelled it never answers with a path, even if the
   * host finished first, so nothing is inserted.
   */
  const upload = async <T>(
    options: MaterializeOptions | undefined,
    start: (opId: string) => Promise<T>
  ): Promise<T> => {
    const { signal, onProgress, onFolderProgress } = options ?? {};
    if (signal?.aborted) throw cancelled();
    const opId = deps.mintOperationId();
    const offProgress = deps.fileTransfer.onEvent((event) => {
      if (event.type === "host-pick-request" || event.opId !== opId) return;
      try {
        if (event.type === "progress") {
          if (event.totalBytes > 0) onProgress?.(event.transferredBytes / event.totalBytes);
          return;
        }
        onFolderProgress?.({
          phase: event.phase,
          filesDone: event.filesDone,
          filesTotal: event.filesTotal,
          transferredBytes: event.transferredBytes,
          totalBytes: event.totalBytes,
        });
      } catch {
        // Progress is advisory.
      }
    });
    const onAbort = () => void deps.fileTransfer.cancel({ opId }).catch(() => {});
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await start(opId);
      if (signal?.aborted) throw cancelled();
      return result;
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      throw error;
    } finally {
      offProgress();
      signal?.removeEventListener("abort", onAbort);
    }
  };

  const folderTurns = createTurns(FOLDERS_AT_ONCE);

  /**
   * Add to project met a file of the same name: replace it only if the user
   * says so, with the token the host issued for exactly that file. If the file
   * changed in the meantime the host reports the clash again, and nothing is
   * replaced.
   *
   * Only declining is a cancellation. A clash with no token to replace it
   * under, or one that comes back after the user chose Replace, is reported:
   * they asked for something destructive and it didn't happen.
   */
  const resolveConflict = async (
    result: UploadResult,
    retry: (replaceToken: string) => Promise<UploadResult>
  ): Promise<UploadResult> => {
    if (!result.conflict) return result;
    const name = basename(result.hostPath);
    const folder = dirname(result.hostPath);
    if (!result.replaceToken) {
      throw new MaterializeError(
        "CONFLICT",
        `${name} is already in ${folder} on ${deps.hostLabel()}, and it couldn't be replaced.`
      );
    }
    const replace = await deps.confirmReplace({ name, folder, hostLabel: deps.hostLabel() });
    if (!replace) throw cancelled();
    const replaced = await retry(result.replaceToken);
    if (replaced.conflict) {
      throw new MaterializeError(
        "CONFLICT",
        `${name} couldn't be replaced on ${deps.hostLabel()}: something changed after you chose Replace. Add it again to retry.`
      );
    }
    return replaced;
  };

  const summarizeWhenFree = async (
    localPath: string,
    options: MaterializeOptions | undefined
  ): Promise<LocalFolderSummaryResult> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await upload(options, (opId) =>
          deps.fileTransfer.summarizeLocalFolder({ localPath, opId })
        );
      } catch (error) {
        const delay = BUSY_RETRY_DELAYS_MS[attempt];
        if (codeOf(error) !== "RATE_LIMITED" || delay === undefined) throw error;
        await pause(delay, options?.signal);
      }
    }
  };

  /**
   * A folder from this machine: read here, shown in the folder question, and
   * sent whole into the host inbox once the person confirms it. A refused
   * folder's question is its report, naming the limit or the names that
   * stopped it, so closing it ends here without another word. A cancel from
   * the chip stops whichever step is running, the question included, and
   * nothing is inserted even if the host had already finished.
   */
  const materializeLocalFolder = async (
    localPath: string,
    name: string,
    options: MaterializeOptions | undefined
  ): Promise<MaterializeResult> => {
    const host = deps.hostLabel();
    if (options?.destination?.kind === "worktree") {
      throw new MaterializeError(
        "UNSUPPORTED",
        `Add to project takes files only. Drop ${name} without holding ${deps.addToProjectKey} to send the folder to the inbox on ${host}.`
      );
    }
    const signal = options?.signal;
    const report = (progress: FolderMaterializeProgress) => {
      try {
        options?.onFolderProgress?.(progress);
      } catch {
        // Progress is advisory.
      }
    };
    report({ phase: "waiting" });
    const release = await folderTurns(signal);
    let result: UploadLocalFolderResult;
    let summary: FolderUploadSummary;
    try {
      report({ phase: "reading" });
      const summarized = await summarizeWhenFree(localPath, options);
      report({ phase: "waiting" });
      const check: FolderUploadCheck =
        summarized.status === "ready"
          ? { status: "ready", summary: summarized.summary }
          : summarized;
      const confirmed = await deps.confirmFolder({ check, hostLabel: host }, signal);
      if (!confirmed || summarized.status !== "ready" || signal?.aborted) throw cancelled();
      summary = summarized.summary;
      const { handle } = summarized;
      result = await upload(options, (opId) =>
        deps.fileTransfer.uploadLocalFolder({
          hostId: deps.hostId,
          handle,
          destination: { kind: "inbox", bucket: "files" },
          opId,
        })
      );
    } finally {
      release();
    }
    switch (result.status) {
      case "sent":
        return { hostPath: result.hostPath, displayName: name, bytes: result.totals.totalBytes };
      case "changed":
        throw new MaterializeError(
          "FOLDER_CHANGED",
          `${result.path} ${CHANGE_TEXT[result.change]} on ${deps.localLabel} after the folder was checked, so nothing was sent. Drop the folder again to send it as it is now.`
        );
      case "refused":
        throw new MaterializeError(
          "FOLDER_REFUSED",
          hostRefusalText(result.problem, summary, host)
        );
    }
  };

  const materializeLocalFile = async (
    localPath: string,
    options: MaterializeOptions | undefined
  ): Promise<MaterializeResult> => {
    const name = basename(localPath) || localPath;
    const host = deps.hostLabel();
    const stat = await deps.fileTransfer.statLocalFile({ localPath });
    if (options?.signal?.aborted) throw cancelled();
    if (!stat) {
      throw new MaterializeError("INVALID_PATH", `Couldn't read ${name} on ${deps.localLabel}.`);
    }
    if (stat.isDirectory) return materializeLocalFolder(localPath, name, options);
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
    const send = (replaceToken?: string) =>
      upload(options, (opId) =>
        deps.fileTransfer.uploadLocalFile({
          hostId: deps.hostId,
          localPath,
          destination: toDestination(options, replaceToken),
          opId,
        })
      );
    const result = await resolveConflict(await send(), send);
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
    const send = (replaceToken?: string) =>
      upload(options, (opId) =>
        deps.fileTransfer.uploadBytes({
          hostId: deps.hostId,
          bytes: source.bytes,
          name: source.name,
          mimeType: source.mimeType,
          destination: toDestination(options, replaceToken),
          opId,
        })
      );
    const result = await resolveConflict(await send(), send);
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
        const { filePath, thumbnailDataUrl } = await upload(options, (opId) =>
          deps.saveClipboardImage({ opId })
        );
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
      // Once cancelled from its chip, whatever a step answered late is not news.
      if (options?.signal?.aborted) throw cancelled();
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
          ...(code !== null && { code }),
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
    saveClipboardImage: (options) => window.electron.clipboard.saveImage(options),
    confirmLargeUpload: (request) => askUploadQuestion({ kind: "large", ...request }),
    confirmReplace: (request) => askUploadQuestion({ kind: "replace", ...request }),
    confirmFolder: (request, signal) =>
      askUploadQuestion({ kind: "folder", ...request }, signal ? { signal } : {}),
    addToProjectKey: isMac() ? "Option" : "Alt",
    reportFailure: ({ title, message, code }) => {
      const projectId = code === "DRIVEN_ELSEWHERE" ? getViewWorkspaceId() : null;
      if (projectId) {
        notify({
          type: "error",
          title,
          message,
          context: { eventKind: "host" },
          action: {
            label: "Take control",
            onClick: () =>
              void import("@/components/Recovery/takeControl").then((m) =>
                m.takeControl(projectId)
              ),
          },
        });
        return;
      }
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({ type: "error", title, message, context: { eventKind: "host" } });
    },
    mintOperationId,
  });
}
