import { ipcMain } from "electron";
import dns from "node:dns/promises";
import { CHANNELS } from "../channels.js";
import { GitHubAuth } from "../../services/github/index.js";
import type { UrlContextResult } from "../../../shared/types/ipc/api.js";

const MAX_HTML_LENGTH = 100_000;
const FETCH_TIMEOUT_MS = 15_000;

interface ParsedGitHubUrl {
  type: "issue" | "pr" | "commit";
  owner: string;
  repo: string;
  id: string;
}

const GITHUB_PATTERNS: Record<string, RegExp> = {
  issue: /^\/([^/]+)\/([^/]+)\/issues\/(\d+)/,
  pr: /^\/([^/]+)\/([^/]+)\/pull\/(\d+)/,
  commit: /^\/([^/]+)\/([^/]+)\/commit\/([a-f0-9]{7,40})/,
};

function parseGitHubUrl(urlStr: string): ParsedGitHubUrl | null {
  try {
    const url = new URL(urlStr);
    if (url.hostname !== "github.com") return null;
    const pathname = url.pathname;
    for (const [type, pattern] of Object.entries(GITHUB_PATTERNS)) {
      const m = pathname.match(pattern);
      if (m) {
        return { type: type as ParsedGitHubUrl["type"], owner: m[1], repo: m[2], id: m[3] };
      }
    }
  } catch {
    return null;
  }
  return null;
}

const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^0\.0\.0\.0$/,
  /^::1$/,
  /^fe80:/i,
  /^fc00:/i,
  /^fd/i,
  /^::ffff:(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/i,
];

async function isSafeUrl(urlStr: string): Promise<boolean> {
  try {
    const url = new URL(urlStr);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    const hostname = url.hostname;
    if (hostname === "localhost" || hostname.endsWith(".local")) return false;

    const { address } = await dns.lookup(hostname);
    return !PRIVATE_IP_PATTERNS.some((r) => r.test(address));
  } catch {
    return false;
  }
}

const GET_ISSUE_CONTEXT_QUERY = `
  query GetIssueContext($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        title
        body
        state
        author { login }
        labels(first: 10) { nodes { name } }
      }
    }
  }
`;

const GET_PR_CONTEXT_QUERY = `
  query GetPRContext($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        title
        body
        state
        merged
        author { login }
        baseRefName
        headRefName
        additions
        deletions
        labels(first: 10) { nodes { name } }
      }
    }
  }
`;

const GET_COMMIT_CONTEXT_QUERY = `
  query GetCommitContext($owner: String!, $repo: String!, $oid: GitObjectID!) {
    repository(owner: $owner, name: $repo) {
      object(oid: $oid) {
        ... on Commit {
          message
          author { name email date }
          additions
          deletions
        }
      }
    }
  }
`;

async function resolveGitHubUrl(parsed: ParsedGitHubUrl): Promise<UrlContextResult> {
  const client = GitHubAuth.createClient();
  if (!client) {
    return { ok: false, reason: "auth-required", message: "GitHub token not configured" };
  }

  try {
    if (parsed.type === "issue") {
      const response = (await client(GET_ISSUE_CONTEXT_QUERY, {
        owner: parsed.owner,
        repo: parsed.repo,
        number: parseInt(parsed.id, 10),
      })) as {
        repository: {
          issue: {
            title: string;
            body: string | null;
            state: string;
            author: { login: string };
            labels: { nodes: { name: string }[] };
          } | null;
        };
      };

      const issue = response.repository?.issue;
      if (!issue) return { ok: false, reason: "fetch-error", message: "Issue not found" };

      const labels = issue.labels.nodes.map((l) => l.name).join(", ");
      const markdown = [
        `# ${issue.title}`,
        `**State:** ${issue.state} | **Author:** @${issue.author.login}${labels ? ` | **Labels:** ${labels}` : ""}`,
        "",
        issue.body ?? "_No description provided._",
      ].join("\n");

      return {
        ok: true,
        title: `${parsed.owner}/${parsed.repo}#${parsed.id}: ${issue.title}`,
        markdown,
        tokenEstimate: Math.ceil(markdown.length / 4),
        sourceUrl: `https://github.com/${parsed.owner}/${parsed.repo}/issues/${parsed.id}`,
      };
    }

    if (parsed.type === "pr") {
      const response = (await client(GET_PR_CONTEXT_QUERY, {
        owner: parsed.owner,
        repo: parsed.repo,
        number: parseInt(parsed.id, 10),
      })) as {
        repository: {
          pullRequest: {
            title: string;
            body: string | null;
            state: string;
            merged: boolean;
            author: { login: string };
            baseRefName: string;
            headRefName: string;
            additions: number;
            deletions: number;
            labels: { nodes: { name: string }[] };
          } | null;
        };
      };

      const pr = response.repository?.pullRequest;
      if (!pr) return { ok: false, reason: "fetch-error", message: "PR not found" };

      const labels = pr.labels.nodes.map((l) => l.name).join(", ");
      const state = pr.merged ? "MERGED" : pr.state;
      const markdown = [
        `# ${pr.title}`,
        `**State:** ${state} | **Author:** @${pr.author.login} | **Branch:** ${pr.headRefName} → ${pr.baseRefName} | **+${pr.additions} −${pr.deletions}**${labels ? ` | **Labels:** ${labels}` : ""}`,
        "",
        pr.body ?? "_No description provided._",
      ].join("\n");

      return {
        ok: true,
        title: `${parsed.owner}/${parsed.repo}#${parsed.id}: ${pr.title}`,
        markdown,
        tokenEstimate: Math.ceil(markdown.length / 4),
        sourceUrl: `https://github.com/${parsed.owner}/${parsed.repo}/pull/${parsed.id}`,
      };
    }

    if (parsed.type === "commit") {
      const response = (await client(GET_COMMIT_CONTEXT_QUERY, {
        owner: parsed.owner,
        repo: parsed.repo,
        oid: parsed.id,
      })) as {
        repository: {
          object: {
            message: string;
            author: { name: string; email: string; date: string };
            additions: number;
            deletions: number;
          } | null;
        };
      };

      const commit = response.repository?.object;
      if (!commit) return { ok: false, reason: "fetch-error", message: "Commit not found" };

      const markdown = [
        `# Commit ${parsed.id.slice(0, 7)}`,
        `**Author:** ${commit.author.name} | **Date:** ${commit.author.date} | **+${commit.additions} −${commit.deletions}**`,
        "",
        commit.message,
      ].join("\n");

      return {
        ok: true,
        title: `${parsed.owner}/${parsed.repo}@${parsed.id.slice(0, 7)}`,
        markdown,
        tokenEstimate: Math.ceil(markdown.length / 4),
        sourceUrl: `https://github.com/${parsed.owner}/${parsed.repo}/commit/${parsed.id}`,
      };
    }

    return { ok: false, reason: "fetch-error", message: "Unsupported GitHub URL type" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: "fetch-error", message };
  }
}

