import { z } from "zod";
import type {
  ResolveRequest,
  RevisionedSource,
  RevisionedSourceMap,
  SourceAccessResult,
} from "../../../shared/elementPicker/resolver.js";
import type { SourceFileRef } from "../../../shared/elementPicker/resolution.js";

/**
 * The wire between main and the Element Picker source host. Ids are main's:
 * `jobId` names one resolve, `accessId` one source read the host asked for
 * while running it. Each child has its own listeners, so a message from a
 * retired child never reaches the one that replaced it, and no generation
 * travels on the wire.
 *
 * The host is sent bytes, never a path: a `read-source` names a host-issued
 * `SourceFileRef` and main decides what, if anything, it reads.
 */

/** Main → host. */
export type HostInbound =
  | { type: "resolve"; jobId: number; request: ResolveRequest }
  /** Stop the job; work not yet done reports `cancelled`. */
  | { type: "cancel"; jobId: number }
  | {
      type: "access-result";
      jobId: number;
      accessId: number;
      result:
        | SourceAccessResult<RevisionedSource>
        | SourceAccessResult<RevisionedSourceMap>
        | SourceAccessResult<SourceFileRef>;
    }
  /** Exit now. Main has already settled every job the host held. */
  | { type: "dispose" };

/**
 * Main → a plugin's resolver host only: the module to load a provider's
 * resolver from, sent before the first job that names the provider. The URL is
 * main's, resolved from the registry and contained in the plugin's directory;
 * nothing a request carries ever chooses what the host imports.
 */
export interface ProviderInbound {
  type: "provider";
  providerId: string;
  entryUrl: string;
}

export type PluginHostInbound = HostInbound | ProviderInbound;

const JobIdSchema = z.number().int().positive();

/**
 * Host → main, validated on arrival. Payloads stay `unknown` here: a bad file
 * ref is a refused read and a bad response a failed resolve, neither a reason
 * to stop the host, so each is checked where its failure is decided.
 */
export const HostOutboundSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ready") }),
  z.strictObject({ type: z.literal("resolved"), jobId: JobIdSchema, response: z.unknown() }),
  z.strictObject({
    type: z.literal("failed"),
    jobId: JobIdSchema,
    message: z.string().max(1024),
  }),
  z.strictObject({
    type: z.literal("read-source"),
    jobId: JobIdSchema,
    accessId: JobIdSchema,
    file: z.unknown(),
  }),
  z.strictObject({
    type: z.literal("fetch-source-map"),
    jobId: JobIdSchema,
    accessId: JobIdSchema,
    generatedUrl: z.string().min(1).max(2048),
  }),
  z.strictObject({
    type: z.literal("locate-source"),
    jobId: JobIdSchema,
    accessId: JobIdSchema,
    generatedUrl: z.string().min(1).max(2048),
    source: z.string().max(4096),
    sourceRoot: z.string().max(4096).nullable(),
  }),
  z.strictObject({
    type: z.literal("locate-file"),
    jobId: JobIdSchema,
    accessId: JobIdSchema,
    reported: z.string().min(1).max(2048),
  }),
  // Unbounded: a bootstrap failure posts a whole stack, and refusing it would
  // misreport a failed start as a malformed message.
  z.strictObject({ type: z.literal("fatal"), message: z.string() }),
]);

/** What the host sends; `unknown` payloads are typed at the sending end. */
export type HostOutbound =
  | { type: "ready" }
  | { type: "resolved"; jobId: number; response: unknown }
  | { type: "failed"; jobId: number; message: string }
  | { type: "read-source"; jobId: number; accessId: number; file: unknown }
  | { type: "fetch-source-map"; jobId: number; accessId: number; generatedUrl: string }
  | {
      type: "locate-source";
      jobId: number;
      accessId: number;
      generatedUrl: string;
      source: string;
      sourceRoot: string | null;
    }
  | { type: "locate-file"; jobId: number; accessId: number; reported: string }
  | { type: "fatal"; message: string };
