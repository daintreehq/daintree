import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

const SIZE_CLASSES = {
  xs: "w-3 h-3",
  sm: "w-3.5 h-3.5",
  md: "w-4 h-4",
  lg: "w-5 h-5",
  xl: "w-6 h-6",
  "2xl": "w-8 h-8",
} as const;

type SpinnerSize = keyof typeof SIZE_CLASSES;

interface SpinnerProps {
  size?: SpinnerSize;
  className?: string;
}

export function Spinner({ size = "md", className }: SpinnerProps) {
  return (
    <Loader2
      className={cn("animate-spin motion-reduce:animate-none", SIZE_CLASSES[size], className)}
      aria-hidden="true"
    />
  );
}
