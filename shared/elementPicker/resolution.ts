import { z } from "zod";
import { SourceLocationSchema } from "./coordinates.js";
import { PickerIdSchema, SourceClaimKindSchema } from "./source.js";

/**
 * A hash of the raw bytes the host read, before decoding or BOM handling.
 * Opaque: consumers compare revisions for equality and never parse them. A
 * content hash rather than a timestamp, because an agent's same-second,
 * same-size rewrite has to read as a change.
 */
export const FileRevisionSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export type FileRevision = z.infer<typeof FileRevisionSchema>;

function isWorkspaceRelative(path: string): boolean {
  if (path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * A file the host resolved inside a workspace it holds authority over. Only
 * the host mints these: a page reports paths and URLs as evidence, and this is
 * what one becomes once the host has contained it.
 */
export const SourceFileRefSchema = z.strictObject({
  workspaceId: PickerIdSchema,
  /** POSIX, relative to the workspace root, with no `.`, `..` or empty segments. */
  path: z
    .string()
    .min(1)
    .max(1024)
    .refine(isWorkspaceRelative, { message: "path must be workspace-relative" }),
});
export type SourceFileRef = z.infer<typeof SourceFileRefSchema>;

/** Null `location` is a file and nothing finer: what a file-only hint resolves to, checked or not. */
export const SourceTargetSchema = z.strictObject({
  file: SourceFileRefSchema,
  location: SourceLocationSchema.nullable(),
});
export type SourceTarget = z.infer<typeof SourceTargetSchema>;

/**
 * Which source map turned a generated position into this target. The
 * generated position itself is the candidate's. `mapRevision` hashes the map
 * bytes, so an HMR update that changes the map is visible as a change even
 * when the authored file is untouched.
 */
export const SourceMapProvenanceSchema = z.strictObject({
  /** Null when the map was inlined in the generated module. */
  mapUrl: z.string().min(1).max(2048).nullable(),
  mapRevision: FileRevisionSchema,
});
export type SourceMapProvenance = z.infer<typeof SourceMapProvenanceSchema>;

export const RESOLUTION_LIMITS = { alternatives: 8 } as const;

export const StaleReasonSchema = z.enum([
  "file-changed",
  "file-missing",
  "map-changed",
  "document-changed",
]);
export type StaleReason = z.infer<typeof StaleReasonSchema>;

export const UnavailableReasonSchema = z.enum([
  "outside-workspace",
  "file-missing",
  "map-missing",
  /** The file was read and the claim does not hold in it. */
  "mismatch",
  "unsupported",
  "budget-exhausted",
  "cancelled",
]);
export type UnavailableReason = z.infer<typeof UnavailableReasonSchema>;

const claimFields = { candidateId: PickerIdSchema, claim: SourceClaimKindSchema };

const AlternativeSchema = z.strictObject({
  target: SourceTargetSchema,
  fileRevision: FileRevisionSchema.nullable(),
  sourceMap: SourceMapProvenanceSchema.optional(),
});

/**
 * What the host made of one candidate. Each state says how far the claim got,
 * in place of a confidence number that would flatten all of them into one
 * scale nobody can audit:
 *
 * - `observed`: as the runtime reported it, contained to a workspace file but
 *   not mapped and not checked against the file's contents;
 * - `mapped`: through the named source map, not checked against the file;
 * - `verified`: checked against the file at `fileRevision`;
 * - `ambiguous`: more than one target fits, and none is chosen;
 * - `stale`: held at `fileRevision`, and no longer does;
 * - `unavailable`: no target, and a code saying why.
 *
 * `fileRevision` is required wherever a file is named, and null only where the
 * host never read it: a revision is never implied by a state that did not
 * involve reading the file.
 */
export const ResolutionResultSchema = z
  .discriminatedUnion("state", [
    z.strictObject({
      state: z.literal("observed"),
      ...claimFields,
      target: SourceTargetSchema,
      fileRevision: FileRevisionSchema.nullable(),
    }),
    z.strictObject({
      state: z.literal("mapped"),
      ...claimFields,
      target: SourceTargetSchema,
      fileRevision: FileRevisionSchema.nullable(),
      sourceMap: SourceMapProvenanceSchema,
    }),
    z.strictObject({
      state: z.literal("verified"),
      ...claimFields,
      target: SourceTargetSchema,
      fileRevision: FileRevisionSchema,
      /** Present when mapping came before the check. */
      sourceMap: SourceMapProvenanceSchema.optional(),
    }),
    z.strictObject({
      state: z.literal("ambiguous"),
      ...claimFields,
      alternatives: z.array(AlternativeSchema).min(2).max(RESOLUTION_LIMITS.alternatives),
    }),
    z.strictObject({
      state: z.literal("stale"),
      ...claimFields,
      target: SourceTargetSchema,
      /** The revision the claim held at; null when it was never read. */
      fileRevision: FileRevisionSchema.nullable(),
      /** What is on disk now; null when the file is gone or was not reread. */
      currentFileRevision: FileRevisionSchema.nullable(),
      reason: StaleReasonSchema,
    }),
    z.strictObject({
      state: z.literal("unavailable"),
      ...claimFields,
      reason: UnavailableReasonSchema,
    }),
  ])
  .superRefine((result, ctx) => {
    if (result.claim !== "file-hint") return;
    const targets =
      result.state === "ambiguous"
        ? result.alternatives.map((alternative) => alternative.target)
        : result.state === "unavailable"
          ? []
          : [result.target];
    if (targets.some((target) => target.location !== null)) {
      ctx.addIssue({ code: "custom", message: "a file-hint never resolves to a location" });
    }
  });
export type ResolutionResult = z.infer<typeof ResolutionResultSchema>;
