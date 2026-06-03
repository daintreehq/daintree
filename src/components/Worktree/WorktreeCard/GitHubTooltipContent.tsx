import type { GitHubUser, IssueTooltipData, PRTooltipData } from "@shared/types/github";
import { Calendar, KeyRound, PenLine, UserCheck, Clock, CirclePause } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { BadgeFreshnessCause } from "@/components/Layout/FreshnessUtils";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/Avatar";

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// GitHub's avatar CDN honours a `?s=` pixel size. Request 2× the rendered size
// for crisp HiDPI, replacing any existing `s=` so we never double up the param.
function withAvatarSize(url: string | undefined, size: number): string {
  if (!url) return "";
  if (/[?&]s=\d+/.test(url)) {
    return url.replace(/([?&])s=\d+/, `$1s=${size}`);
  }
  return `${url}${url.includes("?") ? "&" : "?"}s=${size}`;
}

// Author / single-assignee avatar: the login renders as adjacent text, so the
// image is decorative (`alt=""`) and carries no redundant hover title.
function GitHubAvatar({
  user,
  sizeClass,
  urlSize,
}: {
  user: GitHubUser;
  sizeClass: string;
  urlSize: number;
}) {
  return (
    <Avatar
      src={withAvatarSize(user.avatarUrl, urlSize)}
      alt=""
      className={cn(sizeClass, "shrink-0")}
    />
  );
}

// Assignee metadata cell. A `UserCheck` glyph marks the role (vs the author
// row's `PenLine`) so creator and assignee read apart at a glance. One assignee
// → glyph + avatar + login. Two or more → an overlapping avatar stack capped at
// 3 with a `+N` overflow; the stack is aria-hidden (each avatar exposes its
// login on hover via a native `title`, which survives the app-level
// `disableHoverableContent` provider) and an sr-only sentence names everyone.
function AssigneeMeta({ assignees }: { assignees: GitHubUser[] }) {
  if (assignees.length === 1) {
    return (
      <span className="flex items-center gap-1">
        <UserCheck className="w-3 h-3 shrink-0" aria-hidden="true" />
        <GitHubAvatar user={assignees[0]!} sizeClass="w-3.5 h-3.5" urlSize={28} />
        <span className="sr-only">Assigned to </span>
        {assignees[0]!.login}
      </span>
    );
  }

  const shown = assignees.slice(0, 3);
  const overflow = assignees.length - shown.length;

  return (
    <span className="flex items-center gap-1">
      <UserCheck className="w-3 h-3 shrink-0" aria-hidden="true" />
      <span className="flex items-center -space-x-1" aria-hidden="true">
        {shown.map((user, i) => (
          <span
            key={user.login}
            title={user.login}
            className="relative inline-flex rounded-full"
            style={{ zIndex: shown.length - i }}
          >
            <Avatar
              src={withAvatarSize(user.avatarUrl, 24)}
              alt=""
              className="w-3 h-3 shrink-0 rounded-full ring-2 ring-[var(--color-surface-sidebar)]"
            />
          </span>
        ))}
      </span>
      {overflow > 0 && <span aria-hidden="true">+{overflow}</span>}
      <span className="sr-only">Assigned to {assignees.map((u) => u.login).join(", ")}</span>
    </span>
  );
}

export interface TooltipFreshness {
  cause: BadgeFreshnessCause | undefined;
  now: number;
  rateLimitResetAt?: number | null;
}

function freshnessItem(
  freshness: TooltipFreshness | undefined
): { Icon: LucideIcon; label: string } | null {
  if (!freshness) return null;
  switch (freshness.cause) {
    case "rate-limit": {
      let label = "rate limited";
      const { rateLimitResetAt, now } = freshness;
      if (rateLimitResetAt != null && Number.isFinite(rateLimitResetAt) && rateLimitResetAt > now) {
        const retryTime = new Intl.DateTimeFormat("en-US", {
          hour: "numeric",
          minute: "2-digit",
        }).format(new Date(rateLimitResetAt));
        label += `, retry at ${retryTime}`;
      }
      return { Icon: Clock, label };
    }
    case "circuit-breaker":
      return { Icon: CirclePause, label: "data may be stale — PR detection paused" };
    default:
      return null;
  }
}

/**
 * Freshness status as a metadata-row item: a small Lucide icon + label that
 * matches the author/assignee/date entries. Folds the old `·`-prefixed block
 * line (#9696) onto the metadata row. Rendered standalone with a `className`
 * (e.g. `mt-1`) by the badges when the tooltip body has no data row to host it.
 */
export function FreshnessMetaItem({
  freshness,
  className,
}: {
  freshness?: TooltipFreshness;
  className?: string;
}) {
  const item = freshnessItem(freshness);
  if (!item) return null;
  const { Icon, label } = item;
  return (
    <span className={cn("flex items-center gap-1", className)}>
      <Icon className="w-3 h-3 shrink-0" aria-hidden="true" />
      {label}
    </span>
  );
}

