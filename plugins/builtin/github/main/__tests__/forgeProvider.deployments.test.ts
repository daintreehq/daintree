import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatErrorMessage } from "../../../../../shared/utils/errorMessage.js";
import {
  BRANCH_FAILED,
  BRANCH_MISSING,
  BRANCH_NO_DEPLOYMENTS,
  PR_ACTIVE_AND_INACTIVE,
  PR_FAILED_ACROSS_PUSHES,
  PR_MISSING_ENVELOPE,
} from "./fixtures/deploymentResponses.js";

const mockGraphQLClient = vi.fn();
const mockTokenVersion = vi.fn(() => 0);

vi.mock("../GitHubAuth.js", () => ({
  GitHubAuth: {
    getToken: vi.fn(() => "test-token"),
    createClient: vi.fn(() => mockGraphQLClient),
    getTokenVersion: () => mockTokenVersion(),
    validate: vi.fn(),
  },
  GITHUB_API_TIMEOUT_MS: 5000,
  rateLimitAwareFetch: vi.fn(),
}));

vi.mock("../GitHubStats.js", () => ({
  fetchActivityProbe: vi.fn(),
}));

vi.mock("../GitHubRateLimitService.js", () => {
  const gitHubRateLimitService = {
    updateFromGraphQL: vi.fn(),
    getState: vi.fn(() => ({ blocked: false })),
    shouldBlockRequest: () => ({ blocked: false, reason: null }),
  };
  return {
    gitHubRateLimitService,
    rateLimitServiceForHost: () => gitHubRateLimitService,
    releaseRateLimitServiceForHost: () => {},
  };
});

vi.mock("../GitHubErrors.js", () => ({
  parseGitHubError: (e: unknown) => formatErrorMessage(e, "unknown error"),
}));

import { githubForgeProvider } from "../forgeProvider.js";
import {
  _resetForgeQueryCachesForTests,
  clearGitHubCaches,
  forgeQueryCache,
} from "../GitHubCaches.js";
import { BRANCH_DEPLOYMENTS_QUERY, PR_DEPLOYMENTS_QUERY } from "../GitHubQueries.js";
import type { DeploymentTarget, RepoRef } from "../../../../../shared/types/forge.js";

const repo: RepoRef = { host: "github.com", owner: "owner", repo: "repo", rawData: null };
const branch = (name: string): DeploymentTarget => ({ kind: "branch", branch: name });
const pullRequest = (prNumber: number): DeploymentTarget => ({ kind: "pullRequest", prNumber });

function getDeployments(target: DeploymentTarget) {
  const capability = githubForgeProvider.deployments;
  if (!capability) throw new Error("GitHub provider lost its deployments capability");
  return capability.getDeployments(repo, target);
}

/** The error Octokit throws when a response carries `errors` beside its data. */
function responseError(envelope: { data: unknown; errors: unknown[] }) {
  return Object.assign(new Error("Request failed due to following response errors"), {
    name: "GraphqlResponseError",
    data: envelope.data,
    errors: envelope.errors,
  });
}

/** A recorded branch response whose tip deployments are replaced by `nodes`. */
function branchWithNodes(nodes: unknown[]) {
  const recorded = structuredClone(BRANCH_FAILED);
  recorded.repository.ref.target.deployments.nodes = nodes as never;
  return recorded;
}

const recordedTipNode = BRANCH_FAILED.repository.ref.target.deployments.nodes[0]!;

/** The recorded PR response with its head commit's deployments replaced and timeline rows appended. */
function prWith(options: { head?: unknown[]; timeline?: unknown[]; isCrossRepository?: boolean }) {
  const recorded = structuredClone(PR_FAILED_ACROSS_PUSHES);
  const pr = recorded.repository.pullRequest;
  if (options.head) pr.commits.nodes[0]!.commit.deployments.nodes = options.head as never;
  for (const deployment of options.timeline ?? []) {
    pr.timelineItems.nodes.push({ deployment: deployment as never });
  }
  if (options.isCrossRepository !== undefined) pr.isCrossRepository = options.isCrossRepository;
  return recorded;
}

const withRef = (id: string, prefix: string, name: string) => ({
  ...recordedTipNode,
  id,
  ref: { prefix, name },
});

