import { z } from "zod";
import {
  FOLDER_UPLOAD_LIMITS,
  FOLDER_UPLOAD_MAX_PROBLEM_PATHS,
  FOLDER_UPLOAD_PATH_PROBLEMS,
  type FolderUploadProblem,
} from "../../../shared/types/folderUpload.js";
import { checkFolderUploadRootName } from "../../../shared/utils/folderUpload.js";

/**
 * Session CALL methods a Shell uses to send a whole folder into its host's
 * inbox (#16247). They sit beside `files.upload-prepare`, whose schemas stay
 * as they are, so a host or Shell from before folders never meets a shape it
 * would reject.
 *
 * The Shell packs the folder into one stored zip, then prepares the upload
 * with its endpoint, operation id, the archive's size and sha256, and the
 * file, folder and byte counts it declared to the person. The host binds the
 * upload to all of that and answers with a token; the archive arrives as one
 * verified bulk transfer to that token. Unpacking starts only after the
 * transfer has committed, since a commit has a fixed deadline the peer can't
 * stop, so the transfer's own success says the archive arrived, never that
 * the folder is in place: only a `done` status carries the folder's host path.
 *
 * A host from before folder uploads answers each method UNSUPPORTED. The host
 * registers these methods wherever it registers `files.upload-prepare`, and
 * its handlers never answer UNSUPPORTED themselves, so the Shell reads it as
 * "update this host" ({@link classifyFolderUploadCallError}). A refusal is a
 * result, never an error.
 *
 * The status and reason enums are strict, so a status or reason added later
 * is one an older Shell can't parse: it arrives with a method or capability
 * of its own, never as a new value under these.
 */
export const FolderUploadLinkMethod = {
  /** Shell → Host: admit a folder upload, or report what this operation already did. */
  PREPARE: "files.folder-upload-prepare",
  /** Shell → Host: where an operation is now. */
  STATUS: "files.folder-upload-status",
  /** Shell → Host: stop an operation; the answer is where it ended. */
  CANCEL: "files.folder-upload-cancel",
} as const;

/** The transfer destination the host accepts for an archive, followed by the token it issued. */
export const FOLDER_UPLOAD_SINK_PREFIX = "daintree-folder-upload:";

/*
 * The archive: one zip, every entry stored (method 0) with the UTF-8 name
 * flag set, no encryption and no ZIP64, which the limits keep it under.
 * Every entry's name is a relative POSIX path whose first component is the
 * dropped folder's name, checked with `checkFolderUploadEntryPath`. Every
 * folder, the root and empty ones included, has an entry of its own ending
 * in `/` with no data, so empty folders survive. Each entry is made by Unix
 * (3) with its mode in the upper 16 bits of the external attributes, and the
 * only mode carried is whether a file is executable: files are 0600 or 0700
 * and folders 0700, with no links, devices or other special entries.
 */
export const FOLDER_ARCHIVE_METHOD_STORED = 0;
export const FOLDER_ARCHIVE_FLAG_UTF8 = 0x0800;
export const FOLDER_ARCHIVE_FILE_MODE = 0o600;
export const FOLDER_ARCHIVE_EXECUTABLE_MODE = 0o700;
export const FOLDER_ARCHIVE_FOLDER_MODE = 0o700;

const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

/** The full mode an entry is packed with, file type included. */
export function folderArchiveMode(kind: "file" | "folder", executable = false): number {
  if (kind === "folder") return S_IFDIR | FOLDER_ARCHIVE_FOLDER_MODE;
  return S_IFREG | (executable ? FOLDER_ARCHIVE_EXECUTABLE_MODE : FOLDER_ARCHIVE_FILE_MODE);
}

/** What a packed mode says, or null for anything the packer never writes. */
export function readFolderArchiveMode(
  kind: "file" | "folder",
  mode: number
): { executable: boolean } | null {
  if (kind === "folder") return mode === folderArchiveMode("folder") ? { executable: false } : null;
  if (mode === folderArchiveMode("file", false)) return { executable: false };
  if (mode === folderArchiveMode("file", true)) return { executable: true };
  return null;
}

const endpointId = z.string().min(1).max(256);
const opId = z.string().min(1).max(128);
const hostPath = z.string().min(1).max(4096);
const hexId = z.string().regex(/^[0-9a-f]{32}$/);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** As long as a zip entry's name can be, since a problem may name a path for being too long. */
const problemPath = z.string().max(65_535);

export const FolderUploadProblemSchema: z.ZodType<FolderUploadProblem> = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("limit"),
        limit: z.enum(FOLDER_UPLOAD_LIMITS),
        maximum: count,
        actual: count,
        paths: z.array(problemPath).max(FOLDER_UPLOAD_MAX_PROBLEM_PATHS),
      })
      .refine((problem) => problem.actual > problem.maximum),
    z.object({ kind: z.literal("clash"), paths: z.tuple([problemPath, problemPath]) }),
    z.object({
      kind: z.literal("path"),
      problem: z.enum(FOLDER_UPLOAD_PATH_PROBLEMS),
      path: problemPath,
    }),
  ]
);

/*
 * Payloads are strict: an unexpected field is refused rather than dropped,
 * so a newer Shell asking for something this host doesn't know (a folder
 * into the project, say) gets VALIDATION instead of an inbox upload. Counts
 * are only held to what a count can be; a count over a limit is a refusal
 * naming the limit, so a Shell can say which one.
 */
