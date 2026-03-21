import { useMemo } from "react";
import { cn } from "../../lib/utils";
import { middleTruncate } from "../../utils/textParsing";
import { BRANCH_PREFIX_MAP, DEFAULT_BRANCH_TYPE } from "@shared/config/branchPrefixes";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  BookOpen,
  Bug,
  Construction,
  FlaskConical,
  GitBranch,
  Infinity as InfinityIcon,
  Layers,
  Sparkle,
  Package,
  Palette,
  Rocket,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";

const BRANCH_TYPE_ICONS: Record<string, LucideIcon> = {
  feature: Sparkle,
  bugfix: Bug,
  chore: Wrench,
  docs: BookOpen,
  refactor: Layers,
  test: FlaskConical,
  release: Rocket,
  ci: InfinityIcon,
  deps: Package,
  perf: Zap,
  style: Palette,
  wip: Construction,
  other: GitBranch,
};

interface BranchLabelProps {
  label: string;
  isActive: boolean;
  isMuted?: boolean;
  isMainWorktree?: boolean;
  className?: string;
}

export function BranchLabel({
  label,
  isActive,
  isMuted,
  isMainWorktree,
  className,
}: BranchLabelProps) {
  const { displayName, typeId, rest } = useMemo(() => {
    const parts = label.split("/");
    if (parts.length <= 1) {
      return { displayName: null, typeId: null, rest: middleTruncate(label, 40) };
    }

    const [prefix, ...tail] = parts;
    const config = BRANCH_PREFIX_MAP[prefix.toLowerCase()];

    if (config) {
      return {
        displayName: config.displayName,
        typeId: config.id,
        rest: middleTruncate(tail.join("/"), 36),
      };
    } else {
      return {
        displayName:
          prefix.length <= 4
            ? prefix.toUpperCase()
            : prefix.charAt(0).toUpperCase() + prefix.slice(1).toLowerCase(),
        typeId: DEFAULT_BRANCH_TYPE.id,
        rest: middleTruncate(tail.join("/"), 36),
      };
    }
  }, [label]);

  const Icon = typeId ? (BRANCH_TYPE_ICONS[typeId] ?? GitBranch) : null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("flex items-center gap-1.5 min-w-0 cursor-default", className)}>
          {Icon && displayName && (
            <span className="shrink-0 flex items-center" aria-label={displayName}>
              <Icon
                className={cn(
                  "w-3.5 h-3.5 transition-colors duration-200",
                  isMuted ? "text-text-muted" : "text-text-secondary"
                )}
                strokeWidth={2.5}
                aria-hidden="true"
              />
            </span>
          )}
          <span
            className={cn(
              "truncate font-mono transition-colors duration-200",
              isMainWorktree ? "text-[13px] font-bold tracking-wide" : "text-[11px] font-medium",
              isActive
                ? "text-text-primary/90"
                : isMuted
                  ? "text-text-muted"
                  : "text-text-secondary"
            )}
          >
            {rest}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {displayName ? `${displayName}: ${label}` : label}
      </TooltipContent>
    </Tooltip>
  );
}
