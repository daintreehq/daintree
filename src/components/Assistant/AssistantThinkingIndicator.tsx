import { cn } from "@/lib/utils";
import { CanopyIcon } from "@/components/icons/CanopyIcon";

interface AssistantThinkingIndicatorProps {
  className?: string;
}

export function AssistantThinkingIndicator({ className }: AssistantThinkingIndicatorProps) {
  return (
    <div
      className={cn(
        "group relative flex w-full gap-3 px-4 py-4 border-b border-divider/20",
        className
      )}
      role="article"
      aria-label="Assistant is thinking"
    >
      <div className="shrink-0 pt-[3px]" aria-hidden="true">
        <CanopyIcon size={14} className="text-canopy-text/40" />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-canopy-text/60 text-sm">Thinking</span>
        <div className="flex gap-1" aria-hidden="true">
          <span className="w-1 h-1 rounded-full bg-canopy-text/40 animate-pulse [animation-delay:0ms]" />
          <span className="w-1 h-1 rounded-full bg-canopy-text/40 animate-pulse [animation-delay:150ms]" />
          <span className="w-1 h-1 rounded-full bg-canopy-text/40 animate-pulse [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  );
}
