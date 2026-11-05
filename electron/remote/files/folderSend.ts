import crypto from "node:crypto";
import type { FolderUploadProblem } from "../../../shared/types/folderUpload.js";
import type {
  FileTransferEvent,
  FolderUploadPhase,
  UploadLocalFolderResult,
} from "../../../shared/types/ipc/fileTransfer.js";
import type { HostId } from "../../../shared/types/remoteHosts.js";
import { AppError } from "../../utils/errorTypes.js";
import type { LinkSession } from "../link/session.js";
import { folderOutcomeUnknown, type ClientUploadTransport } from "./ClientUploadTransport.js";
import type {
  FolderUploadCancelResult,
  FolderUploadFailureReason,
  FolderUploadPrepareResult,
  FolderUploadRefusalReason,
  FolderUploadStatus,
} from "./folderUploadLinkMethods.js";
import {
  LocalFolderPackError,
  type FolderPackProgress,
  type LocalFolderPackResult,
  type PackedFolderArchive,
} from "./localFolderPack.js";

/**
 * Sending one summarized folder to its host (#16247): pack it, prepare, send
 * the archive, then follow the host's status through unpacking until the
 * folder's host path comes back, all under the view's operation id.
 *
 * The host's record decides every retry. A link that drops, or an answer
 * that is lost, is asked about again under the same id once the host is
 * reachable, and the host answers from what it recorded, so the folder is
 * packed once and published at most once, and an archive the host already
 * has whole is never sent again. An archive the host recorded as never
 * having arrived whole (`transfer-failed`) is settled for good there, with
 * nothing published, so the same archive is sent again as a new operation.
 */

export type FolderSendTransport = Pick<
  ClientUploadTransport,
  "prepareFolder" | "sendFolderArchive" | "folderStatus" | "cancelFolder"
> &
  Partial<Pick<ClientUploadTransport, "whenReachable">>;

export interface FolderSendOptions {
  transport: FolderSendTransport;
  hostId: HostId;
  webContentsId: number;
  /** The view's operation id: every progress event carries it. */
  opId: string;
  rootName: string;
  hostLabel: string;
  localLabel: string;
  /** The operation's own: a cancel, the view going or the client stopping. */
  signal: AbortSignal;
  /** Only the client stopping: it cuts short asking the host to cancel, too. */
  teardown: AbortSignal;
  viewGone(): boolean;
  pack(options: {
    signal: AbortSignal;
    onProgress: (progress: FolderPackProgress) => void;
  }): Promise<LocalFolderPackResult>;
  /** One of the host's upload slots, shared with file uploads; rejects CANCELLED on abort. */
  takeSlot(signal: AbortSignal): Promise<() => void>;
  /** Throws once the view is no longer on the host it started on. */
  requireBoundHost(): void;
  emit(event: FileTransferEvent): void;
  reconnectWaitMs: number;
  random: () => number;
  pollIntervalMs?: number;
  /** How long a host may report an archive arriving before the Shell stops waiting for it. */
  receivingWaitMs?: number;
}

const PROGRESS_INTERVAL_MS = 100;
const DEFAULT_POLL_INTERVAL_MS = 250;
/** As long as a transfer's commit is given, so an archive still being verified is never cut off. */
const DEFAULT_RECEIVING_WAIT_MS = 120_000;
/** Link drops and lost answers one send rides out. */
const MAX_RECONCILE_ATTEMPTS = 3;
/** Archives the host recorded as never arriving whole, sent again as a new operation. */
const MAX_RESENDS = 2;
const MAX_BUSY_RETRIES = 10;
const BUSY_RETRY_BASE_MS = 500;
const BUSY_RETRY_CAP_MS = 10_000;

const ABORTED = Symbol("aborted");

function codeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function cancelledError(): AppError {
  return new AppError({ code: "CANCELLED", message: "Folder upload cancelled" });
}

/** Resolves true after `ms`, or false as soon as `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The id a resend runs under on the host: derived, so it is the same for
 * every retry of that resend, and never one the view chose for itself.
 */
