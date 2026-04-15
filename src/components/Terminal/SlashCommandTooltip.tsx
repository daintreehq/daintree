import { memo } from "react";
import type { SlashCommand } from "@shared/types";
import { cn } from "@/lib/utils";

interface SlashCommandTooltipContentProps {
  command: SlashCommand;
}

export const SlashCommandTooltipContent = memo(function SlashCommandTooltipContent({
  command,
}: SlashCommandTooltipContentProps) {
  const scopeLabel = (command.scope as string) === "daintree" ? "Daintree" : command.agentId;
  const scopeColor =
    (command.scope as string) === "daintree"
      ? "text-daintree-accent"
      : command.agentId === "claude"
        ? "text-cat-blue"
        : command.agentId === "gemini"
          ? "text-cat-violet"
          : command.agentId === "kiro"
            ? "text-cat-pink"
            : "text-cat-green";

  return (
    <div className="space-y-1.5 max-w-[280px]">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs font-semibold text-daintree-text">{command.label}</span>
        <span className={cn("text-[10px] font-medium uppercase tracking-wide", scopeColor)}>
          {scopeLabel}
        </span>
      </div>
      <p className="text-[11px] text-daintree-text/70 leading-relaxed">{command.description}</p>
      {command.sourcePath && (
        <p className="text-[10px] text-daintree-text/40 font-mono truncate pt-0.5">
          {command.sourcePath}
        </p>
      )}
    </div>
  );
});
