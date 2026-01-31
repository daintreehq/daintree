import { cn } from "@/lib/utils";

interface AssistantThinkingIndicatorProps {
  className?: string;
}

export function AssistantThinkingIndicator({ className }: AssistantThinkingIndicatorProps) {
  return (
    <div
      className={cn("pl-14 pr-5 py-3 relative", className)}
      role="status"
      aria-label="Assistant is processing"
    >
      {/* Thread line - centered on chevron with equal spacing */}
      <div className="absolute left-7 top-0 bottom-0 w-px bg-canopy-border" />

      {/* Animated processing indicator */}
      <div className="flex items-center gap-3">
        <div className="relative w-4 h-4" aria-hidden="true">
          <div className="absolute inset-0 rounded-full border-2 border-canopy-text/10" />
          <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-canopy-accent animate-spin" />
        </div>
        <div className="flex gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-canopy-accent/60 animate-pulse [animation-delay:0ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-canopy-accent/60 animate-pulse [animation-delay:200ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-canopy-accent/60 animate-pulse [animation-delay:400ms]" />
        </div>
      </div>
    </div>
  );
}
