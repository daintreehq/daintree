import { cn } from "@/lib/utils";

interface AssistantThinkingIndicatorProps {
  className?: string;
}

export function AssistantThinkingIndicator({ className }: AssistantThinkingIndicatorProps) {
  return (
    <div
      className={cn("pl-8 pr-6 py-4 relative", className)}
      role="article"
      aria-label="Assistant is thinking"
    >
      {/* Thread line visual */}
      <div className="absolute left-0 top-0 bottom-0 w-px bg-canopy-border ml-[26px]" />

      <div className="flex items-center gap-2">
        <span className="text-canopy-text/50 text-[13px]">Thinking</span>
        <div className="flex gap-1" aria-hidden="true">
          <span className="w-1 h-1 rounded-full bg-canopy-text/40 animate-pulse [animation-delay:0ms]" />
          <span className="w-1 h-1 rounded-full bg-canopy-text/40 animate-pulse [animation-delay:150ms]" />
          <span className="w-1 h-1 rounded-full bg-canopy-text/40 animate-pulse [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  );
}