export const FolderUploadPreparePayloadSchema = z
  .strictObject({
    /** The asking view's own endpoint: the upload runs under its project and lease only. */
    endpointId,
    /** The Shell's operation id: a retry with the same id is told what the operation did. */
    opId,
    /** The dropped folder's name; a name only a limit refuses is the host's to refuse. */
    rootName: z
      .string()
      .min(1)
      .max(1024)
      .refine((name) => checkFolderUploadRootName(name)?.kind !== "path"),
    archiveBytes: count,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    fileCount: count,
    folderCount: count,
    /** File content only, without archive headers. */
    totalBytes: count,
  })
  .refine((payload) => payload.archiveBytes > payload.totalBytes)
  .refine((payload) => payload.fileCount > 0 || payload.totalBytes === 0);
export type FolderUploadPreparePayload = z.infer<typeof FolderUploadPreparePayloadSchema>;

export const FolderUploadOperationPayloadSchema = z.strictObject({ endpointId, opId });
export type FolderUploadOperationPayload = z.infer<typeof FolderUploadOperationPayloadSchema>;

export const FOLDER_UPLOAD_REFUSAL_REASONS = [
  "over-limits",
  "no-space",
  "not-driving",
  "name-clash",
  "unsafe-archive",
  "busy",
] as const;
export type FolderUploadRefusalReason = (typeof FOLDER_UPLOAD_REFUSAL_REASONS)[number];

export const FOLDER_UPLOAD_FAILURE_REASONS = [
  "over-limits",
  "no-space",
  "not-driving",
  "name-clash",
  "unsafe-archive",
  /** The archive never arrived whole: the transfer failed, didn't verify, or never came. */
  "transfer-failed",
  "write-failed",
] as const;
export type FolderUploadFailureReason = (typeof FOLDER_UPLOAD_FAILURE_REASONS)[number];

/**
 * Admitted, with the archive awaited, arriving or being verified. Only a
 * status says so before any of it arrives; a prepare asked again then is
 * `ready` once more.
 */
const receiving = z.object({ status: z.literal("receiving") });
const unpacking = z
  .object({ status: z.literal("unpacking"), filesDone: count, filesTotal: count })
  .refine((status) => status.filesDone <= status.filesTotal);
/** The whole folder is in the inbox at `hostPath`. */
const done = z.object({ status: z.literal("done"), hostPath });
const failed = z.object({
  status: z.literal("failed"),
  reason: z.enum(FOLDER_UPLOAD_FAILURE_REASONS),
  problem: FolderUploadProblemSchema.optional(),
});
const cancelled = z.object({ status: z.literal("cancelled") });
/**
 * The host holds no record of this operation: it never arrived, or the host
 * restarted or let the record go. Never a guess that it failed.
 */
const unknown = z.object({ status: z.literal("unknown") });

export const FolderUploadStatusSchema = z.discriminatedUnion("status", [
  receiving,
  unpacking,
  done,
  failed,
  cancelled,
  unknown,
]);
export type FolderUploadStatus = z.infer<typeof FolderUploadStatusSchema>;

/**
 * A prepare either admits the upload with a token for its archive, refuses
 * it, or (asked again under an opId the host already holds) reports where
 * that operation is, so a Shell that lost an answer never sends twice. Asked
 * again before any of the archive has arrived, it is `ready` again with a
 * token the archive can still go to. An admission whose archive never comes
 * ends `failed` as `transfer-failed`, and the same opId with a different root,
 * archive or counts is VALIDATION, as a file upload's is.
 */
export const FolderUploadPrepareResultSchema = z.discriminatedUnion("status", [
  /** Send the archive to `FOLDER_UPLOAD_SINK_PREFIX` + `token`. */
  z.object({ status: z.literal("ready"), token: hexId }),
  z.object({
    status: z.literal("refused"),
    reason: z.enum(FOLDER_UPLOAD_REFUSAL_REASONS),
    problem: FolderUploadProblemSchema.optional(),
  }),
  receiving,
  unpacking,
  done,
  failed,
  cancelled,
]);
export type FolderUploadPrepareResult = z.infer<typeof FolderUploadPrepareResultSchema>;

/**
 * Where a cancelled operation ended: `cancelled` once nothing will be
 * published, `done` when publishing won the race, and as it was for one
 * that had already failed or that the host has no record of.
 */
export const FolderUploadCancelResultSchema = z.discriminatedUnion("status", [
  cancelled,
  done,
  failed,
  unknown,
]);
export type FolderUploadCancelResult = z.infer<typeof FolderUploadCancelResultSchema>;

/**
 * What a failed folder-upload CALL says about the host, read from the error's
 * code alone (a host's errors arrive rebuilt from the envelope, not as this
 * process's AppError):
 * - `unsupported`: the host doesn't know the method, as one from before folder
 *   uploads answers, so the person is told to update it ("Update Daintree on
 *   studio-02 to send folders");
 * - `validation`: the host knows the method and refused the request itself,
 *   a send that failed rather than an outdated host;
 * - `other`: anything else, the link's own failures and replies that don't
 *   parse as a result included, handled as any upload's are.
 */
export type FolderUploadCallFailure = "unsupported" | "validation" | "other";

export function classifyFolderUploadCallError(error: unknown): FolderUploadCallFailure {
  if (typeof error !== "object" || error === null || !("code" in error)) return "other";
  if (error.code === "UNSUPPORTED") return "unsupported";
  if (error.code === "VALIDATION") return "validation";
  return "other";
}
