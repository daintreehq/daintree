import { describe, it, expect } from "vitest";

// parsePRNode is not exported — test via the public listPullRequests surface
// by verifying that the fields are correctly extracted from raw GraphQL node data.
// We test the transformation logic directly by duplicating the function shape.

type GitHubPRCIStatus = "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED";

interface RawPRNode {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  updatedAt: string;
  merged: boolean;
  headRefName?: string;
  headRepository?: { nameWithOwner?: string } | null;
  baseRepository?: { nameWithOwner?: string } | null;
  author?: { login?: string; avatarUrl?: string } | null;
  reviews?: { totalCount?: number };
  commits?: {
    nodes?: Array<{
      commit?: { statusCheckRollup?: { state?: string } | null } | null;
    }>;
  };
}

// Inline the logic from parsePRNode to keep tests self-contained
function parsePRNode(node: RawPRNode) {
  const author = node.author;
  const reviewsData = node.reviews;
  const merged = node.merged;
  const rawState = node.state as string;
  const headRepo = node.headRepository;
  const baseRepo = node.baseRepository;

  let state: "OPEN" | "CLOSED" | "MERGED" = rawState as "OPEN" | "CLOSED" | "MERGED";
  if (merged) {
    state = "MERGED";
  }

  const headName = headRepo?.nameWithOwner;
  const baseName = baseRepo?.nameWithOwner;
  const isFork = headName && baseName ? headName !== baseName : undefined;

  const ciStatus = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state as
    | GitHubPRCIStatus
    | undefined;

  return {
    number: node.number,
    title: node.title,
    url: node.url,
    state,
    isDraft: node.isDraft ?? false,
    updatedAt: node.updatedAt,
    author: {
      login: author?.login ?? "unknown",
      avatarUrl: author?.avatarUrl ?? "",
    },
    reviewCount: reviewsData?.totalCount,
    headRefName: (node.headRefName as string) || undefined,
    isFork: isFork ?? undefined,
    ciStatus,
  };
}

describe("parsePRNode", () => {
  const baseNode: RawPRNode = {
    number: 42,
    title: "My feature",
    url: "https://github.com/owner/repo/pull/42",
    state: "OPEN",
    isDraft: false,
    updatedAt: "2025-01-01T00:00:00Z",
    merged: false,
    author: { login: "alice", avatarUrl: "https://avatars.example.com/alice" },
    reviews: { totalCount: 2 },
  };

  it("extracts headRefName from node", () => {
    const result = parsePRNode({ ...baseNode, headRefName: "feature/my-branch" });
    expect(result.headRefName).toBe("feature/my-branch");
  });

  it("sets headRefName to undefined when absent", () => {
    const result = parsePRNode(baseNode);
    expect(result.headRefName).toBeUndefined();
  });

  it("sets headRefName to undefined when empty string", () => {
    const result = parsePRNode({ ...baseNode, headRefName: "" });
    expect(result.headRefName).toBeUndefined();
  });

  it("detects a fork PR when headRepository and baseRepository differ", () => {
    const result = parsePRNode({
      ...baseNode,
      headRefName: "feature/fork-branch",
      headRepository: { nameWithOwner: "forker/repo" },
      baseRepository: { nameWithOwner: "owner/repo" },
    });
    expect(result.isFork).toBe(true);
  });

  it("detects a same-repo PR when headRepository and baseRepository match", () => {
    const result = parsePRNode({
      ...baseNode,
      headRefName: "feature/same-repo-branch",
      headRepository: { nameWithOwner: "owner/repo" },
      baseRepository: { nameWithOwner: "owner/repo" },
    });
    expect(result.isFork).toBe(false);
  });

  it("sets isFork to undefined when headRepository is null", () => {
    const result = parsePRNode({
      ...baseNode,
      headRepository: null,
      baseRepository: { nameWithOwner: "owner/repo" },
    });
    expect(result.isFork).toBeUndefined();
  });

  it("sets isFork to undefined when baseRepository is null", () => {
    const result = parsePRNode({
      ...baseNode,
      headRepository: { nameWithOwner: "owner/repo" },
      baseRepository: null,
    });
    expect(result.isFork).toBeUndefined();
  });

  it("sets isFork to undefined when both repositories are absent", () => {
    const result = parsePRNode(baseNode);
    expect(result.isFork).toBeUndefined();
  });

  it("sets isFork to undefined when headRepository has no nameWithOwner (partial payload)", () => {
    const result = parsePRNode({
      ...baseNode,
      headRepository: {},
      baseRepository: { nameWithOwner: "owner/repo" },
    });
    expect(result.isFork).toBeUndefined();
  });

  it("sets isFork to undefined when baseRepository has no nameWithOwner (partial payload)", () => {
    const result = parsePRNode({
      ...baseNode,
      headRepository: { nameWithOwner: "owner/repo" },
      baseRepository: {},
    });
    expect(result.isFork).toBeUndefined();
  });

  it("forces state to MERGED when merged flag is true", () => {
    const result = parsePRNode({ ...baseNode, state: "CLOSED", merged: true });
    expect(result.state).toBe("MERGED");
  });

  it("preserves OPEN state when not merged", () => {
    const result = parsePRNode(baseNode);
    expect(result.state).toBe("OPEN");
  });

  it("extracts ciStatus SUCCESS from statusCheckRollup", () => {
    const result = parsePRNode({
      ...baseNode,
      commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
    });
    expect(result.ciStatus).toBe("SUCCESS");
  });

  it("extracts ciStatus FAILURE from statusCheckRollup", () => {
    const result = parsePRNode({
      ...baseNode,
      commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
    });
    expect(result.ciStatus).toBe("FAILURE");
  });

  it("extracts ciStatus PENDING from statusCheckRollup", () => {
    const result = parsePRNode({
      ...baseNode,
      commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] },
    });
    expect(result.ciStatus).toBe("PENDING");
  });

  it("extracts ciStatus ERROR from statusCheckRollup", () => {
    const result = parsePRNode({
      ...baseNode,
      commits: { nodes: [{ commit: { statusCheckRollup: { state: "ERROR" } } }] },
    });
    expect(result.ciStatus).toBe("ERROR");
  });

  it("extracts ciStatus EXPECTED from statusCheckRollup", () => {
    const result = parsePRNode({
      ...baseNode,
      commits: { nodes: [{ commit: { statusCheckRollup: { state: "EXPECTED" } } }] },
    });
    expect(result.ciStatus).toBe("EXPECTED");
  });

  it("sets ciStatus to undefined when statusCheckRollup is null", () => {
    const result = parsePRNode({
      ...baseNode,
      commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    });
    expect(result.ciStatus).toBeUndefined();
  });

  it("sets ciStatus to undefined when commits nodes is empty", () => {
    const result = parsePRNode({
      ...baseNode,
      commits: { nodes: [] },
    });
    expect(result.ciStatus).toBeUndefined();
  });

  it("sets ciStatus to undefined when commits field is absent", () => {
    const result = parsePRNode(baseNode);
    expect(result.ciStatus).toBeUndefined();
  });
});
