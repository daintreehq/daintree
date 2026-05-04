import { GitHubAuth, GITHUB_API_TIMEOUT_MS } from "./GitHubAuth.js";
import { buildBatchPRQuery } from "./GitHubQueries.js";
import { gitHubRateLimitService } from "./GitHubRateLimitService.js";
import { parseGitHubError, rateLimitMessage, rateLimitMeta } from "./GitHubErrors.js";
import { getRepoContext, isRepoNotFoundError } from "./GitHubRepoContext.js";
import {
  repoContextCache,
  prETagCache,
  branchListETagCache,
  prTooltipCache,
  prTooltipWrittenAt,
  truncateBody,
} from "./GitHubCaches.js";
import type { PRTooltipData } from "../../../shared/types/github.js";
import type { PRCheckCandidate, PRCheckResult, BatchPRCheckResult, LinkedPR } from "./types.js";

interface BatchPRTooltipFields {
  bodyText?: string | null;
  createdAt?: string;
  author?: { login?: string; avatarUrl?: string } | null;
  assignees?: { nodes?: Array<{ login?: string; avatarUrl?: string }> };
  labels?: { nodes?: Array<{ name?: string; color?: string }> };
}

interface BatchPRRawNode extends BatchPRTooltipFields {
  number?: number;
  title?: string;
  url?: string;
  state?: string;
  isDraft?: boolean;
  merged?: boolean;
}

function buildTooltipDataFromBatchNode(node: BatchPRRawNode): PRTooltipData | undefined {
  if (typeof node.number !== "number" || typeof node.title !== "string") {
    return undefined;
  }
  if (typeof node.createdAt !== "string") {
    return undefined;
  }

  const merged = node.merged ?? false;
  const rawState = (node.state ?? "OPEN").toUpperCase();
  const state: "OPEN" | "CLOSED" | "MERGED" = merged
    ? "MERGED"
    : rawState === "CLOSED"
      ? "CLOSED"
      : "OPEN";

  return {
    number: node.number,
    title: node.title,
    bodyExcerpt: truncateBody(node.bodyText ?? null),
    state,
    isDraft: node.isDraft ?? false,
    createdAt: node.createdAt,
    author: {
      login: node.author?.login ?? "unknown",
      avatarUrl: node.author?.avatarUrl ?? "",
    },
    assignees: (node.assignees?.nodes ?? []).filter(Boolean).map((a) => ({
      login: a.login ?? "unknown",
      avatarUrl: a.avatarUrl ?? "",
    })),
    labels: (node.labels?.nodes ?? []).filter(Boolean).map((l) => ({
      name: l.name ?? "",
      color: l.color ?? "",
    })),
  };
}

function parseBatchPRResponse(
  data: Record<string, unknown>,
  candidates: PRCheckCandidate[]
): Map<string, PRCheckResult> {
  const results = new Map<string, PRCheckResult>();

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const alias = `wt_${i}`;
    let foundPR: LinkedPR | null = null;
    let foundTooltip: PRTooltipData | undefined;
    const issueResponse = (
      data?.[`${alias}_issue`] as {
        issue?: { title?: string; timelineItems?: { nodes?: unknown[] } };
      }
    )?.issue;
    const issueTitle = issueResponse?.title;
    const issueData = issueResponse?.timelineItems?.nodes;
    if (issueData && Array.isArray(issueData)) {
      const prs: Array<{ pr: LinkedPR; raw: BatchPRRawNode }> = [];
      const seenPRNumbers = new Set<number>();
      for (const node of issueData as Array<{
        source?: BatchPRRawNode;
        subject?: BatchPRRawNode;
      }>) {
        const prData = node?.source ?? node?.subject;
        if (prData?.number && prData?.url && !seenPRNumbers.has(prData.number)) {
          seenPRNumbers.add(prData.number);
          prs.push({
            pr: {
              number: prData.number,
              title: prData.title || "",
              url: prData.url,
              state: prData.merged
                ? "merged"
                : (prData.state?.toLowerCase() as "open" | "closed") || "open",
              isDraft: prData.isDraft ?? false,
            },
            raw: prData,
          });
        }
      }

      const openPRs = prs.filter((entry) => entry.pr.state === "open");
      const mergedPRs = prs.filter((entry) => entry.pr.state === "merged");
      const closedPRs = prs.filter((entry) => entry.pr.state === "closed");

      let chosen: { pr: LinkedPR; raw: BatchPRRawNode } | undefined;
      if (openPRs.length > 0) {
        chosen = openPRs[openPRs.length - 1];
      } else if (mergedPRs.length > 0) {
        chosen = mergedPRs[mergedPRs.length - 1];
      } else if (closedPRs.length > 0) {
        chosen = closedPRs[closedPRs.length - 1];
      }
      if (chosen) {
        foundPR = chosen.pr;
        foundTooltip = buildTooltipDataFromBatchNode(chosen.raw);
      }
    }

    if (!foundPR) {
      const branchData = (data?.[`${alias}_branch`] as { pullRequests?: { nodes?: unknown[] } })
        ?.pullRequests?.nodes;
      if (branchData && Array.isArray(branchData)) {
        const branchPRs: Array<{ pr: LinkedPR; raw: BatchPRRawNode }> = [];
        for (const node of branchData as BatchPRRawNode[]) {
          if (node?.number && node?.url) {
            branchPRs.push({
              pr: {
                number: node.number,
                title: node.title || "",
                url: node.url,
                state: node.merged
                  ? "merged"
                  : (node.state?.toLowerCase() as "open" | "closed") || "open",
                isDraft: node.isDraft ?? false,
              },
              raw: node,
            });
          }
        }

        const openPRs = branchPRs.filter((entry) => entry.pr.state === "open");
        const mergedPRs = branchPRs.filter((entry) => entry.pr.state === "merged");
        const closedPRs = branchPRs.filter((entry) => entry.pr.state === "closed");

        let chosen: { pr: LinkedPR; raw: BatchPRRawNode } | undefined;
        if (openPRs.length > 0) {
          chosen = openPRs[openPRs.length - 1];
        } else if (mergedPRs.length > 0) {
          chosen = mergedPRs[mergedPRs.length - 1];
        } else if (closedPRs.length > 0) {
          chosen = closedPRs[closedPRs.length - 1];
        }
        if (chosen) {
          foundPR = chosen.pr;
          foundTooltip = buildTooltipDataFromBatchNode(chosen.raw);
        }
      }
    }

    results.set(candidate.worktreeId, {
      issueNumber: candidate.issueNumber,
      issueTitle,
      branchName: candidate.branchName,
      pr: foundPR,
      ...(foundTooltip ? { tooltipData: foundTooltip } : {}),
    });
  }

  return results;
}