function resendOpId(opId: string, resend: number): string {
  const digest = crypto.createHash("sha256").update(opId).digest("hex").slice(0, 32);
  return `resend-${resend}-${digest}`;
}

function packFailure(error: unknown, localLabel: string): Error {
  // The handle refused, or too many folders packing: already worded for the person.
  if (error instanceof AppError) return error;
  const reason = error instanceof LocalFolderPackError ? error.reason : "write-failed";
  switch (reason) {
    case "cancelled":
      return cancelledError();
    case "no-space":
      return new AppError({
        code: "PAYLOAD_TOO_LARGE",
        message: "No room to pack the folder",
        userMessage: `There isn't enough room on ${localLabel} to pack the folder.`,
      });
    case "write-failed":
      return new AppError({
        code: "INTERNAL",
        message: "The folder could not be packed",
        userMessage: `Couldn't pack the folder on ${localLabel}.`,
      });
  }
}

/**
 * What the host said about a folder it turned away or couldn't finish. One
 * that names its problem is a result, since the problem names paths; the
 * rest are errors that never name the folder.
 */
function hostVerdict(
  reason: FolderUploadRefusalReason | FolderUploadFailureReason,
  problem: FolderUploadProblem | undefined,
  hostLabel: string
): UploadLocalFolderResult | AppError {
  if (problem) return { status: "refused", problem };
  const error = (code: AppError["code"], message: string, userMessage: string) =>
    new AppError({ code, message, userMessage });
  switch (reason) {
    case "over-limits":
      return error(
        "PAYLOAD_TOO_LARGE",
        "The folder is over the host's limits",
        `The folder is too large to send to ${hostLabel}.`
      );
    case "no-space":
      return error(
        "PAYLOAD_TOO_LARGE",
        "The host is out of disk space",
        `${hostLabel} is out of disk space.`
      );
    case "not-driving":
      return error(
        "DRIVEN_ELSEWHERE",
        "Another window drives this project",
        `Another window has control of this project on ${hostLabel}. Take control to send folders.`
      );
    case "name-clash":
      return error(
        "VALIDATION",
        "Names in the folder clash on the host",
        `Some names in the folder can't be kept apart on ${hostLabel}.`
      );
    case "unsafe-archive":
      return error(
        "INTERNAL",
        "The host refused the folder archive",
        `${hostLabel} couldn't unpack the folder.`
      );
    case "busy":
      return error(
        "RATE_LIMITED",
        "The host is taking other folders",
        `Other folders are still being sent to ${hostLabel}. Try again in a moment.`
      );
    case "transfer-failed":
      return error(
        "INTERNAL",
        "The folder archive never arrived whole",
        `The folder didn't arrive whole on ${hostLabel}. Try again.`
      );
    case "write-failed":
      return error(
        "INTERNAL",
        "The host could not save the folder",
        `Couldn't save the folder on ${hostLabel}.`
      );
  }
}

type ProgressFields = Omit<
  Extract<FileTransferEvent, { type: "folder-progress" }>,
  "type" | "opId" | "phase"
>;

/**
 * Folder progress for the view: a phase's first event and its last go at
 * once, the rest at most every 100 ms, and nothing after the send settles.
 */
function progressReporter(emit: (event: FileTransferEvent) => void, opId: string) {
  let phase: FolderUploadPhase | null = null;
  let lastSent = 0;
  let stopped = false;
  return {
    report(next: FolderUploadPhase, fields: ProgressFields): void {
      if (stopped) return;
      const now = Date.now();
      const finished =
        (fields.filesDone ?? fields.filesTotal) >= fields.filesTotal &&
        (fields.transferredBytes ?? fields.totalBytes) >= fields.totalBytes;
      if (next === phase && !finished && now - lastSent < PROGRESS_INTERVAL_MS) return;
      phase = next;
      lastSent = now;
      emit({ type: "folder-progress", opId, phase: next, ...fields });
    },
    stop(): void {
      stopped = true;
    },
  };
}

