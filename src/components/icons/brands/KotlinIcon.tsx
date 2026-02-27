import { cn } from "@/lib/utils";

interface KotlinIconProps {
  className?: string;
  size?: number;
}

export function KotlinIcon({ className, size = 16 }: KotlinIconProps) {
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
      <path fill="currentColor" d="M24 24H0V0h24L12 12Z" />
    </svg>
  );
}

export default KotlinIcon;
