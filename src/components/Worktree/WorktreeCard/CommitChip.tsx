import { useEffect, useState, type ComponentType } from "react";
import { cn } from "@/lib/utils";
import { CAT_COLOR_CLASSES } from "@/config/categoryColors";
import { AGENT_REGISTRY, type AgentIconProps } from "@/config/agents";
import { getGravatarUrl, isBotAuthor } from "@/utils/gravatar";
import { LiveTimeAgo } from "../LiveTimeAgo";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export interface CommitAuthor {
  name: string;
  email: string;
}

export interface CommitChipProps {
  /** Timestamp of the last commit. The chip's relative time always shows this. */
  lastCommitTimestampMs: number;
  /** Commit author. When absent the chip shows the time only (no avatar). */
  author?: CommitAuthor | null;
  /** Commit subject, shown on the first tooltip line. */
  commitMessage?: string;
  /**
   * Reserved seat for the forge profile-picture provider issue. When present
   * it is tried before Gravatar. This issue does not populate it.
   */
  forgeAvatarUrl?: string;
  /**
   * Reserved seat for the avatar freshness-ring issue. Accepted but unused
   * here so the ring work layers on without changing this API.
   */
  lastActivityTimestamp?: number | null;
}

// CLI tools that commit under a fixed machine identity rather than the
// human's git config. Maps the commit email to an agent registry id.
const MACHINE_EMAIL_TO_AGENT: Record<string, string> = {
  "noreply@codex.openai.com": "codex",
  "codex@example.com": "codex",
  "gemini-cli-agent@google.com": "gemini",
  "claude-code@anthropic.com": "claude",
  "noreply@anthropic.com": "claude",
};

/**
 * Tier 1 — match the commit author against the agent registry. Returns the
 * branded icon component when the committer is a known AI agent (Claude,
 * Codex, Gemini, …), else null so the chain falls through.
 *
 * Matching is intentionally email-only and conservative: an exact
 * machine-email map, or an email segment that exactly equals an agent id
 * (≥4 chars, to avoid short-token collisions). Author *name* is deliberately
 * not matched — a human committing as "Claude Monet" must not be painted as
 * an AI agent. Every documented real agent identity (Codex, Gemini CLI,
 * Claude Code's co-author address) is covered by the email signal.
 */
export function resolveCommitAgentIcon(author: CommitAuthor): ComponentType<AgentIconProps> | null {
  const email = author.email.trim().toLowerCase();

  const mapped = MACHINE_EMAIL_TO_AGENT[email];
  if (mapped && AGENT_REGISTRY[mapped]) return AGENT_REGISTRY[mapped].icon;

  const segments = email.split(/[^a-z0-9]+/).filter(Boolean);
  for (const agent of Object.values(AGENT_REGISTRY)) {
    const id = agent.id.toLowerCase();
    if (id.length >= 4 && segments.includes(id)) return agent.icon;
  }
  return null;
}

function djb2(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return hash;
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}

function relativeCommitPhrase(diffMs: number): string {
  const s = Math.floor(diffMs / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (s < 60) return "just now";
  if (m < 60) return `${m} minute${m !== 1 ? "s" : ""} ago`;
  if (h < 24) return `${h} hour${h !== 1 ? "s" : ""} ago`;
  if (d < 7) return `${d} day${d !== 1 ? "s" : ""} ago`;
  const w = Math.floor(d / 7);
  return `${w} week${w !== 1 ? "s" : ""} ago`;
}

const AVATAR_SIZE = "h-4 w-4 shrink-0";

/**
 * Tier 4 — deterministic coloured initials. Background hue is hashed from the
 * author email (falls back to name) so the same person keeps one colour
 * everywhere. Decorative: the chip itself carries the accessible name.
 */
function InitialsAvatar({ author, square }: { author: CommitAuthor; square: boolean }) {
  const key = (author.email.trim() || author.name.trim()).toLowerCase();
  const color = CAT_COLOR_CLASSES[Math.abs(djb2(key)) % CAT_COLOR_CLASSES.length]!;
  return (
    <span
      aria-hidden="true"
      className={cn(
        AVATAR_SIZE,
        "flex items-center justify-center text-[8px] font-semibold leading-none",
        square ? "rounded-md" : "rounded-full",
        color
      )}
    >
      {initialsOf(author.name)}
    </span>
  );
}

function CommitChipAvatar({
  author,
  forgeAvatarUrl,
}: {
  author: CommitAuthor;
  forgeAvatarUrl?: string;
}) {
  const AgentIcon = resolveCommitAgentIcon(author);
  const square = AgentIcon != null || isBotAuthor(author.name);

  // Ordered image tiers tried before initials: forge picture, then a
  // `d=404` Gravatar probe. Skip Gravatar when offline — the request would
  // otherwise hang until the browser timeout before firing onError.
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  const imgSources: string[] = [];
  if (!AgentIcon) {
    if (forgeAvatarUrl) imgSources.push(forgeAvatarUrl);
    if (!offline && author.email.trim()) imgSources.push(getGravatarUrl(author.email, 32));
  }

  const [srcIndex, setSrcIndex] = useState(0);
  const identityKey = `${author.email}|${author.name}|${forgeAvatarUrl ?? ""}`;
  useEffect(() => {
    setSrcIndex(0);
  }, [identityKey]);

  if (AgentIcon) {
    return (
      <span aria-hidden="true" className={cn(AVATAR_SIZE, "flex items-center justify-center")}>
        <AgentIcon size={16} />
      </span>
    );
  }

  const src = imgSources[srcIndex];
  if (src == null) {
    return <InitialsAvatar author={author} square={square} />;
  }

  return (
    <img
      key={src}
      src={src}
      alt=""
      aria-hidden="true"
      onError={() => setSrcIndex((i) => i + 1)}
      className={cn(AVATAR_SIZE, "object-cover", square ? "rounded-md" : "rounded-full")}
    />
  );
}

/**
 * Single trailing chip for a worktree row: one identity avatar plus one
 * relative time, both keyed to the last commit. Replaces the former
 * avatar+commit-time / ActivityLight+activity-time pair that collapsed to a
 * duplicated label on a clean tree. Self-contained so the forge-picture and
 * freshness-ring work can layer on via the reserved props.
 */
export function CommitChip({
  lastCommitTimestampMs,
  author,
  commitMessage,
  forgeAvatarUrl,
}: CommitChipProps) {
  const relative = relativeCommitPhrase(Date.now() - lastCommitTimestampMs);
  const absolute = new Date(lastCommitTimestampMs).toLocaleString();
  const authorClause = author
    ? `${author.name} · committed ${relative} (${absolute})`
    : `Committed ${relative} (${absolute})`;
  const accessibleName = author ? `Last commit by ${author.name}` : "Last commit";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="relative z-10 ml-3 flex shrink-0 items-center gap-1 text-xs text-text-muted"
          aria-label={accessibleName}
        >
          {author && <CommitChipAvatar author={author} forgeAvatarUrl={forgeAvatarUrl} />}
          <LiveTimeAgo timestamp={lastCommitTimestampMs} noTooltip />
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <div className="flex flex-col gap-0.5">
          {commitMessage && <span className="font-medium">{`"${commitMessage}"`}</span>}
          <span>{authorClause}</span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