export async function sendLocalFolder(options: FolderSendOptions): Promise<UploadLocalFolderResult> {
  const { signal } = options;
  const progress = progressReporter(options.emit, options.opId);
  try {
    let packed: LocalFolderPackResult;
    try {
      packed = await options.pack({
        signal,
        onProgress: (p) =>
          progress.report("packing", {
            filesDone: p.filesDone,
            filesTotal: p.filesTotal,
            transferredBytes: p.bytesDone,
            totalBytes: p.bytesTotal,
          }),
      });
    } catch (error) {
      throw signal.aborted ? cancelledError() : packFailure(error, options.localLabel);
    }
    if (packed.status === "changed") {
      return { status: "changed", path: packed.path, change: packed.change };
    }
    const delivery = new FolderDelivery(options, packed.archive, progress);
    try {
      let release: () => void;
      try {
        release = await options.takeSlot(signal);
      } catch (error) {
        if (signal.aborted) throw cancelledError();
        throw error;
      }
      let outcome: UploadLocalFolderResult | typeof ABORTED;
      try {
        outcome = await delivery.run();
      } finally {
        release();
      }
      if (outcome !== ABORTED) return outcome;
      // Stopped by the person, the view going or the client stopping: the
      // archive is no use any more, and the host is asked to stop too.
      await delivery.removeArchive();
      const answer = await delivery.cancelOnHost();
      if (answer?.status === "done") return delivery.sent(answer.hostPath);
      throw cancelledError();
    } finally {
      await delivery.removeArchive();
    }
  } finally {
    progress.stop();
  }
}

class FolderDelivery {
  /** The id the host knows this attempt by: the view's own until a resend. */
  private hostOpId: string;
  private resends = 0;
  /** A prepare under `hostOpId` may have reached the host. */
  private reached = false;
  /** The host has this attempt's archive whole. */
  private received = false;
  /** This attempt's archive may have arrived whole, though no answer said so. */
  private uncertain = false;
  private removal: Promise<void> | null = null;
  private removed = false;

  constructor(
    private readonly options: FolderSendOptions,
    private readonly archive: PackedFolderArchive,
    private readonly progress: ReturnType<typeof progressReporter>
  ) {
    this.hostOpId = options.opId;
  }

  /** The folder is in place: its unpacking is reported finished, whatever was seen of it. */
  sent(hostPath: string): UploadLocalFolderResult {
    this.reportUnpacking(this.archive.totals.fileCount);
    return { status: "sent", hostPath, totals: { ...this.archive.totals } };
  }

  /** Removes the local archive once; a removal that failed is tried again on the next call. */
  removeArchive(): Promise<void> {
    if (this.removed) return Promise.resolve();
    this.removal ??= this.archive.remove().then(
      () => {
        this.removed = true;
      },
      () => {
        this.removal = null;
      }
    );
    return this.removal;
  }

  /**
   * Ask the host to stop this operation, once more after a dropped link,
   * and say where it ended; null when the host couldn't be asked.
   */
  async cancelOnHost(): Promise<FolderUploadCancelResult | null> {
    if (!this.reached) return null;
    const { transport, hostId, webContentsId, hostLabel, teardown } = this.options;
    for (let attempt = 0; ; attempt++) {
      try {
        return await transport.cancelFolder(hostId, this.hostOpId, {
          webContentsId,
          hostLabel,
          signal: teardown,
        });
      } catch (error) {
        const code = codeOf(error);
        if (
          attempt > 0 ||
          teardown.aborted ||
          this.options.viewGone() ||
          (code !== "HOST_DISCONNECTED" && code !== "OUTCOME_UNKNOWN") ||
          !transport.whenReachable ||
          !(await transport.whenReachable(
            hostId,
            webContentsId,
            this.options.reconnectWaitMs,
            teardown
          ))
        ) {
          return null;
        }
      }
    }
  }

