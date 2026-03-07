import { cn } from "@/lib/utils";

interface PnpmIconProps {
  className?: string;
  size?: number;
}

export function PnpmIcon({ className, size = 16 }: PnpmIconProps) {
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
        fill="currentColor"
        d="M0 0h7.2v7.2H0V0zm8.4 0h7.2v7.2H8.4V0zm8.4 0H24v7.2h-7.2V0zM8.4 8.4h7.2v7.2H8.4V8.4zm8.4 0H24v7.2h-7.2V8.4zM0 16.8h7.2V24H0v-7.2zm8.4 0h7.2V24H8.4v-7.2zm8.4 0H24V24h-7.2v-7.2z"
      />
    </svg>
  );
}

export default PnpmIcon;