async function fetchUrlAsMarkdown(urlStr: string): Promise<UrlContextResult> {
  const safe = await isSafeUrl(urlStr);
  if (!safe) {
    return { ok: false, reason: "blocked", message: "URL points to a private or local address" };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response!: Response;
    let currentUrl = urlStr;
    const maxRedirects = 5;
    try {
      for (let i = 0; i <= maxRedirects; i++) {
        response = await fetch(currentUrl, {
          signal: controller.signal,
          headers: {
            "User-Agent": "Canopy/1.0 (URL Context Resolver)",
            Accept: "text/html, application/xhtml+xml, */*",
          },
          redirect: "manual",
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) break;
          const redirectUrl = new URL(location, currentUrl).href;
          const redirectSafe = await isSafeUrl(redirectUrl);
          if (!redirectSafe) {
            return {
              ok: false,
              reason: "blocked",
              message: "Redirect points to a private or local address",
            };
          }
          currentUrl = redirectUrl;
          continue;
        }
        break;
      }
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      return { ok: false, reason: "fetch-error", message: `HTTP ${response.status}` };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      return { ok: false, reason: "parse-error", message: "URL does not return HTML content" };
    }

    let html = await response.text();
    if (html.length > MAX_HTML_LENGTH) {
      html = html.slice(0, MAX_HTML_LENGTH);
    }

    const { JSDOM } = await import("jsdom");
    const { Readability } = await import("@mozilla/readability");
    const { NodeHtmlMarkdown } = await import("node-html-markdown");

    const dom = new JSDOM(html, { url: urlStr });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    const pageTitle = article?.title ?? dom.window.document.title ?? new URL(urlStr).hostname;
    const content = article?.content ?? html;
    const markdown = NodeHtmlMarkdown.translate(content, { maxConsecutiveNewlines: 2 });

    if (markdown.length === 0) {
      return { ok: false, reason: "parse-error", message: "Could not extract content from page" };
    }

    return {
      ok: true,
      title: pageTitle,
      markdown,
      tokenEstimate: Math.ceil(markdown.length / 4),
      sourceUrl: urlStr,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("abort")) {
      return { ok: false, reason: "fetch-error", message: "Request timed out" };
    }
    return { ok: false, reason: "fetch-error", message };
  }
}

export function registerUrlContextHandlers(): () => void {
  const handleResolve = async (
    _event: Electron.IpcMainInvokeEvent,
    url: string
  ): Promise<UrlContextResult> => {
    try {
      const parsed = parseGitHubUrl(url);
      if (parsed) {
        return await resolveGitHubUrl(parsed);
      }
      return await fetchUrlAsMarkdown(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: "fetch-error", message };
    }
  };

  ipcMain.handle(CHANNELS.URL_CONTEXT_RESOLVE, handleResolve);

  return () => {
    ipcMain.removeHandler(CHANNELS.URL_CONTEXT_RESOLVE);
  };
}