beforeEach(() => {
  mockGraphQLClient.mockReset();
  mockTokenVersion.mockReturnValue(0);
  clearGitHubCaches();
  _resetForgeQueryCachesForTests();
});

describe("deployments.getDeployments (branch)", () => {
  it("reports a failed preview recorded against the tip commit, with its URL and times", async () => {
    mockGraphQLClient.mockResolvedValueOnce(BRANCH_FAILED);

    const result = await getDeployments(branch("dependabot/npm_and_yarn/deps-9ea22ff7bb"));

    expect(result?.deployments).toEqual([
      {
        id: "DE_kwDOIuCgE88AAAAB09I9GQ",
        environment: "Preview – web",
        state: "failure",
        url: "https://web-raxw7r5ee-acme.vercel.app",
        createdAt: Date.parse("2026-11-17T09:03:58Z"),
        updatedAt: Date.parse("2026-11-17T09:03:58Z"),
        commitSha: "7c374c599f4404adf5a65210ac99e99776194eb9",
        rawData: recordedTipNode,
      },
    ]);
    expect(mockGraphQLClient).toHaveBeenCalledTimes(1);
    const [query, variables] = mockGraphQLClient.mock.calls[0]!;
    expect(query).toContain("GetBranchDeployments");
    expect(variables).toMatchObject({
      owner: "owner",
      repo: "repo",
      qualifiedName: "refs/heads/dependabot/npm_and_yarn/deps-9ea22ff7bb",
    });
  });

  it("returns an empty list for a pushed branch with nothing deployed", async () => {
    mockGraphQLClient.mockResolvedValueOnce(BRANCH_NO_DEPLOYMENTS);
    expect(await getDeployments(branch("feature/quiet"))).toEqual({ deployments: [] });
  });

  it("returns null for a branch the remote doesn't have", async () => {
    mockGraphQLClient.mockResolvedValueOnce(BRANCH_MISSING);
    expect(await getDeployments(branch("never-pushed"))).toBeNull();
  });

  it("drops a deployment GitHub recorded for another branch or a tag at the same commit", async () => {
    const forMain = {
      ...recordedTipNode,
      id: "for-main",
      ref: { prefix: "refs/heads/", name: "main" },
    };
    const forTag = {
      ...recordedTipNode,
      id: "for-tag",
      ref: { prefix: "refs/tags/", name: "v1.0.0" },
    };
    const forBranch = {
      ...recordedTipNode,
      id: "for-branch",
      ref: { prefix: "refs/heads/", name: "feature/login" },
    };
    mockGraphQLClient.mockResolvedValueOnce(
      branchWithNodes([forMain, forTag, forBranch, recordedTipNode])
    );

    const result = await getDeployments(branch("feature/login"));

    expect(result?.deployments.map((d) => [d.id, d.ref])).toEqual([
      ["for-branch", "refs/heads/feature/login"],
      ["DE_kwDOIuCgE88AAAAB09I9GQ", undefined],
    ]);
  });

  it("orders by creation time, so a late inactive update can't put an old rollout first", async () => {
    const replaced = {
      ...recordedTipNode,
      id: "replaced",
      state: "INACTIVE",
      createdAt: "2026-11-17T08:00:00Z",
      updatedAt: "2026-11-17T10:00:00Z",
      latestStatus: {
        ...recordedTipNode.latestStatus,
        state: "INACTIVE",
        updatedAt: "2026-11-17T10:00:00Z",
      },
    };
    const rollingOut = {
      ...recordedTipNode,
      id: "rolling-out",
      state: "IN_PROGRESS",
      createdAt: "2026-11-17T09:30:00Z",
      updatedAt: "2026-11-17T09:30:00Z",
      latestStatus: null,
    };
    mockGraphQLClient.mockResolvedValueOnce(branchWithNodes([replaced, rollingOut]));

    const result = await getDeployments(branch("main"));

    expect(result?.deployments.map((d) => [d.id, d.state, d.url, d.updatedAt])).toEqual([
      ["rolling-out", "in_progress", undefined, Date.parse("2026-11-17T09:30:00Z")],
      [
        "replaced",
        "inactive",
        "https://web-raxw7r5ee-acme.vercel.app",
        Date.parse("2026-11-17T10:00:00Z"),
      ],
    ]);
  });

  it("lets the deployment's own state win over a stale successful status", async () => {
    const destroyed = {
      ...recordedTipNode,
      state: "DESTROYED",
      latestStatus: { ...recordedTipNode.latestStatus, state: "SUCCESS" },
    };
    const unmodelled = { ...recordedTipNode, id: "new-state", state: "SOMETHING_NEW" };
    mockGraphQLClient.mockResolvedValueOnce(branchWithNodes([destroyed, unmodelled]));

    const result = await getDeployments(branch("main"));

    expect(result?.deployments.map((d) => d.state)).toEqual(["inactive", "unknown"]);
  });

  it("falls back to the latest status for state and takes its later time", async () => {
    const waiting = {
      ...recordedTipNode,
      state: null,
      updatedAt: "2026-11-17T09:03:58Z",
      latestStatus: {
        ...recordedTipNode.latestStatus,
        state: "WAITING",
        environmentUrl: null,
        updatedAt: "2026-11-17T09:20:00Z",
      },
    };
    mockGraphQLClient.mockResolvedValueOnce(branchWithNodes([waiting]));

    const [deployment] = (await getDeployments(branch("main")))?.deployments ?? [];

    expect(deployment).toMatchObject({
      state: "pending",
      updatedAt: Date.parse("2026-11-17T09:20:00Z"),
    });
    expect(deployment).not.toHaveProperty("url");
  });

  it("rejects rather than dropping a deployment it can't read", async () => {
    mockGraphQLClient.mockResolvedValueOnce(
      branchWithNodes([recordedTipNode, { ...recordedTipNode, environment: null }])
    );
    await expect(getDeployments(branch("main"))).rejects.toThrow(/unreadable deployment/);
  });

  it("selects the ref and status URL the mapper reads, in both queries", () => {
    // The recorded responses were captured with these documents; dropping a
    // selection would leave the fixtures green while live reads lose the field.
    for (const query of [BRANCH_DEPLOYMENTS_QUERY, PR_DEPLOYMENTS_QUERY]) {
      expect(query).toMatch(/\bref\s*\{\s*prefix\s+name\s*\}/);
      expect(query).toMatch(/latestStatus\s*\{[^}]*\benvironmentUrl\b/);
    }
    expect(PR_DEPLOYMENTS_QUERY).toMatch(/\bisCrossRepository\b/);
  });
});

