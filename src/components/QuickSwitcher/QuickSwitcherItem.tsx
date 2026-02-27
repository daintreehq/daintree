import { cn } from "@/lib/utils";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { getBrandColorHex } from "@/lib/colorUtils";
import { GitBranch } from "lucide-react";
import type { QuickSwitcherItem as QuickSwitcherItemData } from "@/hooks/useQuickSwitcher";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";

export interface QuickSwitcherItemProps {
  item: QuickSwitcherItemData;
  isSelected: boolean;
  onClick: () => void;
}

export function QuickSwitcherItem({ item, isSelected, onClick }: QuickSwitcherItemProps) {
  return (
    <button
      id={`qs-option-${item.id}`}
      type="button"
      className={cn(
        "relative w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left",
        "transition-colors",
        "border",
        isSelected
          ? "bg-white/[0.03] border-overlay text-canopy-text before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[2px] before:rounded-r before:bg-canopy-accent before:content-['']"
          : "border-transparent text-canopy-text/70 hover:bg-white/[0.02] hover:text-canopy-text"
      )}
      onClick={onClick}
      aria-selected={isSelected}
      aria-label={item.title}
      role="option"
    >
      <span className="shrink-0 text-canopy-text/70" aria-hidden="true">
        {item.type === "terminal" ? (
          <TerminalIcon
            type={item.terminalType}
            kind={item.terminalKind}
            agentId={item.agentId}
            detectedProcessId={item.detectedProcessId}
            brandColor={getBrandColorHex(item.agentId ?? item.terminalType)}
          />
        ) : (
          <GitBranch className="w-4 h-4" />
        )}
      </span>

      <div className="flex-1 min-w-0 overflow-hidden">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-canopy-text truncate">{item.title}</span>
          <span
            className={cn(
              "shrink-0 px-1.5 py-0.5 text-xs rounded-[var(--radius-sm)] border",
              item.type === "terminal"
                ? "bg-canopy-accent/10 text-canopy-accent border-canopy-accent/30"
                : "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
            )}
          >
            {item.type === "terminal" ? (item.terminalType ?? "terminal") : "worktree"}
          </span>
        </div>
        {item.subtitle && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="text-xs text-canopy-text/50 truncate">{item.subtitle}</div>
              </TooltipTrigger>
              <TooltipContent side="bottom">{item.subtitle}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
    </button>
  );
}
