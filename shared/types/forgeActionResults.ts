import { z } from "zod";

/**
 * The results the forge actions hand an agent, as their `resultSchema`s
 * declare them. Dispatch parses each result through its schema (#11539), so
 * these name every field that is delivered and strip the rest — the
 * provider's raw node above all. Shared so a host answering a forge read with
 * no view open (#13501) delivers exactly what a view's dispatch would.
 */

// A forge label, as both the write actions and the issue result describe it.
export const ForgeLabelResultSchema = z.object({ name: z.string(), color: z.string().optional() });

/**
 * A forge user, minus `rawData`. `ForgeUser` carries the provider's entire
 * unnormalized node on that field, so an `z.array(z.unknown())` assignee arm
 * shipped every GitHub/GitLab user attribute to agents unannounced (#11539).
 * Naming the two portable fields is what drops it — dispatch strips the rest.
 */
export const ForgeUserResultSchema = z.object({
  login: z.string(),
  avatarUrl: z.string().optional(),
});

// Compact projection of the PR an issue links to, mirroring `LinkedPRSummary`.
const ForgeLinkedPRResultSchema = z.object({
  number: z.number(),
  state: z.string(),
  url: z.string(),
  ciStatus: z.string().optional(),
  mergeState: z.string().optional(),
});

// Normalized PR shape returned by getPR/createPR/editPR. Every cross-provider
// field of `PR` is named except `rawData`, the verbatim provider node — dispatch
// parses results now (#11539), so an omission here is a field an agent stops
// receiving, not just one the manifest fails to mention. `reviewDecision` and
// `ciStatus` in particular are what a caller reads to judge a PR.
//
// Fields the `PR` interface marks required (`rawState`, `createdAt`, `updatedAt`)
// are declared optional anyway: providers are plugins, and a value the host never
// verifies should degrade to an absent key rather than reject the whole result.
export const ForgePRResultSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string(),
  state: z.string(),
  rawState: z.string().optional().describe("The forge's own spelling of the state"),
  isDraft: z.boolean(),
  merged: z.boolean(),
  url: z.string(),
  author: ForgeUserResultSchema.optional(),
  baseRef: z.string(),
  headRef: z.string(),
  mergeable: z
    .boolean()
    .nullable()
    .optional()
    .describe("null when the provider has not computed mergeability yet"),
  // `null` is a real answer — "this provider gates on no review" — and readers
  // treat it as equivalent to approved. Only `undefined` ("not reported") drops.
  reviewDecision: z
    .string()
    .nullable()
    .optional()
    .describe("APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or null when reviews aren't gated"),
  ciStatus: z
    .string()
    .optional()
    .describe("Roll-up head-commit CI state: success, failure, pending, neutral or unknown"),
  mergeState: z.string().optional(),
  commentCount: z.number().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  closedAt: z.number().nullable().optional(),
  mergedAt: z.number().nullable().optional(),
});

// Object-rooted wrapper for the singular lookup, so it can advertise an MCP
// output schema. `pr: null` is the not-found answer and is part of the
// contract — absence, never an error.
export const ForgePRActionResultSchema = z.object({
  pr: ForgePRResultSchema.nullable(),
});

// Roll-up CI state vocabulary, mirroring `CIStatusState`. `neutral` means the
// PR has no required checks configured; `unknown` means the provider reported
// checks whose state doesn't map onto the other four.
const ForgeCIStatusStateSchema = z.enum(["success", "failure", "pending", "neutral", "unknown"]);

const ForgeCIStatusSchema = z.object({
  state: ForgeCIStatusStateSchema,
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  requiredChecksPassing: z.boolean().optional(),
});

// Wrapped rather than a bare `.nullable()` so the MCP output schema stays
// object-typed: `buildToolOutputSchema` drops any schema whose top-level `type`
// isn't "object", and Zod emits `anyOf` for a nullable object — which would
// silently advertise no schema at all.
export const ForgeCIStatusActionResultSchema = z.object({
  ciStatus: ForgeCIStatusSchema.nullable(),
});

