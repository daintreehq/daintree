import { describe, expect, it } from "vitest";
import {
  extractLinkedPR,
  gitHubIssueToForgeIssue,
  gitHubPRToForgePR,
  mapMergeStateStatus,
  restToForgePR,
  toForgeIssue,
  toForgePR,
} from "../mappers.js";
import {
  LIST_ISSUES_QUERY,
  SEARCH_QUERY,
  GET_ISSUE_QUERY,
  GET_PR_QUERY,
  REPO_STATS_AND_PAGE_QUERY,
  buildBatchBranchPRQuery,
  buildBatchIssuesQuery,
  buildBatchPRsQuery,
} from "../GitHubQueries.js";
import type { GitHubIssue, GitHubPR } from "../../shared/types.js";

const crossReferenced = (pr: Record<string, unknown>) => ({ source: pr });
const connected = (pr: Record<string, unknown>) => ({ subject: pr });

describe("extractLinkedPR", () => {
  it("reads the PR from both timeline event shapes", () => {
    const fromSource = extractLinkedPR({
      nodes: [crossReferenced({ number: 1, url: "u1", state: "OPEN" })],
    });
    const fromSubject = extractLinkedPR({
      nodes: [connected({ number: 1, url: "u1", state: "OPEN" })],
    });
    expect(fromSource).toEqual(fromSubject);
    expect(fromSource?.number).toBe(1);
  });

  it("prefers the most recently updated PR over the rest", () => {
    const linked = extractLinkedPR({
      nodes: [
        crossReferenced({ number: 1, url: "u1", state: "OPEN", updatedAt: "2026-01-01T00:00:00Z" }),
        crossReferenced({ number: 2, url: "u2", state: "OPEN", updatedAt: "2026-06-01T00:00:00Z" }),
        crossReferenced({ number: 3, url: "u3", state: "OPEN", updatedAt: "2026-03-01T00:00:00Z" }),
      ],
    });
    expect(linked?.number).toBe(2);
  });

  it("falls back to the highest number when no timestamps distinguish them", () => {
    const linked = extractLinkedPR({
      nodes: [
        crossReferenced({ number: 5, url: "u5", state: "OPEN" }),
        crossReferenced({ number: 9, url: "u9", state: "OPEN" }),
      ],
    });
    expect(linked?.number).toBe(9);
  });

  it("keeps the first occurrence of a PR referenced more than once", () => {
    const linked = extractLinkedPR({
      nodes: [
        crossReferenced({ number: 4, url: "first", state: "OPEN" }),
        connected({ number: 4, url: "second", state: "CLOSED" }),
      ],
    });
    expect(linked?.url).toBe("first");
  });

  it("reports merged ahead of the raw state", () => {
    const linked = extractLinkedPR({
      nodes: [crossReferenced({ number: 1, url: "u1", state: "CLOSED", merged: true })],
    });
    expect(linked?.state).toBe("MERGED");
  });

  it.each([
    ["no timeline at all", undefined],
    ["a null timeline", null],
    ["a timeline with no nodes array", { nodes: "nope" }],
    ["nodes that are not events", { nodes: [null, 7, "x"] }],
    ["events with neither source nor subject", { nodes: [{}] }],
    ["a PR missing its number", { nodes: [{ source: { url: "u" } }] }],
    ["a PR missing its url", { nodes: [{ source: { number: 1 } }] }],
  ])("returns undefined for %s", (_label, timeline) => {
    expect(extractLinkedPR(timeline)).toBeUndefined();
  });
});