  private reportUnpacking(filesDone: number): void {
    const { totals } = this.archive;
    this.progress.report("unpacking", {
      filesDone: Math.min(filesDone, totals.fileCount),
      filesTotal: totals.fileCount,
      transferredBytes: null,
      totalBytes: totals.totalBytes,
    });
  }

  /** The archive is the host's now: the local copy goes, and the unpack is followed. */
  private async noteReceived(filesDone: number): Promise<void> {
    if (!this.received) {
      this.received = true;
      this.uncertain = false;
      await this.removeArchive();
    }
    this.reportUnpacking(filesDone);
  }

  /** Sends the archive; an archive that can't be read here is the send's final error. */
  private async sendArchive(session: LinkSession, token: string): Promise<AppError | null> {
    const { transport, hostLabel, signal } = this.options;
    const { archive } = this;
    const report = (transferredBytes: number) =>
      this.progress.report("sending", {
        filesDone: null,
        filesTotal: archive.totals.fileCount,
        transferredBytes,
        totalBytes: archive.archiveBytes,
      });
    report(0);
    let source;
    try {
      source = await archive.openSource();
    } catch {
      return new AppError({
        code: "INTERNAL",
        message: "The packed folder could not be read",
        userMessage: `Couldn't read the packed folder on ${this.options.localLabel}.`,
      });
    }
    try {
      await transport.sendFolderArchive(session, source, token, {
        hostLabel,
        signal,
        onProgress: (sentBytes) => report(sentBytes),
      });
    } finally {
      await Promise.resolve(source.close?.()).catch(() => {});
    }
    return null;
  }

  private prepareRequest() {
    const { archive } = this;
    return {
      opId: this.hostOpId,
      rootName: this.options.rootName,
      archiveBytes: archive.archiveBytes,
      sha256: archive.sha256,
      fileCount: archive.totals.fileCount,
      folderCount: archive.totals.folderCount,
      totalBytes: archive.totals.totalBytes,
    };
  }

  /**
   * The call that picks the send up again after `stage` was cut short:
   * before the end of the archive went out the host can't have it whole, so
   * a prepare may ask again; after, only its status may, since a prepare
   * the host had no record for would admit the folder a second time.
   */
  private resumeAfter(stage: "prepare" | "send" | "status"): "prepare" | "status" {
    return stage === "status" || this.received || this.uncertain ? "status" : "prepare";
  }