// Normalized issue returned by `forge.getIssue` and by the
// create/close/reopen/edit write actions. Same reasoning as
// `ForgePRResultSchema`: every cross-provider field of `Issue` bar `rawData` is
// named, because dispatch strips whatever isn't. `author` and `commentCount` are
// both promised by action descriptions, so omitting them made those false.
export const ForgeIssueResultSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string(),
  state: z.string(),
  rawState: z.string().optional().describe("The forge's own spelling of the state"),
  url: z.string(),
  author: ForgeUserResultSchema.optional(),
  labels: z.array(ForgeLabelResultSchema).optional(),
  assignees: z.array(ForgeUserResultSchema).optional(),
  commentCount: z.number().optional(),
  linkedPR: ForgeLinkedPRResultSchema.optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  closedAt: z.number().nullable().optional(),
});

// Comment returned by the add-comment write action.
export const ForgeCommentResultSchema = z.object({
  id: z.string(),
  body: z.string(),
  url: z.string(),
  createdAt: z.number(),
});

// One page of an issue's comment thread, from the read action. Reuses the
// single-comment shape so the read and write halves describe a comment
// identically, plus the author the write action doesn't echo back.
export const ForgeCommentPageResultSchema = z.object({
  items: z.array(ForgeCommentResultSchema.extend({ author: ForgeUserResultSchema.optional() })),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  totalCount: z.number().optional(),
});

/**
 * One requested number's outcome, discriminated by `status`.
 *
 * A union rather than one object with three independently optional fields,
 * because an advertised output schema is enforced: the SDK compiles it and
 * validates `structuredContent` against it with AJV. Flat optionals advertised
 * `{status:"found"}` with no `pr`, and `{status:"not_found", pr}`, as valid —
 * contradictions a strict client would have accepted and a model could have
 * expected. Discriminating makes `pr` required exactly where it exists and
 * `reason` required exactly where it means something.
 */
const ForgePRLookupResultSchema = z.discriminatedUnion("status", [
  z.object({
    number: z.number().int().positive(),
    status: z.literal("found").describe("The forge returned this pull request."),
    pr: ForgePRResultSchema,
  }),
  z.object({
    number: z.number().int().positive(),
    status: z
      .literal("not_found")
      .describe("The forge was asked and has no such pull request. This is an answer."),
  }),
  z.object({
    number: z.number().int().positive(),
    status: z
      .literal("unresolved")
      .describe(
        "Nothing was learned about this number — the request failed or was rate-limited. Retriable, and NOT evidence the pull request is missing."
      ),
    reason: z
      .enum(["provider_unsupported", "provider_error"])
      .describe(
        "Why nothing was learned. `provider_error` is a failed or rate-limited request; `provider_unsupported` adds that the provider has no batch lookup at all. Both are retriable."
      ),
  }),
]);

export const ForgePRsActionResultSchema = z.object({
  results: z
    .array(ForgePRLookupResultSchema)
    .describe(
      "One entry per requested number, in the order requested. Duplicate numbers collapse to their first occurrence, so this can be shorter than the input."
    ),
});

// One CI check, mirroring `CheckRun` minus `rawData` — which dispatch strips,
// and which the IPC layer already dropped. `conclusion` is absent while a check
// is unfinished AND when the provider reported an outcome this vocabulary
// doesn't model, so its absence never means "passed".
const ForgeCheckRunSchema = z.object({
  name: z.string().describe("Check name as the forge reports it; matrix jobs repeat names"),
  status: z.enum(["queued", "in_progress", "completed"]),
  conclusion: z
    .enum(["success", "failure", "neutral", "cancelled", "timed_out", "action_required", "skipped"])
    .optional()
    .describe("Outcome once completed; absent while running or when the forge reported no verdict"),
  required: z
    .boolean()
    .optional()
    .describe("Whether this check gates merging, when the provider reports required checks"),
  detailsUrl: z.string().optional().describe("Link to this check's output or job log"),
});

// Wrapped for the same reason as `ForgeCIStatusActionResultSchema` — a bare
// nullable array would emit a top-level `anyOf` that `buildToolOutputSchema`
// drops, advertising no schema at all.
export const ForgeChecksActionResultSchema = z.object({
  checks: z.array(ForgeCheckRunSchema).nullable(),
});