async function probePRChange(
  owner: string,
  repo: string,
  prNumber: number,
  token: string
): Promise<"changed" | "unchanged" | "unknown"> {
  const cacheKey = `${owner}/${repo}#${prNumber}`;
  const cachedETag = prETagCache.get(cacheKey);
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (cachedETag) {
    headers["If-None-Match"] = cachedETag;
  }

  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
    });

    try {
      gitHubRateLimitService.update(response.headers, response.status);
    } catch {
      // Rate-limit bookkeeping must never break the probe.
    }

    if (response.status === 304) {
      return "unchanged";
    }
    if (response.status === 200) {
      const etag = response.headers.get("etag");
      if (etag) {
        prETagCache.set(cacheKey, etag);
      } else {
        prETagCache.delete(cacheKey);
      }
      return "changed";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

async function probeBranchPRListChange(
  owner: string,
  repo: string,
  branchName: string,
  token: string
): Promise<"changed" | "unchanged" | "unknown"> {
  const cacheKey = `${owner}/${repo}@${branchName}`;
  const cachedETag = branchListETagCache.get(cacheKey);
  const headFilter = `${owner}:${encodeURIComponent(branchName)}`;
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls?head=${headFilter}&state=all`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (cachedETag) {
    headers["If-None-Match"] = cachedETag;
  }

  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
    });

    try {
      gitHubRateLimitService.update(response.headers, response.status);
    } catch {
      // Rate-limit bookkeeping must never break the probe.
    }

    if (response.status === 304) {
      return "unchanged";
    }
    if (response.status === 200) {
      const etag = response.headers.get("etag");
      if (etag) {
        branchListETagCache.set(cacheKey, etag);
      } else {
        branchListETagCache.delete(cacheKey);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        branchListETagCache.delete(cacheKey);
        return "unknown";
      }
      if (!Array.isArray(body)) {
        branchListETagCache.delete(cacheKey);
        return "unknown";
      }
      return body.length === 0 ? "unchanged" : "changed";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

async function allKnownPRsUnchanged(
  owner: string,
  repo: string,
  candidates: PRCheckCandidate[],
  token: string
): Promise<boolean> {
  const uniquePRNumbers = Array.from(new Set(candidates.map((c) => c.knownPRNumber!)));
  const probes = await Promise.all(
    uniquePRNumbers.map((prNumber) => probePRChange(owner, repo, prNumber, token))
  );
  return probes.every((result) => result === "unchanged");
}

function prewarmPRTooltipCache(
  owner: string,
  repo: string,
  results: Map<string, PRCheckResult>,
  requestedAt: number
): void {
  for (const result of results.values()) {
    const prNumber = result.pr?.number;
    const tooltipData = result.tooltipData;
    if (typeof prNumber !== "number" || !tooltipData) continue;
    const cacheKey = `${owner}/${repo}:${prNumber}`;
    const existing = prTooltipWrittenAt.get(cacheKey);
    if (existing === undefined || requestedAt >= existing) {
      prTooltipCache.set(cacheKey, tooltipData);
      prTooltipWrittenAt.set(cacheKey, requestedAt);
    }
  }
}

export async function batchCheckLinkedPRs(
  cwd: string,
  candidates: PRCheckCandidate[]
): Promise<BatchPRCheckResult> {
  if (candidates.length === 0) {
    return { results: new Map() };
  }

  const client = GitHubAuth.createClient();
  if (!client) {
    return { results: new Map(), error: "GitHub token not configured. Set it in Settings." };
  }

  const context = await getRepoContext(cwd);
  if (!context) {
    return { results: new Map(), error: "Not a GitHub repository" };
  }

  const rateLimitBlock = gitHubRateLimitService.shouldBlockRequest();
  if (rateLimitBlock.blocked && rateLimitBlock.reason && rateLimitBlock.resumeAt) {
    return {
      results: new Map(),
      error: rateLimitMessage(rateLimitBlock.reason, rateLimitBlock.resumeAt),
      rateLimit: { kind: rateLimitBlock.reason, resumeAt: rateLimitBlock.resumeAt },
    };
  }

  const token = GitHubAuth.getToken();
  const allRevalidation =
    token !== undefined && candidates.every((c) => typeof c.knownPRNumber === "number");
  if (allRevalidation) {
    const allUnchanged = await allKnownPRsUnchanged(context.owner, context.repo, candidates, token);
    if (allUnchanged) {
      return { results: new Map() };
    }
    const postProbeBlock = gitHubRateLimitService.shouldBlockRequest();
    if (postProbeBlock.blocked && postProbeBlock.reason && postProbeBlock.resumeAt) {
      return {
        results: new Map(),
        error: rateLimitMessage(postProbeBlock.reason, postProbeBlock.resumeAt),
        rateLimit: { kind: postProbeBlock.reason, resumeAt: postProbeBlock.resumeAt },
      };
    }
  }

  let candidatesForGraphQL = candidates;
  if (token !== undefined && !allRevalidation) {
    const probeableIndicesByBranch = new Map<string, number[]>();
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const branch = c.branchName?.trim();
      if (typeof c.knownPRNumber !== "number" && typeof c.issueNumber !== "number" && branch) {
        const existing = probeableIndicesByBranch.get(branch);
        if (existing) {
          existing.push(i);
        } else {
          probeableIndicesByBranch.set(branch, [i]);
        }
      }
    }
    if (probeableIndicesByBranch.size > 0) {
      const uniqueBranches = Array.from(probeableIndicesByBranch.keys());
      const probeResults = await Promise.all(
        uniqueBranches.map((branch) =>
          probeBranchPRListChange(context.owner, context.repo, branch, token)
        )
      );
      const skip = new Set<number>();
      for (let i = 0; i < uniqueBranches.length; i++) {
        if (probeResults[i] === "unchanged") {
          for (const idx of probeableIndicesByBranch.get(uniqueBranches[i])!) {
            skip.add(idx);
          }
        }
      }
      if (skip.size === candidates.length) {
        return { results: new Map() };
      }
      if (skip.size > 0) {
        candidatesForGraphQL = candidates.filter((_, idx) => !skip.has(idx));
      }
      const postProbeBlock = gitHubRateLimitService.shouldBlockRequest();
      if (postProbeBlock.blocked && postProbeBlock.reason && postProbeBlock.resumeAt) {
        return {
          results: new Map(),
          error: rateLimitMessage(postProbeBlock.reason, postProbeBlock.resumeAt),
          rateLimit: { kind: postProbeBlock.reason, resumeAt: postProbeBlock.resumeAt },
        };
      }
    }
  }

  try {
    const requestedAt = Date.now();
    const query = buildBatchPRQuery(context.owner, context.repo, candidatesForGraphQL);
    const response = (await client(query, {
      request: { signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
    })) as Record<string, unknown>;

    const results = parseBatchPRResponse(response, candidatesForGraphQL);
    prewarmPRTooltipCache(context.owner, context.repo, results, requestedAt);
    return { results };
  } catch (error) {
    if (isRepoNotFoundError(error)) {
      repoContextCache.invalidate(cwd);
      const freshContext = await getRepoContext(cwd);
      if (
        freshContext &&
        (freshContext.owner !== context.owner || freshContext.repo !== context.repo)
      ) {
        try {
          const retryRequestedAt = Date.now();
          const retryQuery = buildBatchPRQuery(
            freshContext.owner,
            freshContext.repo,
            candidatesForGraphQL
          );
          const retryResponse = (await client(retryQuery, {
            request: { signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
          })) as Record<string, unknown>;
          const retryResults = parseBatchPRResponse(retryResponse, candidatesForGraphQL);
          prewarmPRTooltipCache(
            freshContext.owner,
            freshContext.repo,
            retryResults,
            retryRequestedAt
          );
          return { results: retryResults };
        } catch (retryError) {
          return { results: new Map(), error: parseGitHubError(retryError), ...rateLimitMeta() };
        }
      }
    }
    return { results: new Map(), error: parseGitHubError(error), ...rateLimitMeta() };
  }
}