export function TooltipLoading() {
  // Doherty-gated skeleton: `animate-pulse-delayed` keeps the bars invisible
  // for the first 400ms, so a fast cache-warm response (the common case after
  // the poll has pre-warmed `prTooltipCache`) shows nothing rather than a
  // flash. After 400ms the bars fade in and pulse. Layout mirrors PR/issue
  // tooltip content: title row, body excerpt, metadata row.
  return (
    <div className="space-y-2 max-w-[280px]" aria-hidden="true">
      <div className="flex items-start gap-2">
        <div className="animate-pulse-delayed h-3 w-10 rounded bg-muted" />
        <div className="animate-pulse-delayed h-3 flex-1 rounded bg-muted" />
      </div>
      <div className="animate-pulse-delayed h-2.5 w-full rounded bg-muted" />
      <div className="animate-pulse-delayed h-2.5 w-2/3 rounded bg-muted" />
      <div className="flex items-center gap-3 pt-1">
        <div className="animate-pulse-delayed h-2 w-16 rounded bg-muted" />
        <div className="animate-pulse-delayed h-2 w-20 rounded bg-muted" />
      </div>
    </div>
  );
}

interface TokenMissingTooltipProps {
  type: "issue" | "pr";
}

export function TokenMissingTooltip({ type }: TokenMissingTooltipProps) {
  return (
    <div className="flex items-center gap-2 text-daintree-text/60 py-1">
      <KeyRound className="w-3.5 h-3.5 shrink-0 text-daintree-text/50" aria-hidden="true" />
      <span className="text-xs">Configure GitHub token to see {type} details</span>
    </div>
  );
}

interface LabelBadgeProps {
  name: string;
  color: string;
}

function LabelBadge({ name, color }: LabelBadgeProps) {
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium"
      style={{
        backgroundColor: `#${color}20`,
        color: `#${color}`,
        border: `1px solid #${color}40`,
      }}
    >
      {name}
    </span>
  );
}

interface IssueTooltipContentProps {
  data: IssueTooltipData;
  freshness?: TooltipFreshness;
}

export function IssueTooltipContent({ data, freshness }: IssueTooltipContentProps) {
  const stateColor = data.state === "OPEN" ? "text-pr-open" : "text-pr-merged";

  return (
    <div className="space-y-2 max-w-[280px]">
      <div className="flex items-start gap-2">
        <span className={cn("text-xs font-medium shrink-0", stateColor)}>#{data.number}</span>
        <span className="text-xs text-daintree-text/90 line-clamp-2">{data.title}</span>
      </div>

      {data.bodyExcerpt && (
        <p className="text-[11px] text-daintree-text/60 line-clamp-3">{data.bodyExcerpt}</p>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-daintree-text/50">
        <span className="flex items-center gap-1">
          <PenLine className="w-3 h-3 shrink-0" aria-hidden="true" />
          <GitHubAvatar user={data.author} sizeClass="w-3.5 h-3.5" urlSize={28} />
          <span className="sr-only">Created by </span>
          {data.author.login}
        </span>

        {data.assignees.length > 0 && <AssigneeMeta assignees={data.assignees} />}

        <span className="flex items-center gap-1">
          <Calendar className="w-3 h-3" />
          {formatDate(data.createdAt)}
        </span>

        <FreshnessMetaItem freshness={freshness} />
      </div>

      {data.labels.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1">
          {data.labels.slice(0, 4).map((label) => (
            <LabelBadge key={label.name} name={label.name} color={label.color} />
          ))}
          {data.labels.length > 4 && (
            <span className="text-[10px] text-daintree-text/40">
              +{data.labels.length - 4} more
            </span>
          )}
        </div>
      )}
    </div>
  );
}

interface PRTooltipContentProps {
  data: PRTooltipData;
  freshness?: TooltipFreshness;
}

export function PRTooltipContent({ data, freshness }: PRTooltipContentProps) {
  const stateColor =
    data.state === "MERGED"
      ? "text-pr-merged"
      : data.state === "CLOSED"
        ? "text-pr-closed"
        : "text-pr-open";

  const stateLabel = data.isDraft ? "Draft" : data.state.toLowerCase();

  return (
    <div className="space-y-2 max-w-[280px]">
      <div className="flex items-start gap-2">
        <span className={cn("text-xs font-medium shrink-0", stateColor)}>#{data.number}</span>
        <span className="text-xs text-daintree-text/90 line-clamp-2">{data.title}</span>
        <span
          className={cn(
            "text-[10px] px-1.5 py-0.5 rounded-full shrink-0 capitalize",
            data.state === "MERGED"
              ? "bg-pr-merged/20 text-pr-merged"
              : data.state === "CLOSED"
                ? "bg-pr-closed/20 text-pr-closed"
                : "bg-pr-open/20 text-pr-open"
          )}
        >
          {stateLabel}
        </span>
      </div>

      {data.bodyExcerpt && (
        <p className="text-[11px] text-daintree-text/60 line-clamp-3">{data.bodyExcerpt}</p>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-daintree-text/50">
        <span className="flex items-center gap-1">
          <PenLine className="w-3 h-3 shrink-0" aria-hidden="true" />
          <GitHubAvatar user={data.author} sizeClass="w-3.5 h-3.5" urlSize={28} />
          <span className="sr-only">Created by </span>
          {data.author.login}
        </span>

        {data.assignees.length > 0 && <AssigneeMeta assignees={data.assignees} />}

        <span className="flex items-center gap-1">
          <Calendar className="w-3 h-3" />
          {formatDate(data.createdAt)}
        </span>

        <FreshnessMetaItem freshness={freshness} />
      </div>

      {data.labels.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1">
          {data.labels.slice(0, 4).map((label) => (
            <LabelBadge key={label.name} name={label.name} color={label.color} />
          ))}
          {data.labels.length > 4 && (
            <span className="text-[10px] text-daintree-text/40">
              +{data.labels.length - 4} more
            </span>
          )}
        </div>
      )}
    </div>
  );
}
