import { useMemo } from "react";
import { cn } from "../../lib/utils";
import { middleTruncate } from "../../utils/textParsing";
import { BRANCH_PREFIX_MAP, DEFAULT_BRANCH_TYPE } from "@shared/config/branchPrefixes";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";

interface BranchLabelProps {
  label: string;
  isActive: boolean;
  isMainWorktree?: boolean;
  className?: string;
}

export function BranchLabel({ label, isActive, isMainWorktree, className }: BranchLabelProps) {
  const { displayName, colors, rest } = useMemo(() => {
    const parts = label.split("/");
    if (parts.length <= 1) {
      return { displayName: null, colors: null, rest: middleTruncate(label, 40) };
    }

    const [prefix, ...tail] = parts;
    const config = BRANCH_PREFIX_MAP[prefix.toLowerCase()];

    if (config) {
      return {
        displayName: config.displayName,
        colors: config.colors,
        rest: middleTruncate(tail.join("/"), 36),
      };
    } else {
      return {
        displayName:
          prefix.length <= 4
            ? prefix.toUpperCase()
            : prefix.charAt(0).toUpperCase() + prefix.slice(1).toLowerCase(),
        colors: DEFAULT_BRANCH_TYPE.colors,
        rest: middleTruncate(tail.join("/"), 36),
      };
    }
  }, [label]);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn("flex items-center gap-1.5 min-w-0 cursor-pointer", className)}>
            {displayName && colors && (
              <span
                className={cn(
                  "text-[11px] tracking-wide font-medium px-1.5 py-0.5 rounded border shrink-0",
                  colors.bg,
                  colors.border,
                  colors.text
                )}
              >
                {displayName}
              </span>
            )}
            <span
              className={cn(
                "truncate font-mono font-semibold text-[13px]",
                isActive ? "text-white" : "text-canopy-text",
                isMainWorktree && "font-bold tracking-wide"
              )}
            >
              {rest}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
