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
} as const;

/** A package travels in pieces this size, so no one frame holds a whole plugin. */
export const STAGE_CHUNK_BYTES = 512 * 1024;
export const MAX_STAGED_BYTES = MAX_DNTR_BYTES;

const token = z.string().regex(/^[0-9a-f]{32}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const EmptySchema = z.object({}).strict();
export const StageBeginSchema = z.object({
  size: z.number().int().positive().max(MAX_STAGED_BYTES),
  sha256,
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
});
export const StageTokenSchema = z.object({ token });

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
