import { cn } from "@/lib/utils";

interface StreamingCursorProps {
  className?: string;
}

export function StreamingCursor({ className }: StreamingCursorProps) {
  return (
    <span
      className={cn(
        "inline-block w-2 h-4 bg-canopy-accent/80 ml-0.5 align-middle animate-pulse",
        className
      )}
      aria-hidden="true"
    />
  );
}
