import type { SVGProps } from "react";
import { cn } from "@/lib/utils";

type InterpreterIconProps = SVGProps<SVGSVGElement> & {
  size?: number;
  brandColor?: string;
};

export function InterpreterIcon({
  className,
  size = 16,
  brandColor,
  ...props
}: InterpreterIconProps) {
  // Open Interpreter mark: a dot above a rounded vertical capsule (terminal cursor).
  // Source: https://www.openinterpreter.com/icon.svg (32x32, rescaled to 24x24).
  const fill = brandColor || "currentColor";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cn(className)}
      aria-hidden="true"
      {...props}
    >
      <circle cx="12" cy="5.12175" r="2.12175" fill={fill} />
      <rect x="9.87825" y="9" width="4.24425" height="12" rx="2.12175" fill={fill} />
    </svg>
  );
}

export default InterpreterIcon;
