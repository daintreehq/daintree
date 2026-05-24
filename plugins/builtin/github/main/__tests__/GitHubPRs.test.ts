import { describe, expect, it } from "vitest";
import { parsePRNode } from "../GitHubPRs.js";

function makeBaseNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 42,
    title: "Test PR",
    url: "https://github.com/owner/repo/pull/42",
    state: "OPEN",
    isDraft: false,
    updatedAt: "2025-01-01T00:00:00Z",
    author: { login: "testuser", avatarUrl: "https://example.com/avatar.png" },
    reviews: { totalCount: 3 },
    comments: { totalCount: 5 },
    headRefName: "feature/test",
    headRepository: { nameWithOwner: "fork/repo" },
    baseRepository: { nameWithOwner: "owner/repo" },
    ...overrides,
  };
}

describe("parsePRNode — global CI aggregates", () => {
  it("populates reviewDecision and mergeStateStatus from the node", () => {
    const pr = parsePRNode(
      makeBaseNode({
        reviewDecision: "APPROVED",
        mergeStateStatus: "CLEAN",
      })
    );
    expect(pr.reviewDecision).toBe("APPROVED");
    expect(pr.mergeStateStatus).toBe("CLEAN");
  });

  it("normalises reviewDecision to undefined for unrecognised values", () => {
    const pr = parsePRNode(makeBaseNode({ reviewDecision: "COMMENTED" }));
    expect(pr.reviewDecision).toBeUndefined();
  });

  it("normalises reviewDecision to undefined when absent", () => {
    const pr = parsePRNode(makeBaseNode());
    expect(pr.reviewDecision).toBeUndefined();
  });

  it("derives globalCIStatus and globalCISummary from statusCheckRollup.contexts aggregates", () => {
    const pr = parsePRNode(
      makeBaseNode({
        mergeStateStatus: "CLEAN",
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  state: "SUCCESS",
                  contexts: {
                    checkRunCount: 3,
                    statusContextCount: 2,
                    checkRunCountsByState: [{ state: "SUCCESS", count: 3 }],
                    statusContextCountsByState: [{ state: "SUCCESS", count: 2 }],
                  },
                },
              },
            },
          ],
        },
      })
    );
    expect(pr.globalCIStatus).toBe("SUCCESS");
    expect(pr.globalCISummary).toEqual({
      checkRunCount: 3,
      statusContextCount: 2,
      failingCount: 0,
      pendingCount: 0,
    });
  });

  it("returns undefined globalCIStatus when mergeStateStatus is UNKNOWN", () => {
    const pr = parsePRNode(
      makeBaseNode({
        mergeStateStatus: "UNKNOWN",
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  state: "PENDING",
                  contexts: {
                    checkRunCount: 5,
                    checkRunCountsByState: [{ state: "SUCCESS", count: 5 }],
                  },
                },
              },
            },
          ],
        },
      })
    );
    expect(pr.globalCIStatus).toBeUndefined();
    expect(pr.globalCISummary).toBeUndefined();
    // Required-only fields are untouched
    expect(pr.ciStatus).toBe("PENDING");
    expect(pr.ciSummary).toBeUndefined();
  });

  it("leaves global fields absent when statusCheckRollup is missing", () => {
    const pr = parsePRNode(makeBaseNode());
    expect(pr.globalCIStatus).toBeUndefined();
    expect(pr.globalCISummary).toBeUndefined();
    expect(pr.ciStatus).toBeUndefined();
  });

  it("leaves global fields absent when contexts is null", () => {
    const pr = parsePRNode(
      makeBaseNode({
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  state: "SUCCESS",
                  contexts: null,
                },
              },
            },
          ],
        },
      })
    );
    expect(pr.globalCIStatus).toBeUndefined();
    expect(pr.globalCISummary).toBeUndefined();
    expect(pr.ciStatus).toBe("SUCCESS");
  });

  it("handles missing checkRunCountsByState gracefully", () => {
    const pr = parsePRNode(
      makeBaseNode({
        mergeStateStatus: "CLEAN",
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  state: "SUCCESS",
                  contexts: {
                    checkRunCount: 0,
                    statusContextCount: 1,
                    statusContextCountsByState: [{ state: "SUCCESS", count: 1 }],
                  },
                },
              },
            },
          ],
        },
      })
    );
    expect(pr.globalCIStatus).toBe("SUCCESS");
    expect(pr.globalCISummary?.checkRunCount).toBe(0);
  });

  it("does not populate required-only ciSummary from global aggregates", () => {
    const pr = parsePRNode(
      makeBaseNode({
        mergeStateStatus: "CLEAN",
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  state: "FAILURE",
                  contexts: {
                    checkRunCount: 2,
                    checkRunCountsByState: [
                      { state: "SUCCESS", count: 1 },
                      { state: "FAILURE", count: 1 },
                    ],
                  },
                },
              },
            },
          ],
        },
      })
    );
    // Global CI reflects the aggregate
    expect(pr.globalCIStatus).toBe("FAILURE");
    // Required-only ciSummary is NOT populated — enrichment handles that
    expect(pr.ciSummary).toBeUndefined();
    // Required-only ciStatus still comes from raw rollup
    expect(pr.ciStatus).toBe("FAILURE");
  });
});
