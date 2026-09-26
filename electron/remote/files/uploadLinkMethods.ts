import { z } from "zod";

/**
 * Session CALL methods a Shell uses to put a file on its host: a drop, paste
 * or attach in a remote window lands in the host inbox (or, for Add to
 * project, in a folder of the project) and the agent is handed the host path.
 *
 * The Shell first prepares the upload, naming its own endpoint, the file's
 * size and sha256, and where it should go. The host checks all of that before
 * a byte moves and answers with a token; the bytes then arrive as one verified
 * bulk transfer whose destination is that token. A transfer naming a token the
 * host never issued to this session is refused.
 *
 * Every prepare carries the Shell's operation id. The host remembers what an
 * operation placed, so a Shell that lost the acknowledgement asks again with
 * the same id and is told where the file went, rather than placing it twice.
 *
 * Replacing a file in the project is never a flag the Shell sets. The host
 * answers a clash with a conflict naming a single-use replace token, bound to
 * the file it found there, the asking endpoint and its drive lease; only a
 * prepare carrying that token, for that unchanged file, replaces it.
 */
export const UploadLinkMethod = {
  /** Shell → Host: admit an upload, or reuse an identical inbox file. */
  PREPARE: "files.upload-prepare",
} as const;

/** The transfer destination the host accepts, followed by the token it issued. */
export const UPLOAD_SINK_PREFIX = "daintree-upload:";

const hostPath = z.string().min(1).max(4096);
const hexId = z.string().regex(/^[0-9a-f]{32}$/);

export const UploadPreparePayloadSchema = z.object({
  /** The asking view's own endpoint: the upload runs under its project and lease only. */
  endpointId: z.string().min(1).max(256),
  name: z.string().min(1).max(1024),
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** The Shell's operation id: a retry with the same id gets the recorded outcome. */
  opId: z.string().min(1).max(128),
  destination: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("inbox"), bucket: z.enum(["clipboard", "files"]) }),
    z.object({
      kind: z.literal("worktree"),
      directory: hostPath,
      /** From the conflict the host reported, once the user chose to replace. */
      replaceToken: hexId.optional(),
    }),
  ]),
});
export type UploadPreparePayload = z.infer<typeof UploadPreparePayloadSchema>;

export const UPLOAD_REFUSAL_REASONS = [
  "no-space",
  "too-large",
  "outside-project",
  "not-a-directory",
  "not-a-file",
  "busy",
] as const;
export type UploadRefusalReason = (typeof UPLOAD_REFUSAL_REASONS)[number];

export const UploadPrepareResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), token: hexId }),
  /** An identical file is already in the inbox; nothing needs to be sent. */
  z.object({ status: z.literal("duplicate"), hostPath }),
  /**
   * Add to project, and a file of that name is there. `replaceToken` replaces
   * exactly that file, once, for this endpoint.
   */
  z.object({ status: z.literal("conflict"), hostPath, replaceToken: hexId }),
  /** This operation already placed its file (an earlier attempt's answer was lost). */
  z.object({ status: z.literal("done"), hostPath, bytes: z.number().int().min(0) }),
  z.object({ status: z.literal("refused"), reason: z.enum(UPLOAD_REFUSAL_REASONS) }),
]);
export type UploadPrepareResult = z.infer<typeof UploadPrepareResultSchema>;
