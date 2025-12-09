import { cn } from "@/lib/utils";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { getBrandColorHex } from "@/lib/colorUtils";
import type { TerminalType } from "@/types";

export interface TerminalListItemProps {
  id: string;
  title: string;
  type: TerminalType;
  worktreeName?: string;
  cwd: string;
  isSelected: boolean;
  onClick: () => void;
}

function truncatePath(path: string, maxLength: number = 40): string {
  if (path.length <= maxLength) {
    return path;
  }
  const ellipsis = "...";
  const remaining = maxLength - ellipsis.length;
  return ellipsis + path.slice(-remaining);
}

export function TerminalListItem({
  id,
  title,
  type,
  worktreeName,
  cwd,
  isSelected,
  onClick,
}: TerminalListItemProps) {
  const worktreeLabel = worktreeName ? ` in ${worktreeName}` : "";
  const fullLabel = `${title}${worktreeLabel} — ${cwd}`;

  return (
    <button
      id={id}
      type="button"
      className={cn(
        "w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left",
        "transition-colors duration-100",
        isSelected
          ? "bg-canopy-accent/20 border border-canopy-accent"
          : "hover:bg-white/5 border border-transparent"
      )}
      onClick={onClick}
      aria-selected={isSelected}
      aria-label={fullLabel}
      role="option"
    >
      <span className="shrink-0 text-canopy-text/70" aria-hidden="true">
        <TerminalIcon type={type} brandColor={getBrandColorHex(type)} />
      </span>

      <div className="flex-1 min-w-0 overflow-hidden">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-canopy-text truncate">{title}</span>

          {worktreeName && (
            <span className="shrink-0 px-1.5 py-0.5 text-xs rounded-[var(--radius-sm)] bg-canopy-accent/10 text-canopy-accent border border-canopy-accent/30">
              {worktreeName}
            </span>
          )}
        </div>

        <div className="text-xs text-canopy-text/50 truncate" title={cwd}>
          {truncatePath(cwd)}
        </div>
      </div>

      <span className="shrink-0 text-xs text-canopy-text/40 capitalize">{type}</span>
    </button>
  );
}

export default TerminalListItem;