describe("toForgeIssue linkedPR", () => {
  const issueNode = (timelineItems?: unknown) => ({
    number: 11527,
    title: "t",
    bodyText: "b",
    url: "https://fake.test/11527",
    state: "OPEN",
    updatedAt: "2026-07-01T00:00:00Z",
    ...(timelineItems !== undefined ? { timelineItems } : {}),
  });

  it("surfaces the linked PR the list query already pays to fetch", () => {
    const issue = toForgeIssue(
      issueNode({
        nodes: [
          crossReferenced({
            number: 900,
            url: "https://fake.test/pull/900",
            state: "OPEN",
          }),
        ],
      })
    );
    expect(issue.linkedPR).toEqual({
      number: 900,
      state: "open",
      url: "https://fake.test/pull/900",
    });
  });

  it("normalizes the provider state onto the cross-provider contract", () => {
    const merged = toForgeIssue(
      issueNode({
        nodes: [crossReferenced({ number: 1, url: "u", state: "CLOSED", merged: true })],
      })
    );
    const closed = toForgeIssue(
      issueNode({ nodes: [crossReferenced({ number: 1, url: "u", state: "CLOSED" })] })
    );
    expect(merged.linkedPR?.state).toBe("merged");
    expect(closed.linkedPR?.state).toBe("closed");
  });

  it("omits the key entirely when nothing links, rather than emitting undefined", () => {
    const issue = toForgeIssue(issueNode());
    expect("linkedPR" in issue).toBe(false);
  });

  it("still maps an issue whose timeline is malformed", () => {
    const issue = toForgeIssue(issueNode({ nodes: [{ source: null }] }));
    expect(issue.number).toBe(11527);
    expect(issue.linkedPR).toBeUndefined();
  });
});

/**
 * The mapper can only surface a field the query projected. These three queries
 * all feed `toForgeIssue`, so each must carry the timeline selection or
 * `linkedPR` silently vanishes for that path — the exact drift #11527 fixed.
 */
describe("queries feeding toForgeIssue project the linked-PR timeline", () => {
  it.each([
    ["LIST_ISSUES_QUERY", LIST_ISSUES_QUERY],
    ["SEARCH_QUERY", SEARCH_QUERY],
    ["GET_ISSUE_QUERY", GET_ISSUE_QUERY],
  ])("%s selects the fields extractLinkedPR reads", (_name, query) => {
    expect(query).toContain("timelineItems");
    expect(query).toContain("CROSS_REFERENCED_EVENT");
    expect(query).toContain("ConnectedEvent");
  });
});

describe("mapMergeStateStatus", () => {
  it("reports conflicts for DIRTY in either casing", () => {
    expect(mapMergeStateStatus("DIRTY")).toBe("conflicts");
    expect(mapMergeStateStatus("dirty")).toBe("conflicts");
  });

  it.each([["UNKNOWN"], ["CLEAN"], [null], [7]])(
    "reports nothing for %s — not computed or not a conflict is never read as clean",
    (raw) => {
      expect(mapMergeStateStatus(raw)).toBeUndefined();
    }
  );
});

describe("PR mappers carry the merge-conflict observation", () => {
  const graphqlNode = (extra: Record<string, unknown> = {}) => ({
    number: 13049,
    title: "t",
    bodyText: "",
    url: "https://fake.test/pull/13049",
    state: "OPEN",
    updatedAt: "2026-09-01T00:00:00Z",
    ...extra,
  });

  it("toForgePR maps DIRTY to conflicts", () => {
    expect(toForgePR(graphqlNode({ mergeStateStatus: "DIRTY" })).mergeState).toBe("conflicts");
  });

  it("toForgePR omits the key while GitHub is still computing", () => {
    const pr = toForgePR(graphqlNode({ mergeStateStatus: "UNKNOWN" }));
    expect("mergeState" in pr).toBe(false);
  });

  it("toForgePR keeps the CI roll-up alongside the conflict", () => {
    const pr = toForgePR(
      graphqlNode({
        mergeStateStatus: "DIRTY",
        commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
      })
    );
    expect(pr.mergeState).toBe("conflicts");
    expect(pr.ciStatus).toBe("failure");
  });

  it("restToForgePR reads REST's lower-case mergeable_state", () => {
    const raw = { number: 1, state: "open", mergeable: false, mergeable_state: "dirty" };
    expect(restToForgePR(raw).mergeState).toBe("conflicts");
    expect("mergeState" in restToForgePR({ ...raw, mergeable_state: "unknown" })).toBe(false);
  });

  const legacyPR = (extra: Partial<GitHubPR> = {}): GitHubPR => ({
    number: 13049,
    title: "t",
    url: "https://fake.test/pull/13049",
    state: "OPEN",
    isDraft: false,
    updatedAt: "2026-09-01T00:00:00Z",
    author: { login: "a", avatarUrl: "" },
    ...extra,
  });

  it("gitHubPRToForgePR carries the stats-page merge state through", () => {
    expect(gitHubPRToForgePR(legacyPR({ mergeStateStatus: "DIRTY" })).mergeState).toBe("conflicts");
    expect("mergeState" in gitHubPRToForgePR(legacyPR({ mergeStateStatus: "UNKNOWN" }))).toBe(
      false
    );
  });
});

