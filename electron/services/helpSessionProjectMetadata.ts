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
 * truth, and the block is located by its HTML-comment markers — so a value
 * carrying a newline, a backtick or a comment delimiter must not be able to
 * break out of its line or forge a marker. Such values are dropped whole, never
 * edited: stripping characters renames a path or branch into one that doesn't
 * exist, and can reassemble the very delimiter it removed. Oversized values are
 * dropped for the same reason rather than shortened.
 */
function cleanValue(value: string | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f`]/.test(value)) return null;
  if (value.includes("<!--") || value.includes("-->")) return null;
  if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) return null;
  return value;
}

/**
 * Strip credentials from a git remote URL, or return null when it can't be
 * shown safely. HTTPS remotes can embed a token as userinfo. Local-path and
 * `file:` remotes are omitted: they name nothing a forge CLI can use.
 */
export function sanitizeGitRemoteUrl(raw: string): string | null {
  const url = raw.trim();
  if (url.length === 0) return null;
  // `?`/`#` are where tokens hide in a query, and where the WHATWG parser and
  // git disagree on the authority: `ssh://TOKEN#@host/repo` is host `TOKEN` to
  // URL but user `TOKEN#` to git. A real remote has no use for either.
  if (/[?#]/.test(url)) return null;

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
    // A percent-encoded authority (`ssh://TOKEN%40host/…`) is opaque to URL but
    // decoded by git, so userinfo would survive the clearing below.
    if (!parsed.hostname || parsed.host.includes("%")) return null;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  }

  // scp-like syntax: `[user@]host:path`. The host never contains `@`, so
  // userinfo can't hide inside it. A single-letter host is a Windows drive
  // (`C:\repo`), which git treats as a local path.
  const scp = /^(?:[^@/\s]+@)?(\[[^\]\s@]+\]|[^:/\\\s@[\]]+):(?!\/\/)(\S+)$/.exec(url);
  if (!scp) return null;
  const host = scp[1];
  if (/^[a-z]$/i.test(host)) return null;
  return `${host}:${scp[2]}`;
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

  // Settings, not session state: lanes launched earlier keep whatever wiring
  // they were provisioned with, and this block is shared by all of them.
  lines.push(`- Assistant tool set setting: \`${input.tier}\``);
  lines.push(`- Daintree MCP tools setting: \`${input.daintreeControl ? "enabled" : "disabled"}\``);
  lines.push("");
  return lines.join("\n");
}
