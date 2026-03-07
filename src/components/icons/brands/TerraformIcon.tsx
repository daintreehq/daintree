import { cn } from "@/lib/utils";

interface TerraformIconProps {
  className?: string;
  size?: number;
}

export function TerraformIcon({ className, size = 16 }: TerraformIconProps) {
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
      <path fill="currentColor" d="M1.44 0v7.575l6.561 3.79V3.787z" />
      <path fill="currentColor" d="M21.12 4.227l-6.561 3.791v7.574l6.56-3.787z" />
      <path fill="currentColor" d="M8.72 4.23v7.575l6.561 3.787V8.018z" />
      <path fill="currentColor" d="M8.72 12.635v7.575L15.28 24v-7.578z" />
    </svg>
  );
}

export default TerraformIcon;
