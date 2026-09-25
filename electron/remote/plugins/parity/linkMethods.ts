import { z } from "zod";
import type { PluginInstallResult } from "../../../../shared/types/plugin.js";
import { MAX_DNTR_BYTES } from "../../../utils/pluginArchiveConstants.js";

/**
 * Session CALLs a Shell uses to compare its plugins with a host's and to put
 * one package on the host when the person asks. Session-level, not
 * view-level: Settings can compare and install with no window on the host.
 */
export const PluginParityLinkMethod = {
  INVENTORY: "plugins.parity.inventory",
  /** Reserve a private slot on the host for one package of this size and digest. */
  STAGE_BEGIN: "plugins.parity.stage-begin",
  STAGE_CHUNK: "plugins.parity.stage-chunk",
  /** Verify the staged package and run the host's own install path on it. */
  STAGE_INSTALL: "plugins.parity.stage-install",
  STAGE_DISCARD: "plugins.parity.stage-discard",
  /** What became of an install by its operation id: running (with its phase), settled, or unknown. */
  INSTALL_STATUS: "plugins.parity.install-status",
} as const;

/** A package travels in pieces this size, so no one frame holds a whole plugin. */
export const STAGE_CHUNK_BYTES = 512 * 1024;
export const MAX_STAGED_BYTES = MAX_DNTR_BYTES;

const token = z.string().regex(/^[0-9a-f]{32}$/);
/** Same shape the operations registry accepts for a client-minted id. */
const opId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
/** Same shape the local install handlers accept for a renderer-minted job id. */
const jobId = z.string().regex(/^[0-9a-fA-F-]{8,64}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const EmptySchema = z.object({}).strict();
export const StageBeginSchema = z.object({
  size: z.number().int().positive().max(MAX_STAGED_BYTES),
  sha256,
  /**
   * The window's install job, registered on the host from here on so its
   * Cancel (which the window sends to the host) stops the transfer or the
   * install, up to the installer's commit point.
   */
  jobId: jobId.optional(),
});
export const StageBeginResultSchema = z.object({ token });
export const StageChunkSchema = z.object({
  token,
  offset: z.number().int().nonnegative().max(MAX_STAGED_BYTES),
  bytes: z.instanceof(Uint8Array).refine((value) => value.byteLength <= STAGE_CHUNK_BYTES, {
    message: "chunk too large",
  }),
});
export const StageInstallSchema = z.object({
  token,
  /** The plugin the person asked for; a package for any other plugin is refused. */
  pluginId: z.string().min(1).max(256).optional(),
  /** "Update on host": the plugin must already be installed there. */
  update: z.boolean(),
  /**
   * Minted by the Shell per install. The host runs one install per id and
   * keeps its outcome for a while, so a Shell whose answer was lost can ask
   * what happened instead of installing again.
   */
  opId: opId.optional(),
});
export const StageTokenSchema = z.object({ token });
export const InstallStatusSchema = z.object({ opId });

/** The host's record of an install, validated before this Shell acts on it. */
export const InstallStatusResultSchema = z.union([
  z.object({
    status: z.literal("running"),
    progress: z
      .object({ stage: z.string().max(64).nullable() })
      .passthrough()
      .nullable(),
  }),
  z.object({ status: z.literal("succeeded"), result: z.unknown() }).passthrough(),
  z
    .object({
      status: z.literal("failed"),
      error: z.object({ code: z.string().max(64).nullable(), message: z.string().max(4096) }),
    })
    .passthrough(),
  z.object({ status: z.literal("cancelled") }).passthrough(),
  z.object({ status: z.literal("unknown") }),
]);
export type InstallStatusResult = z.infer<typeof InstallStatusResultSchema>;

const installError = z.object({
  code: z.string().max(64),
  path: z.array(z.string().max(256)).max(32).optional(),
  message: z.string().max(4096),
});

/** The host's install answer, validated before this Shell trusts its shape. */
export const StageInstallResultSchema: z.ZodType<PluginInstallResult> = z.union([
  z.object({ status: z.literal("installed"), pluginId: z.string().min(1).max(256) }),
  z.object({ status: z.literal("failed"), errors: z.array(installError).max(64) }),
  z.object({ status: z.literal("cancelled") }),
  z.object({ status: z.literal("invalid-url") }),
  z.object({ status: z.literal("not-implemented") }),
]) as z.ZodType<PluginInstallResult>;
