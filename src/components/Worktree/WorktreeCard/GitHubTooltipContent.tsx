import { memo } from "react";
import type { IssueTooltipData, PRTooltipData } from "@shared/types/github";
import { Loader2, User, Users, Calendar } from "lucide-react";
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
    <div className="flex items-center gap-2 text-canopy-text/70 py-1">
      <Loader2 className="w-3 h-3 animate-spin" />
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
  const stateColor = data.state === "OPEN" ? "text-emerald-400" : "text-red-400";

  return (
    <div className="space-y-2 max-w-[280px]">
      <div className="flex items-start gap-2">
        <span className={cn("text-xs font-medium shrink-0", stateColor)}>#{data.number}</span>
        <span className="text-xs text-canopy-text/90 line-clamp-2">{data.title}</span>
      </div>

      {data.bodyExcerpt && (
        <p className="text-[11px] text-canopy-text/60 line-clamp-3">{data.bodyExcerpt}</p>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-canopy-text/50">
        <span className="flex items-center gap-1">
          <User className="w-3 h-3" />
          {data.author.login}
        </span>

        {data.assignees.length > 0 && (
          <span className="flex items-center gap-1">
            <Users className="w-3 h-3" />
            {data.assignees.length === 1
              ? data.assignees[0].login
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
            <span className="text-[10px] text-canopy-text/40">+{data.labels.length - 4} more</span>
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
      ? "text-violet-400"
      : data.state === "CLOSED"
        ? "text-red-400"
        : "text-sky-400";

  const stateLabel = data.isDraft ? "Draft" : data.state.toLowerCase();

  return (
    <div className="space-y-2 max-w-[280px]">
      <div className="flex items-start gap-2">
        <span className={cn("text-xs font-medium shrink-0", stateColor)}>#{data.number}</span>
        <span className="text-xs text-canopy-text/90 line-clamp-2">{data.title}</span>
        <span
          className={cn(
            "text-[10px] px-1.5 py-0.5 rounded-full shrink-0 capitalize",
            data.state === "MERGED"
              ? "bg-violet-400/20 text-violet-400"
              : data.state === "CLOSED"
                ? "bg-red-400/20 text-red-400"
                : "bg-sky-400/20 text-sky-400"
          )}
        >
          {stateLabel}
        </span>
      </div>

      {data.bodyExcerpt && (
        <p className="text-[11px] text-canopy-text/60 line-clamp-3">{data.bodyExcerpt}</p>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-canopy-text/50">
        <span className="flex items-center gap-1">
          <User className="w-3 h-3" />
          {data.author.login}
        </span>

        {data.assignees.length > 0 && (
          <span className="flex items-center gap-1">
            <Users className="w-3 h-3" />
            {data.assignees.length === 1
              ? data.assignees[0].login
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
            <span className="text-[10px] text-canopy-text/40">+{data.labels.length - 4} more</span>
          )}
        </div>
      )}
    </div>
  );
});
