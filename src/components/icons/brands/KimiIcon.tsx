import type { SVGProps } from "react";
import { cn } from "@/lib/utils";

type KimiIconProps = SVGProps<SVGSVGElement> & {
  size?: number;
  brandColor?: string;
};

export function KimiIcon({ className, size = 16, brandColor, ...props }: KimiIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cn(className)}
      aria-hidden="true"
      {...props}
    >
      <path fill={brandColor || "currentColor"} d="M5 3h3v8l8-8h3l-9 9 9 9h-3l-8-8v8H5z" />
    </svg>
  );
}

export default KimiIcon;
