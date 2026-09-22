import { z } from "zod";
import type { DocumentIdentity } from "./ids.js";

/**
 * The contract between the Markdown editor's main-side handlers and its
 * renderer view (#12323). Everything the renderer sends names the document by
 * its full identity, fixed when Edit mode opened, so no handler ever acts on
 * whichever project or worktree happens to be active when a call lands.
 *
 * The zod-free ids, channels and helpers live in `./ids.js` and are re-exported
 * here, so the eagerly-globbed renderer entry can reach them without zod.
 */
export * from "./ids.js";

export const DocumentIdentitySchema = z
  .object({
    projectId: z.string().min(1),
    worktreePath: z.string().min(1).nullable(),
    filePath: z.string().min(1),
  })
  .strict();

type Assert<T extends true> = T;
/**
 * Strict identity, not mutual assignability: this form also catches `any`, a
 * readonly modifier, an index signature and an extra optional property, all of
 * which survive a plain `extends` pair in both directions.
 */
type Identical<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/**
 * The identity type is hand-written in `ids.ts` to keep zod out of the eager
 * graph; this fails the build if the schema and the interface drift apart.
 */
export type DocumentIdentityMatchesSchema = Assert<
  Identical<z.infer<typeof DocumentIdentitySchema>, DocumentIdentity>
>;

export const EolSchema = z.enum(["\n", "\r\n"]);
export type Eol = z.infer<typeof EolSchema>;

const DocumentMetaSchema = z.object({
  hasBom: z.boolean(),
  eol: EolSchema,
});

export const DocumentReadArgsSchema = z
  .object({ identity: DocumentIdentitySchema, panelId: z.string().min(1) })
  .strict();
export type DocumentReadArgs = z.infer<typeof DocumentReadArgsSchema>;

export const DocumentReadResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    text: z.string(),
    revision: z.string(),
    hasBom: z.boolean(),
    eol: EolSchema,
    mixedEol: z.boolean(),
    size: z.number().int().nonnegative(),
  }),
  z.object({
    status: z.literal("refused"),
    reason: z.enum(["NOT_MARKDOWN", "NOT_UTF8", "TOO_LARGE", "SYMLINK", "NOT_A_FILE"]),
  }),
  z.object({ status: z.literal("unavailable") }),
]);
export type DocumentReadResult = z.infer<typeof DocumentReadResultSchema>;

export const DocumentRevalidateArgsSchema = z.object({ identity: DocumentIdentitySchema }).strict();
export const DocumentRevalidateResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), revision: z.string() }),
  z.object({ status: z.literal("unavailable") }),
]);
export type DocumentRevalidateResult = z.infer<typeof DocumentRevalidateResultSchema>;

export const DocumentSaveArgsSchema = z
  .object({
    identity: DocumentIdentitySchema,
    text: z.string(),
    expectedRevision: z.string().regex(/^[0-9a-f]{64}$/),
    /** True when the buffer equals the base text: an unedited save writes nothing. */
    unchanged: z.boolean(),
  })
  .merge(DocumentMetaSchema)
  .strict();
export type DocumentSaveArgs = z.infer<typeof DocumentSaveArgsSchema>;

export const DocumentSaveResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("saved"), revision: z.string(), wrote: z.boolean() }),
  z.object({
    status: z.literal("conflict"),
    revision: z.string(),
    text: z.string().nullable(),
    hasBom: z.boolean(),
    eol: EolSchema,
  }),
  z.object({ status: z.literal("unavailable") }),
  z.object({ status: z.literal("refused"), reason: z.enum(["NOT_MARKDOWN", "TOO_LARGE"]) }),
  z.object({ status: z.literal("error"), message: z.string() }),
]);
export type DocumentSaveResult = z.infer<typeof DocumentSaveResultSchema>;

export const DocumentSaveAsArgsSchema = z
  .object({
    identity: DocumentIdentitySchema,
    targetPath: z.string().min(1),
    text: z.string(),
  })
  .merge(DocumentMetaSchema)
  .strict();
export const DocumentSaveAsResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("saved"), path: z.string(), revision: z.string() }),
  z.object({ status: z.literal("exists") }),
  z.object({
    status: z.literal("refused"),
    reason: z.enum(["NOT_MARKDOWN", "TOO_LARGE", "OUTSIDE_ROOT"]),
  }),
  z.object({ status: z.literal("error"), message: z.string() }),
]);
export type DocumentSaveAsResult = z.infer<typeof DocumentSaveAsResultSchema>;

export const DocumentReleaseArgsSchema = z
  .object({ identity: DocumentIdentitySchema, panelId: z.string().min(1) })
  .strict();

/** A second panel joining a document another panel already read: refcount only. */
export const DocumentAttachArgsSchema = DocumentReleaseArgsSchema;
export const DocumentAttachResultSchema = z.object({ attached: z.boolean() }).strict();

export const DraftRecordSchema = z
  .object({
    stateVersion: z.literal(1),
    identity: DocumentIdentitySchema,
    baseRevision: z.string(),
    baseText: z.string(),
    draftText: z.string(),
    hasBom: z.boolean(),
    eol: EolSchema,
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type DraftRecord = z.infer<typeof DraftRecordSchema>;

export const DraftPutArgsSchema = z
  .object({
    record: DraftRecordSchema,
    /**
     * Monotonic per document, minted by the renderer. A put that arrives
     * after a delete with a higher-or-equal generation is ignored, so a
     * debounced write can never resurrect a draft the user already saved or
     * discarded.
     */
    generation: z.number().int().nonnegative(),
  })
  .strict();
export const DraftPutResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("stored") }),
  z.object({ status: z.literal("ignored") }),
  z.object({ status: z.literal("full"), records: z.number().int(), bytes: z.number().int() }),
  z.object({ status: z.literal("error"), message: z.string() }),
]);
export type DraftPutResult = z.infer<typeof DraftPutResultSchema>;

export const DraftGetArgsSchema = z.object({ identity: DocumentIdentitySchema }).strict();
export const DraftGetResultSchema = z.object({ record: DraftRecordSchema.nullable() }).strict();

export const DraftListArgsSchema = z.object({}).strict();
export const DraftSummarySchema = z
  .object({
    identity: DocumentIdentitySchema,
    updatedAt: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  })
  .strict();
export type DraftSummary = z.infer<typeof DraftSummarySchema>;
export const DraftListResultSchema = z.object({ drafts: z.array(DraftSummarySchema) }).strict();

export const DraftDeleteArgsSchema = z
  .object({ identity: DocumentIdentitySchema, generation: z.number().int().nonnegative() })
  .strict();
export const DraftDeleteResultSchema = z.object({ deleted: z.boolean() }).strict();

export const RecoverAckArgsSchema = z.object({ requestId: z.string().min(1) }).strict();
export const RecoverAckResultSchema = z.object({ acknowledged: z.boolean() }).strict();