describe("linked PRs carry the merge-conflict observation", () => {
  it.each([
    ["CrossReferencedEvent.source", crossReferenced],
    ["ConnectedEvent.subject", connected],
  ])("toForgeIssue reads it from %s", (_label, wrap) => {
    const issue = toForgeIssue({
      number: 1,
      title: "t",
      url: "u",
      state: "OPEN",
      updatedAt: "2026-09-01T00:00:00Z",
      timelineItems: {
        nodes: [wrap({ number: 2, url: "u2", state: "OPEN", mergeStateStatus: "DIRTY" })],
      },
    });
    expect(issue.linkedPR).toEqual({
      number: 2,
      state: "open",
      url: "u2",
      mergeState: "conflicts",
    });
  });

  it("gitHubIssueToForgeIssue carries it from the legacy linked PR", () => {
    const item: GitHubIssue = {
      number: 1,
      title: "t",
      url: "u",
      state: "OPEN",
      updatedAt: "2026-09-01T00:00:00Z",
      author: { login: "a", avatarUrl: "" },
      assignees: [],
      commentCount: 0,
      linkedPR: { number: 2, state: "OPEN", url: "u2", mergeStateStatus: "DIRTY" },
    };
    expect(gitHubIssueToForgeIssue(item).linkedPR?.mergeState).toBe("conflicts");
  });

  it("omits the key when the linked PR's state is not a conflict", () => {
    const linked = extractLinkedPR({
      nodes: [
        crossReferenced({ number: 2, url: "u2", state: "OPEN", mergeStateStatus: "UNKNOWN" }),
      ],
    });
    const issue = gitHubIssueToForgeIssue({
      number: 1,
      title: "t",
      url: "u",
      state: "OPEN",
      updatedAt: "2026-09-01T00:00:00Z",
      author: { login: "a", avatarUrl: "" },
      assignees: [],
      commentCount: 0,
      linkedPR: linked,
    });
    expect(issue.linkedPR && "mergeState" in issue.linkedPR).toBe(false);
  });
});

/**
 * Every PR selection a contract mapper reads has to project `mergeStateStatus`,
 * or the conflict glyph shows on some paths and silently not on others.
 * Checked per fragment: a query-wide `toContain` would pass on one fragment
 * while its sibling drops the field.
 */