  /** Prepares, then sends, and settles once the host's record does. */
  async run(): Promise<UploadLocalFolderResult | typeof ABORTED> {
    const { transport, hostId, webContentsId, hostLabel, signal } = this.options;
    const callOptions = { webContentsId, hostLabel, signal };
    const pollMs = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const receivingWaitMs = this.options.receivingWaitMs ?? DEFAULT_RECEIVING_WAIT_MS;
    let next: "prepare" | "status" = "prepare";
    let reconciled = 0;
    let busyRetries = 0;
    let receivingSince: number | null = null;

    const backOff = async (): Promise<boolean> => {
      if (busyRetries >= MAX_BUSY_RETRIES) return false;
      const ceiling = Math.min(BUSY_RETRY_CAP_MS, BUSY_RETRY_BASE_MS * 2 ** busyRetries);
      busyRetries += 1;
      await pause(Math.floor(this.options.random() * ceiling), signal);
      return true;
    };

    /**
     * Where the host's answer leaves the send: settled (a result, or an
     * error that is the host's final word), or which call comes next.
     */
    const follow = async (
      answer: FolderUploadPrepareResult | FolderUploadStatus,
      session: LinkSession | null
    ): Promise<UploadLocalFolderResult | AppError | "prepare" | "status"> => {
      if (answer.status !== "receiving") receivingSince = null;
      switch (answer.status) {
        case "ready": {
          const unread = await this.sendArchive(session!, answer.token);
          if (unread) return unread;
          await this.noteReceived(0);
          return "status";
        }
        case "refused":
          if (answer.reason === "busy" && (await backOff())) return "prepare";
          return hostVerdict(answer.reason, answer.problem, hostLabel);
        case "receiving": {
          // Admitted, its archive arriving or being verified, or a transfer
          // on a link that dropped still being given up on: wait for the host
          // to settle which.
          const now = Date.now();
          receivingSince ??= now;
          if (now - receivingSince > receivingWaitMs) {
            await this.removeArchive();
            const ended = await this.cancelOnHost();
            if (ended?.status === "done") return this.sent(ended.hostPath);
            return folderOutcomeUnknown(hostLabel);
          }
          await pause(pollMs, signal);
          return "status";
        }
        case "unpacking":
          await this.noteReceived(answer.filesDone);
          await pause(pollMs, signal);
          return "status";
        case "done":
          return this.sent(answer.hostPath);
        case "failed":
          // Settled with nothing published: the same archive goes again as a
          // new operation, never under the id the host has closed.
          if (answer.reason === "transfer-failed" && !this.received && this.resends < MAX_RESENDS) {
            this.resends += 1;
            this.hostOpId = resendOpId(this.options.opId, this.resends);
            this.reached = false;
            this.uncertain = false;
            return "prepare";
          }
          return hostVerdict(answer.reason, answer.problem, hostLabel);
        case "cancelled":
          return new AppError({
            code: "CANCELLED",
            message: "The host stopped the folder upload",
            userMessage: `${hostLabel} stopped receiving the folder.`,
          });
        case "unknown":
          // A record the host let go of, or lost restarting: asking it to
          // prepare again could publish a second copy of an archive that
          // may have arrived.
          if (this.received || this.uncertain) return folderOutcomeUnknown(hostLabel);
          return "prepare";
      }
    };

    for (;;) {
      if (signal.aborted) return ABORTED;
      let stage: "prepare" | "send" | "status" = next;
      let settled: UploadLocalFolderResult | AppError | "prepare" | "status";
      try {
        this.options.requireBoundHost();
        let answer: FolderUploadPrepareResult | FolderUploadStatus;
        let session: LinkSession | null = null;
        if (next === "prepare") {
          this.reached = true;
          ({ result: answer, session } = await transport.prepareFolder(
            hostId,
            this.prepareRequest(),
            callOptions
          ));
          if (answer.status === "ready") stage = "send";
        } else {
          answer = await transport.folderStatus(hostId, this.hostOpId, callOptions);
        }
        settled = await follow(answer, session);
      } catch (error) {
        if (signal.aborted) return ABORTED;
        const code = codeOf(error);
        if (code === "RATE_LIMITED" && (await backOff())) {
          next = this.resumeAfter(stage);
          continue;
        }
        // Past the archive's start, a failure other than a dropped link may
        // still have left it whole on the host.
        if (stage === "send" && code !== "HOST_DISCONNECTED" && code !== "RATE_LIMITED") {
          this.uncertain = true;
        }
        if (code === "HOST_DISCONNECTED" || code === "OUTCOME_UNKNOWN") {
          next = this.resumeAfter(stage);
          if (
            reconciled >= MAX_RECONCILE_ATTEMPTS ||
            !transport.whenReachable ||
            !(await transport.whenReachable(
              hostId,
              webContentsId,
              this.options.reconnectWaitMs,
              signal
            ))
          ) {
            if (signal.aborted) return ABORTED;
            throw this.received || this.uncertain ? folderOutcomeUnknown(hostLabel) : error;
          }
          reconciled += 1;
          continue;
        }
        // The host turned the archive away on the link (a stale token, a
        // digest that didn't match): its record says what became of it.
        if (stage === "send" && code === "INTERNAL" && reconciled < MAX_RECONCILE_ATTEMPTS) {
          reconciled += 1;
          next = "status";
          continue;
        }
        throw error;
      }
      if (settled instanceof AppError) throw settled;
      if (typeof settled !== "string") return settled;
      next = settled;
    }
  }
}
