import { memo } from "react";
import { cn } from "@/lib/utils";

export interface SlashCommandChipProps {
  command: string;
  isValid: boolean;
  className?: string;
}

export const SlashCommandChip = memo(function SlashCommandChip({
  command,
  isValid,
  className,
}: SlashCommandChipProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 font-mono text-xs font-medium transition-colors",
        isValid
          ? "bg-canopy-accent/20 text-canopy-accent border border-canopy-accent/30"
          : "bg-red-500/20 text-red-400 border border-red-500/30",
        className
      )}
      data-slash-command-chip
      data-command={command}
    >
      <span className="select-none opacity-75">/</span>
      <span>{command.slice(1)}</span>
    </span>
  );
});