describe("queries feeding the PR mappers project mergeStateStatus", () => {
  const pullRequestFragments = (query: string) =>
    [...query.matchAll(/\.\.\. on PullRequest \{([^{}]*)/g)].map((m) => m[1]!);

  it.each([
    ["REPO_STATS_AND_PAGE_QUERY", REPO_STATS_AND_PAGE_QUERY],
    ["LIST_ISSUES_QUERY", LIST_ISSUES_QUERY],
    ["SEARCH_QUERY", SEARCH_QUERY],
    ["GET_ISSUE_QUERY", GET_ISSUE_QUERY],
    ["buildBatchIssuesQuery", buildBatchIssuesQuery("o", "r", [1])],
  ])("%s selects it in every PullRequest fragment", (_name, query) => {
    const fragments = pullRequestFragments(query);
    expect(fragments.length).toBeGreaterThan(0);
    for (const fragment of fragments) expect(fragment).toContain("mergeStateStatus");
  });

  it.each([
    ["GET_PR_QUERY", GET_PR_QUERY],
    ["buildBatchBranchPRQuery", buildBatchBranchPRQuery("o", "r", ["b"])],
    ["buildBatchPRsQuery", buildBatchPRsQuery("o", "r", [1])],
  ])("%s selects it on the PR node", (_name, query) => {
    expect(query).toContain("mergeStateStatus");
  });
});

describe("pending forge-side merges (#13747)", () => {
  const node = (extra: Record<string, unknown> = {}) => ({
    number: 13747,
    title: "t",
    bodyText: "",
    url: "https://github.com/o/r/pull/13747",
    state: "OPEN",
    updatedAt: "2026-10-22T00:00:00Z",
    ...extra,
  });

  it("maps an armed auto-merge with method, time and who armed it", () => {
    const pr = toForgePR(
      node({
        isInMergeQueue: false,
        autoMergeRequest: {
          enabledAt: "2026-10-22T01:00:00Z",
          mergeMethod: "SQUASH",
          enabledBy: { login: "octocat" },
        },
      })
    );
    expect(pr.mergeIntent).toEqual({
      kind: "auto-merge",
      method: "squash",
      enabledAt: Date.parse("2026-10-22T01:00:00Z"),
      enabledBy: "octocat",
    });
  });

  it("reads a queued PR as queued whether or not auto-merge put it there", () => {
    expect(
      toForgePR(
        node({ isInMergeQueue: true, autoMergeRequest: null, mergeQueueEntry: { position: 3 } })
      ).mergeIntent
    ).toEqual({ kind: "queued", position: 3 });
    expect(toForgePR(node({ isInMergeQueue: true })).mergeIntent).toEqual({
      kind: "queued",
      position: null,
    });
  });

  it("separates nothing pending (null) from not read (absent)", () => {
    expect(
      toForgePR(node({ isInMergeQueue: false, autoMergeRequest: null })).mergeIntent
    ).toBeNull();
    expect("mergeIntent" in toForgePR(node())).toBe(false);
  });

  it("keeps unknown actors and times unknown rather than inventing them", () => {
    const pr = toForgePR(
      node({ autoMergeRequest: { enabledAt: null, mergeMethod: null, enabledBy: null } })
    );
    expect(pr.mergeIntent).toEqual({ kind: "auto-merge", method: null, enabledAt: null });
  });

  it.each([
    ["CLEAN", "clean"],
    ["HAS_HOOKS", "has_hooks"],
    ["UNSTABLE", "unstable"],
    ["BLOCKED", "blocked"],
    ["BEHIND", "behind"],
    ["DIRTY", "dirty"],
    ["DRAFT", "unknown"],
    ["SOMETHING_NEW", "unknown"],
  ])("maps mergeStateStatus %s to %s", (raw, expected) => {
    expect(toForgePR(node({ mergeStateStatus: raw })).mergeStatus).toBe(expected);
  });

  it("maps the single-PR read's commit preview, and nothing from a roll-up selection", () => {
    const pr = toForgePR(
      node({
        headRefOid: "f".repeat(40),
        isMergeQueueEnabled: true,
        viewerCanDisableAutoMerge: false,
        commits: {
          totalCount: 120,
          nodes: [
            {
              commit: {
                oid: "1".repeat(40),
                messageHeadline: "First",
                author: { name: "A", user: null },
              },
            },
            {
              commit: {
                oid: "2".repeat(40),
                messageHeadline: "Second",
                author: { user: { login: "b" } },
              },
            },
          ],
        },
      })
    );
    expect(pr.headSha).toBe("f".repeat(40));
    expect(pr.mergeQueueRequired).toBe(true);
    expect(pr.viewerCanDisableAutoMerge).toBe(false);
    expect(pr.commits).toEqual({
      totalCount: 120,
      items: [
        { sha: "1".repeat(40), subject: "First", author: "A" },
        { sha: "2".repeat(40), subject: "Second", author: "b" },
      ],
    });
    const rollupOnly = toForgePR(
      node({ commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] } })
    );
    expect("commits" in rollupOnly).toBe(false);
  });

  it.each([
    ["SEARCH_QUERY", SEARCH_QUERY],
    ["GET_PR_QUERY", GET_PR_QUERY],
    ["buildBatchBranchPRQuery", buildBatchBranchPRQuery("o", "r", ["b"])],
    ["buildBatchPRsQuery", buildBatchPRsQuery("o", "r", [1])],
  ])("%s carries the pending-merge fields every detection path reads", (_name, query) => {
    expect(query).toContain("autoMergeRequest");
    expect(query).toContain("isInMergeQueue");
    expect(query).toContain("headRefOid");
  });
});