describe("deployments.getDeployments (pull request)", () => {
  it("merges head-commit and timeline deployments once each, keeping inactive beside active", async () => {
    mockGraphQLClient.mockResolvedValueOnce(PR_ACTIVE_AND_INACTIVE);

    const result = await getDeployments(pullRequest(15015));

    expect(
      result?.deployments.map((d) => ({
        id: d.id,
        state: d.state,
        url: d.url,
        commit: d.commitSha,
      }))
    ).toEqual([
      {
        id: "DE_kwDOGKvm488AAAABzgHF5w",
        state: "inactive",
        url: "https://docs-lwslo8huj.vercel.app",
        commit: "ac051e068c5c4076eb85a66c9237376d05354d2d",
      },
      {
        id: "DE_kwDOGKvm488AAAABzegibA",
        state: "success",
        url: "https://docs-hbr9phk9i.vercel.app",
        commit: "34d1ff2e4a05d552d8eacefb60c2f89f79147fec",
      },
    ]);
    expect(result?.deployments.every((d) => d.environment === "Preview – docs")).toBe(true);
    const [query, variables] = mockGraphQLClient.mock.calls[0]!;
    expect(query).toContain("GetPRDeployments");
    expect(variables).toMatchObject({ owner: "owner", repo: "repo", number: 15015 });
  });

  it("reaches an earlier push's failed preview through the timeline", async () => {
    mockGraphQLClient.mockResolvedValueOnce(PR_FAILED_ACROSS_PUSHES);

    const result = await getDeployments(pullRequest(12692));

    expect(result?.deployments.map((d) => [d.commitSha?.slice(0, 8), d.state, d.url])).toEqual([
      ["7c374c59", "failure", "https://web-raxw7r5ee-acme.vercel.app"],
      ["0f5bf002", "failure", "https://web-iyiqbfsm3-acme.vercel.app"],
    ]);
  });

  it("keeps a timeline deployment made from the merge ref even though it isn't on the head commit", async () => {
    const recorded = structuredClone(PR_FAILED_ACROSS_PUSHES);
    const mergeRef = {
      ...recordedTipNode,
      id: "merge-ref",
      commitOid: "1111111111111111111111111111111111111111",
      ref: { prefix: "refs/pull/", name: "12692/merge" },
      createdAt: "2026-11-17T10:00:00Z",
    };
    recorded.repository.pullRequest.timelineItems.nodes.push({ deployment: mergeRef as never });
    mockGraphQLClient.mockResolvedValueOnce(recorded);

    const result = await getDeployments(pullRequest(12692));

    expect(result?.deployments[0]).toMatchObject({ id: "merge-ref", ref: "refs/pull/12692/merge" });
    expect(result?.deployments).toHaveLength(3);
  });

  it("keeps the head commit's deployments for this PR's refs only", async () => {
    mockGraphQLClient.mockResolvedValueOnce(
      prWith({
        head: [
          withRef("pr-12-head", "refs/pull/", "12/head"),
          withRef("pr-123-head", "refs/pull/", "123/head"),
          withRef("own-branch", "refs/heads/", "dependabot/npm_and_yarn/deps-9ea22ff7bb"),
          withRef("other-branch", "refs/heads/", "main"),
        ],
      })
    );

    const result = await getDeployments(pullRequest(12));

    expect(result?.deployments.map((d) => d.id).sort()).toEqual([
      "DE_kwDOIuCgE88AAAAB09I9GQ",
      "DE_kwDOIuCgE88AAAABzY13lQ",
      "own-branch",
      "pr-12-head",
    ]);
  });

  it("keeps a timeline deployment whatever ref it names, since GitHub tied it to the PR", async () => {
    mockGraphQLClient.mockResolvedValueOnce(
      prWith({ head: [], timeline: [withRef("timeline-only", "refs/heads/", "release")] })
    );

    const result = await getDeployments(pullRequest(12692));

    expect(result?.deployments.map((d) => d.id)).toContain("timeline-only");
  });

  it("doesn't credit a fork PR with this repository's same-named branch", async () => {
    const sameName = withRef(
      "upstream-branch",
      "refs/heads/",
      "dependabot/npm_and_yarn/deps-9ea22ff7bb"
    );
    const bareCommit = { ...recordedTipNode, id: "bare-commit" };
    const ownPullRef = withRef("own-pull-ref", "refs/pull/", "12692/head");
    const head = [sameName, bareCommit, ownPullRef];
    const timeline = [withRef("timeline-release", "refs/heads/", "release")];
    const ids = async () =>
      (await getDeployments(pullRequest(12692)))?.deployments.map((d) => d.id).sort();

    mockGraphQLClient.mockResolvedValueOnce(prWith({ head, timeline, isCrossRepository: true }));
    expect(await ids()).toEqual([
      "DE_kwDOIuCgE88AAAAB09I9GQ",
      "DE_kwDOIuCgE88AAAABzY13lQ",
      "bare-commit",
      "own-pull-ref",
      "timeline-release",
    ]);

    mockGraphQLClient.mockResolvedValueOnce(prWith({ head, timeline, isCrossRepository: false }));
    expect(await ids()).toContain("upstream-branch");
  });

  it("reads only the timeline for a PR with no head commits, but rejects a missing commit list", async () => {
    const noCommits = structuredClone(PR_FAILED_ACROSS_PUSHES);
    noCommits.repository.pullRequest.commits.nodes = [];
    mockGraphQLClient.mockResolvedValueOnce(noCommits);
    expect((await getDeployments(pullRequest(12692)))?.deployments).toHaveLength(2);

    const unreadable = structuredClone(PR_FAILED_ACROSS_PUSHES) as {
      repository: { pullRequest: { commits?: unknown } };
    };
    delete unreadable.repository.pullRequest.commits;
    mockGraphQLClient.mockResolvedValueOnce(unreadable);
    await expect(getDeployments(pullRequest(12692))).rejects.toThrow(/head commit list/);

    const nullHead = structuredClone(PR_FAILED_ACROSS_PUSHES);
    nullHead.repository.pullRequest.commits.nodes = [null as never];
    mockGraphQLClient.mockResolvedValueOnce(nullHead);
    await expect(getDeployments(pullRequest(12692))).rejects.toThrow(/unreadable head commit/);
  });

  it("returns null for a PR number that doesn't exist", async () => {
    mockGraphQLClient.mockRejectedValueOnce(responseError(PR_MISSING_ENVELOPE));
    expect(await getDeployments(pullRequest(99999999))).toBeNull();
  });

  it("rejects when the repository itself can't be read", async () => {
    mockGraphQLClient.mockRejectedValueOnce(
      responseError({
        data: { repository: null },
        errors: [
          { type: "NOT_FOUND", path: ["repository"], message: "Could not resolve to a Repository" },
        ],
      })
    );
    await expect(getDeployments(pullRequest(7))).rejects.toThrow();
  });

  it.each([
    ["a FORBIDDEN error at the PR", [{ type: "FORBIDDEN", path: ["repository", "pullRequest"] }]],
    [
      "a NOT_FOUND beside a FORBIDDEN",
      [
        { type: "NOT_FOUND", path: ["repository", "pullRequest"] },
        { type: "FORBIDDEN", path: ["repository", "pullRequest"] },
      ],
    ],
  ])("rejects %s rather than reporting no such PR", async (_label, errors) => {
    mockGraphQLClient.mockRejectedValueOnce(
      responseError({ data: PR_MISSING_ENVELOPE.data, errors })
    );
    await expect(getDeployments(pullRequest(7))).rejects.toThrow();
  });
});

