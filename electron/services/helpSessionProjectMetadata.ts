import type { HelpAssistantTier } from "../../shared/types/ipc/maps.js";

export const PROJECT_METADATA_START = "<!-- DAINTREE_PROJECT_METADATA_START -->";
export const PROJECT_METADATA_END = "<!-- DAINTREE_PROJECT_METADATA_END -->";

// Codex silently truncates AGENTS.md past `project_doc_max_bytes` (32 KiB), and
// the generated template is held to 24 KiB of it. Git has no upper bound on
// worktrees, so the list is capped by count and by bytes and the remainder only
// counted — which keeps the whole block under MAX_PROJECT_METADATA_BYTES.
export const MAX_LISTED_WORKTREES = 20;
const WORKTREE_LIST_BUDGET_BYTES = 3000;
const MAX_VALUE_BYTES = 300;
export const MAX_PROJECT_METADATA_BYTES = 6 * 1024;

export interface HelpSessionWorktreeFact {
  path: string;
  /** Empty when git reported no branch line for the worktree. */
  branch: string;
  isMainWorktree: boolean;
}

/**
 * Project facts gathered at provision time. Every field is optional: each one
 * comes from an independent lookup, and a failed lookup leaves its field unset
 * rather than blocking the launch.
 */
export interface HelpSessionProjectFacts {
  name?: string;
  worktrees?: HelpSessionWorktreeFact[];
  forgeRemote?: { name: string; url: string };
}

export interface ProjectMetadataInput {
  projectId: string;
  projectPath: string;
  tier: HelpAssistantTier;
  daintreeControl: boolean;
  facts: HelpSessionProjectFacts;
}

/**
 * Values land inside inline code spans in a file the agent treats as ground
 * truth, and the block is located by its HTML-comment markers — so a project
 * name carrying a newline, a backtick or a comment delimiter must not be able
 * to break out of its line or forge a marker. Anything oversized is dropped
 * rather than shortened: a truncated path would name a place that doesn't exist.
 */
function cleanValue(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f`]/g, "").replace(/<!--|-->/g, "");
  if (cleaned.length === 0 || Buffer.byteLength(cleaned, "utf8") > MAX_VALUE_BYTES) return null;
  return cleaned;
}

/**
 * Strip credentials from a git remote URL, or return null when it can't be
 * shown safely. HTTPS remotes can embed a token as userinfo, and query strings
 * occasionally carry one too. Local-path and `file:` remotes are omitted: they
 * name nothing a forge CLI can use.
 */
export function sanitizeGitRemoteUrl(raw: string): string | null {
  const url = raw.trim();
  if (url.length === 0) return null;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (!["https:", "http:", "ssh:", "git:", "git+ssh:", "ssh+git:"].includes(parsed.protocol)) {
      return null;
    }
    if (!parsed.hostname) return null;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  }

  // scp-like syntax: `[user@]host:path`. A single-letter host is a Windows
  // drive (`C:\repo`), which git treats as a local path.
  const scp = /^(?:[^@/\s]+@)?([^:/\\\s]{2,}):(?!\/\/)(\S+)$/.exec(url);
  if (scp) return `${scp[1]}:${scp[2]}`;
  return null;
}

export function buildProjectMetadataAddendum(input: ProjectMetadataInput): string {
  const { facts } = input;
  const lines = [
    "## Project",
    "",
    "Your working folder is a Daintree session folder, not the project. The project this assistant serves, as Daintree observed it at launch:",
    "",
  ];

  const name = cleanValue(facts.name);
  if (name) lines.push(`- Name: \`${name}\``);
  const projectPath = cleanValue(input.projectPath);
  if (projectPath) lines.push(`- Path: \`${projectPath}\``);
  const projectId = cleanValue(input.projectId);
  if (projectId) lines.push(`- Project ID: \`${projectId}\``);

  if (facts.forgeRemote) {
    const remoteName = cleanValue(facts.forgeRemote.name);
    const remoteUrl = cleanValue(facts.forgeRemote.url);
    if (remoteName && remoteUrl) lines.push(`- Forge remote: \`${remoteName}\` \`${remoteUrl}\``);
  }

  if (facts.worktrees) {
    lines.push("- Git worktrees (`git worktree list`):");
    let listed = 0;
    let bytes = 0;
    for (const wt of facts.worktrees) {
      if (listed >= MAX_LISTED_WORKTREES) break;
      const wtPath = cleanValue(wt.path);
      if (!wtPath) continue;
      const branch = cleanValue(wt.branch);
      const branchText = branch ? `branch \`${branch}\`` : "no branch reported";
      const line = `  - \`${wtPath}\` — ${branchText}${wt.isMainWorktree ? " (main worktree)" : ""}`;
      bytes += Buffer.byteLength(line, "utf8") + 1;
      if (bytes > WORKTREE_LIST_BUDGET_BYTES) break;
      lines.push(line);
      listed++;
    }
    const remaining = facts.worktrees.length - listed;
    if (remaining > 0) lines.push(`  - …and ${remaining} more not listed`);
  }

  lines.push(`- Assistant tier setting: \`${input.tier}\``);
  lines.push(
    input.daintreeControl
      ? "- Daintree MCP tools: enabled for this assistant (`daintree` server)"
      : "- Daintree MCP tools: disabled for this assistant in Settings"
  );
  lines.push("");
  return lines.join("\n");
}
