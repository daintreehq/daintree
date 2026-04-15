import { cn } from "@/lib/utils";

export interface KbdProps {
  children: React.ReactNode;
  className?: string;
}

export function Kbd({ children, className }: KbdProps) {
  return (
    <kbd
      className={cn(
        "px-1.5 py-0.5 rounded text-xs font-mono",
        "bg-daintree-border text-daintree-text/70",
        "border border-daintree-border/60",
        className
      )}
    >
      {children}
    </kbd>
  );
}