describe("deployments.getDeployments (requests)", () => {
  it("shares one request between concurrent identical reads and never caches the response", async () => {
    mockGraphQLClient.mockResolvedValue(BRANCH_FAILED);

    const [a, b] = await Promise.all([
      getDeployments(branch("main")),
      getDeployments(branch("main")),
    ]);

    expect(a).toEqual(b);
    expect(mockGraphQLClient).toHaveBeenCalledTimes(1);
    expect(forgeQueryCache.size()).toBe(0);

    await getDeployments(branch("main"));
    expect(mockGraphQLClient).toHaveBeenCalledTimes(2);
  });

  it("shows a PR's rollout moving between two reads instead of a cached state", async () => {
    const rolledOut = structuredClone(PR_ACTIVE_AND_INACTIVE);
    for (const node of rolledOut.repository.pullRequest.timelineItems.nodes) {
      node.deployment.state = "ACTIVE";
    }
    mockGraphQLClient
      .mockResolvedValueOnce(PR_ACTIVE_AND_INACTIVE)
      .mockResolvedValueOnce(rolledOut);

    const before = await getDeployments(pullRequest(15015));
    const after = await getDeployments(pullRequest(15015));

    expect(before?.deployments.map((d) => d.state)).toEqual(["inactive", "success"]);
    expect(after?.deployments.map((d) => d.state)).toEqual(["success", "success"]);
    expect(forgeQueryCache.size()).toBe(0);
  });

  it("doesn't share a request across targets or a credential switch", async () => {
    mockGraphQLClient.mockResolvedValue(BRANCH_FAILED);
    let releaseFirst: () => void = () => {};
    mockGraphQLClient.mockImplementationOnce(
      () => new Promise((resolve) => (releaseFirst = () => resolve(BRANCH_FAILED)))
    );

    const first = getDeployments(branch("main"));
    await Promise.resolve();
    const otherBranch = getDeployments(branch("develop"));
    mockTokenVersion.mockReturnValue(1);
    const afterSwitch = getDeployments(branch("main"));
    await Promise.all([otherBranch, afterSwitch]);
    releaseFirst();
    await first;

    expect(mockGraphQLClient).toHaveBeenCalledTimes(3);
  });

  it("retries after a failed read instead of replaying the failure", async () => {
    mockGraphQLClient.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(getDeployments(branch("main"))).rejects.toThrow(/socket hang up/);

    mockGraphQLClient.mockResolvedValueOnce(BRANCH_FAILED);
    expect((await getDeployments(branch("main")))?.deployments).toHaveLength(1);
  });
});
