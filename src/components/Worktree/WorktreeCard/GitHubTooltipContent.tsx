import { memo } from "react";
import type { IssueTooltipData, PRTooltipData } from "@shared/types/github";
import { User, Users, Calendar, KeyRound } from "lucide-react";
import { cn } from "@/lib/utils";

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export const TooltipLoading = memo(function TooltipLoading() {
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
});

interface TokenMissingTooltipProps {
  type: "issue" | "pr";
}

export const TokenMissingTooltip = memo(function TokenMissingTooltip({
  type,
}: TokenMissingTooltipProps) {
  return (
    <div className="flex items-center gap-2 text-daintree-text/60 py-1">
      <KeyRound className="w-3.5 h-3.5 shrink-0 text-daintree-accent/60" aria-hidden="true" />
      <span className="text-xs">Configure GitHub token to see {type} details</span>
    </div>
  );
});

interface LabelBadgeProps {
  name: string;
  color: string;
}

const LabelBadge = memo(function LabelBadge({ name, color }: LabelBadgeProps) {
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
});

interface IssueTooltipContentProps {
  data: IssueTooltipData;
}

export const IssueTooltipContent = memo(function IssueTooltipContent({
  data,
}: IssueTooltipContentProps) {
  const stateColor = data.state === "OPEN" ? "text-github-open" : "text-github-merged";

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
          <User className="w-3 h-3" />
          {data.author.login}
        </span>

        {data.assignees.length > 0 && (
          <span className="flex items-center gap-1">
            <Users className="w-3 h-3" />
            {data.assignees.length === 1
              ? data.assignees[0]!.login
              : `${data.assignees.length} assignees`}
          </span>
        )}

        <span className="flex items-center gap-1">
          <Calendar className="w-3 h-3" />
          {formatDate(data.createdAt)}
        </span>
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
});

interface PRTooltipContentProps {
  data: PRTooltipData;
}

export const PRTooltipContent = memo(function PRTooltipContent({ data }: PRTooltipContentProps) {
  const stateColor =
    data.state === "MERGED"
      ? "text-github-merged"
      : data.state === "CLOSED"
        ? "text-github-closed"
        : "text-github-open";

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
              ? "bg-github-merged/20 text-github-merged"
              : data.state === "CLOSED"
                ? "bg-github-closed/20 text-github-closed"
                : "bg-github-open/20 text-github-open"
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
          <User className="w-3 h-3" />
          {data.author.login}
        </span>

        {data.assignees.length > 0 && (
          <span className="flex items-center gap-1">
            <Users className="w-3 h-3" />
            {data.assignees.length === 1
              ? data.assignees[0]!.login
              : `${data.assignees.length} assignees`}
          </span>
        )}

        <span className="flex items-center gap-1">
          <Calendar className="w-3 h-3" />
          {formatDate(data.createdAt)}
        </span>
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
});
