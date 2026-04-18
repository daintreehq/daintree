import { memo } from "react";
import type { IssueTooltipData, PRTooltipData } from "@shared/types/github";
import { User, Users, Calendar } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

interface TooltipLoadingProps {
  type: "issue" | "pr";
}

export const TooltipLoading = memo(function TooltipLoading({ type }: TooltipLoadingProps) {
  return (
    <div className="flex items-center gap-2 text-daintree-text/70 py-1">
      <Spinner size="xs" />
      <span className="text-xs">Loading {type} details...</span>
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
