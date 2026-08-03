import { z } from "zod";
import type { Issue, PR, Page } from "@shared/types/forge";

/**
 * How much of each list row `forge.listIssues`/`forge.listPRs` return.
 *
 * `summary` (the default) is the decision-making projection: enough to pick
 * what to work on, nothing more. `full` is the escape hatch — the provider's
 * normalized object verbatim, `rawData` and body included.
 *
 * This exists because a page of full rows is enormous: measured against 7 real
 * open issues, one `forge.listIssues` page was 46,651 bytes, of which `rawData`
 * — the verbatim GraphQL node, already redundant with the mapped fields — was
 * 25,912 (#11527).
 */
export const ForgeListViewSchema = z
  .enum(["summary", "full"])
  .optional()
  .describe(
    "Row detail: 'summary' (default) drops each row's body and raw provider payload, keeping the fields needed to choose an item; 'full' returns the complete provider object."
  );

export type ForgeListView = "summary" | "full";

/**
 * Actor projection for summary rows: the login is the only part an agent acts
 * on. `avatarUrl` is UI-only and `rawData` is a nested copy of the provider
 * node — dropping both is most of the per-row saving.
 */
const SummaryUserSchema = z.string();

const SummaryLinkedPRSchema = z.object({
  number: z.number(),
  state: z.string(),
  url: z.string(),
  ciStatus: z.string().optional(),
});

export const ForgeIssueSummarySchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  url: z.string(),
  author: SummaryUserSchema.nullable(),
  assignees: z.array(SummaryUserSchema),
  labels: z.array(z.string()),
  commentCount: z.number().optional(),
  /** The PR already working this issue, when one exists. */
  linkedPR: SummaryLinkedPRSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  closedAt: z.number().nullable().optional(),
});

export const ForgePRSummarySchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  merged: z.boolean(),
  url: z.string(),
  author: SummaryUserSchema.nullable(),
  baseRef: z.string(),
  headRef: z.string(),
  /**
   * `null` is a real answer — "this provider gates on no review" — and readers
   * treat it as equivalent to approved (see `reviewReadiness.ts`). Only
   * `undefined`, meaning "not reported", may be dropped.
   */
  reviewDecision: z.string().nullable().optional(),
  ciStatus: z.string().optional(),
  commentCount: z.number().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  closedAt: z.number().nullable().optional(),
  mergedAt: z.number().nullable().optional(),
});

export type ForgeIssueSummary = z.infer<typeof ForgeIssueSummarySchema>;
export type ForgePRSummary = z.infer<typeof ForgePRSummarySchema>;

const pageEnvelope = {
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  totalCount: z.number().optional(),
};

/**
 * Declared result shapes. `ActionService.dispatch` parses results against these
 * (#11539), but the `z.unknown()` arm below opts that row out of stripping, so
 * for `view: "full"` a field still only stops being sent when the projector
 * below stops building it.
 *
 * Each `items` arm is a row under one `view`: the summary schema documents the
 * default projection, and `z.unknown()` stands for `view: "full"`, whose row is
 * the provider's own normalized object — provider-defined, so nothing narrower
 * is true of it. The arm is also load-bearing rather than decorative:
 * `resultSchema` infers the `run()` return type, and without it the `full`
 * branch returning the untouched `Page<T>` fails to type-check. Both arms are
 * allowlisted in `resultSchemaHygiene.test.ts` for exactly this reason.
 */
export const ForgeIssuePageResultSchema = z.object({
  items: z.array(z.union([ForgeIssueSummarySchema, z.unknown()])),
  ...pageEnvelope,
});

export const ForgePRPageResultSchema = z.object({
  items: z.array(z.union([ForgePRSummarySchema, z.unknown()])),
  ...pageEnvelope,
});

function toLogin(user: { login: string } | undefined): string | null {
  return user?.login ?? null;
}

/**
 * Project one issue. Total by construction — it reads only fields the forge
 * `Issue` contract guarantees and never throws, so a single odd row cannot
 * fail the whole list call the way `schema.parse(item)` would.
 */
export function projectIssueSummary(issue: Issue): ForgeIssueSummary {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    url: issue.url,
    author: toLogin(issue.author),
    assignees: issue.assignees.map((a) => a.login),
    labels: issue.labels.map((l) => l.name),
    ...(issue.commentCount !== undefined ? { commentCount: issue.commentCount } : {}),
    ...(issue.linkedPR
      ? {
          linkedPR: {
            number: issue.linkedPR.number,
            state: issue.linkedPR.state,
            url: issue.linkedPR.url,
            ...(issue.linkedPR.ciStatus ? { ciStatus: issue.linkedPR.ciStatus } : {}),
          },
        }
      : {}),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    ...(issue.closedAt !== undefined ? { closedAt: issue.closedAt } : {}),
  };
}

/** PR counterpart to {@link projectIssueSummary}; same totality guarantee. */
export function projectPRSummary(pr: PR): ForgePRSummary {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    isDraft: pr.isDraft,
    merged: pr.merged,
    url: pr.url,
    author: toLogin(pr.author),
    baseRef: pr.baseRef,
    headRef: pr.headRef,
    ...(pr.reviewDecision !== undefined ? { reviewDecision: pr.reviewDecision } : {}),
    ...(pr.ciStatus ? { ciStatus: pr.ciStatus } : {}),
    ...(pr.commentCount !== undefined ? { commentCount: pr.commentCount } : {}),
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    ...(pr.closedAt !== undefined ? { closedAt: pr.closedAt } : {}),
    ...(pr.mergedAt !== undefined ? { mergedAt: pr.mergedAt } : {}),
  };
}

/**
 * Apply a {@link ForgeListView} to a provider page. `full` returns the page
 * untouched — same object identity, so renderer callers sharing a cached page
 * are never handed a rebuilt copy. `summary` rebuilds `items` only and carries
 * the pagination envelope through verbatim.
 */
export function projectForgePage<T, S>(
  page: Page<T>,
  view: ForgeListView,
  project: (item: T) => S
): Page<T> | (Omit<Page<T>, "items"> & { items: S[] }) {
  if (view === "full") return page;
  return { ...page, items: page.items.map(project) };
}
