import { describe, expect, it } from "vitest";
import { extractLinkedPR, toForgeIssue } from "../mappers.js";
import { LIST_ISSUES_QUERY, SEARCH_QUERY, GET_ISSUE_QUERY } from "../GitHubQueries.js";

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
