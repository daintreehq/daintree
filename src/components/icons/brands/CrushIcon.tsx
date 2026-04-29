import { cn } from "@/lib/utils";

interface CrushIconProps {
  className?: string;
  size?: number;
  brandColor?: string;
}

export function CrushIcon({ className, size = 16, brandColor }: CrushIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn(className)}
      aria-hidden="true"
    >
      <path
        d="M12 21.35S4 16.5 4 10.5A4.5 4.5 0 0 1 8.5 6c1.6 0 3.1.74 3.5 2 .4-1.26 1.9-2 3.5-2A4.5 4.5 0 0 1 20 10.5c0 6-8 10.85-8 10.85Z"
        fill={brandColor || "currentColor"}
      />
    </svg>
  );
}

export default CrushIcon;
