import { useEffect, useState, type ComponentType } from "react";
import { cn } from "@/lib/utils";
import { CAT_COLOR_CLASSES } from "@/config/categoryColors";
import { AGENT_REGISTRY, type AgentIconProps } from "@/config/agents";
import { getGravatarUrl, isBotAuthor } from "@/utils/gravatar";
import { djb2 } from "@shared/utils/hash";

export interface CommitAuthor {
  name: string;
  email: string;
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
 * Match the commit author against the agent registry. Returns the branded
 * icon component when the committer is a known AI agent (Claude, Codex,
 * Gemini, …), else null so the avatar chain falls through to a picture.
 *
 * Matching is intentionally email-only and conservative: an exact
 * machine-email map, or an email segment that exactly equals an agent id
 * (≥4 chars, to avoid short-token collisions). Author *name* is deliberately
 * not matched — a human committing as "Claude Monet" must not be painted as
 * an AI agent.
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

/** Square for AI agents and bots, circle for humans. */
export function commitAvatarIsSquare(author: CommitAuthor): boolean {
  return resolveCommitAgentIcon(author) != null || isBotAuthor(author.name);
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}

export interface CommitAuthorAvatarProps {
  author: CommitAuthor;
  /**
   * Forge profile picture. When present it is tried before Gravatar.
   */
  forgeAvatarUrl?: string;
  /** Rendered edge length in px. Default 16. */
  size?: number;
  className?: string;
}

/**
 * Commit-author avatar. Resolves through four ordered tiers — branded agent
 * icon, forge profile picture, `d=404` Gravatar probe, then deterministic
 * coloured initials — so a real face shows when one exists and a meaningful
 * placeholder shows when it doesn't. Decorative: callers carry the accessible
 * name, so the avatar is `aria-hidden`.
 *
 * Carries no border or ring of its own — the picture sits flush on whatever
 * surface hosts it.
 */
export function CommitAuthorAvatar({
  author,
  forgeAvatarUrl,
  size = 16,
  className,
}: CommitAuthorAvatarProps) {
  const AgentIcon = resolveCommitAgentIcon(author);
  const square = commitAvatarIsSquare(author);
  const radius = square ? "rounded-md" : "rounded-full";
  const box = { width: size, height: size } as const;

  // Ordered image tiers tried before initials: forge picture, then a
  // `d=404` Gravatar probe. Skip Gravatar when offline — the request would
  // otherwise hang until the browser timeout before firing onError.
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  const imgSources: string[] = [];
  if (!AgentIcon) {
    if (forgeAvatarUrl) imgSources.push(forgeAvatarUrl);
    if (!offline && author.email.trim()) imgSources.push(getGravatarUrl(author.email, size * 2));
  }

  const [srcIndex, setSrcIndex] = useState(0);
  const identityKey = `${author.email}|${author.name}|${forgeAvatarUrl ?? ""}`;
  useEffect(() => {
    setSrcIndex(0);
  }, [identityKey]);

  if (AgentIcon) {
    return (
      <span
        aria-hidden="true"
        className={cn("flex shrink-0 items-center justify-center", className)}
        style={box}
      >
        <AgentIcon size={size} />
      </span>
    );
  }

  const src = imgSources[srcIndex];
  if (src == null) {
    const key = (author.email.trim() || author.name.trim()).toLowerCase();
    const color = CAT_COLOR_CLASSES[Math.abs(djb2(key)) % CAT_COLOR_CLASSES.length]!;
    return (
      <span
        aria-hidden="true"
        className={cn(
          "flex shrink-0 items-center justify-center font-semibold leading-none",
          radius,
          color,
          className
        )}
        style={{ ...box, fontSize: Math.round(size * 0.5) }}
      >
        {initialsOf(author.name)}
      </span>
    );
  }

  return (
    <img
      key={src}
      src={src}
      alt=""
      aria-hidden="true"
      onError={() => setSrcIndex((i) => i + 1)}
      className={cn("shrink-0 object-cover", radius, className)}
      style={box}
    />
  );
}
