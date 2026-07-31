import { describe, expect, it } from "vitest";
import type { Issue, PR, Page } from "@shared/types/forge";
import {
  ForgeIssueSummarySchema,
  ForgePRSummarySchema,
  projectForgePage,
  projectIssueSummary,
  projectPRSummary,
} from "../forgeListProjection";

const issue: Issue = {
  number: 11527,
  title: "Forge issue and PR lists cannot be filtered or scoped",
  body: "the whole issue body".repeat(500),
  state: "open",
  rawState: "OPEN",
  url: "https://fake.test/issues/11527",
  author: { login: "gpriday", avatarUrl: "https://avatars.test/1", rawData: { big: "x" } },
  assignees: [{ login: "octocat", avatarUrl: "https://avatars.test/2", rawData: { big: "y" } }],
  labels: [
    { name: "bug", color: "ff0000" },
    { name: "human-review", color: "00ff00" },
  ],
  commentCount: 4,
  linkedPR: { number: 900, state: "open", url: "https://fake.test/pull/900", ciStatus: "success" },
  createdAt: 1000,
  updatedAt: 2000,
  closedAt: null,
  rawData: { node: "the entire verbatim graphql node".repeat(500) },
};

const pr: PR = {
  number: 900,
  title: "Fix the thing",
  body: "the whole pr body".repeat(500),
  state: "open",
  rawState: "OPEN",
  isDraft: false,
  merged: false,
  url: "https://fake.test/pull/900",
  author: { login: "gpriday", avatarUrl: "https://avatars.test/1", rawData: { big: "x" } },
  baseRef: "develop",
  headRef: "feature/thing",
  mergeable: undefined,
  reviewDecision: "APPROVED",
  commentCount: 2,
  ciStatus: "success",
  createdAt: 1000,
  updatedAt: 2000,
  closedAt: null,
  mergedAt: null,
  rawData: { node: "the entire verbatim graphql node".repeat(500) },
};

describe("summary projection drops what a chooser does not need", () => {
  it("emits no rawData anywhere in an issue row, nested actors included", () => {
    expect(JSON.stringify(projectIssueSummary(issue))).not.toContain("rawData");
  });

  it("emits no rawData anywhere in a PR row", () => {
    expect(JSON.stringify(projectPRSummary(pr))).not.toContain("rawData");
  });

  it("drops the body, which dominates the row for a long issue", () => {
    const summary = projectIssueSummary(issue);
    expect("body" in summary).toBe(false);
    expect(JSON.stringify(summary).length).toBeLessThan(JSON.stringify(issue).length / 20);
  });

  it("flattens actors and labels to the identifiers an agent acts on", () => {
    const summary = projectIssueSummary(issue);
    expect(summary.author).toBe("gpriday");
    expect(summary.assignees).toEqual(["octocat"]);
    expect(summary.labels).toEqual(["bug", "human-review"]);
  });

  it("keeps linkedPR, which answers whether the work is already taken", () => {
    expect(projectIssueSummary(issue).linkedPR).toEqual({
      number: 900,
      state: "open",
      url: "https://fake.test/pull/900",
      ciStatus: "success",
    });
  });

  it("keeps the PR fields a reviewer triages on", () => {
    const summary = projectPRSummary(pr);
    expect(summary).toMatchObject({
      number: 900,
      isDraft: false,
      merged: false,
      baseRef: "develop",
      headRef: "feature/thing",
      reviewDecision: "APPROVED",
      ciStatus: "success",
    });
  });

  it("produces rows that satisfy the declared result schema", () => {
    expect(ForgeIssueSummarySchema.safeParse(projectIssueSummary(issue)).success).toBe(true);
    expect(ForgePRSummarySchema.safeParse(projectPRSummary(pr)).success).toBe(true);
  });
});

describe("summary projection is total", () => {
  it("survives an issue carrying only the contract's required fields", () => {
    const minimal: Issue = {
      number: 1,
      title: "",
      body: "",
      state: "open",
      rawState: "OPEN",
      url: "",
      assignees: [],
      labels: [],
      createdAt: 0,
      updatedAt: 0,
      rawData: null,
    };
    const summary = projectIssueSummary(minimal);
    expect(summary.author).toBeNull();
    expect(ForgeIssueSummarySchema.safeParse(summary).success).toBe(true);
  });

  it("omits optional keys rather than emitting them as undefined", () => {
    const noExtras: Issue = { ...issue, commentCount: undefined, linkedPR: undefined };
    const summary = projectIssueSummary(noExtras);
    expect("commentCount" in summary).toBe(false);
    expect("linkedPR" in summary).toBe(false);
  });
});

describe("projectForgePage", () => {
  const page: Page<Issue> = {
    items: [issue],
    nextCursor: "cursor-2",
    hasMore: true,
    totalCount: 42,
  };

  it("returns the very same page object for 'full', never a rebuilt copy", () => {
    expect(projectForgePage(page, "full", projectIssueSummary)).toBe(page);
  });

  it("rebuilds only items for 'summary', carrying the envelope through", () => {
    const projected = projectForgePage(page, "summary", projectIssueSummary);
    expect(projected).not.toBe(page);
    expect(projected.nextCursor).toBe("cursor-2");
    expect(projected.hasMore).toBe(true);
    expect(projected.totalCount).toBe(42);
    expect(projected.items).toHaveLength(1);
  });

  it("leaves the provider's page untouched so a shared cached page is not mutated", () => {
    projectForgePage(page, "summary", projectIssueSummary);
    expect(page.items[0]).toBe(issue);
    expect(page.items[0]?.body).toBe(issue.body);
  });

  it("handles an empty page without inventing an envelope", () => {
    const empty: Page<Issue> = { items: [], nextCursor: null, hasMore: false };
    const projected = projectForgePage(empty, "summary", projectIssueSummary);
    expect(projected.items).toEqual([]);
    expect(projected.nextCursor).toBeNull();
    expect("totalCount" in projected).toBe(false);
  });
});
