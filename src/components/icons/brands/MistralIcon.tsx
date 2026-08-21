/**
 * Source: https://docs.mistral.ai/img/logo.svg (M-cube portion only)
 */

import type { SVGProps } from "react";
import { cn } from "@/lib/utils";

type MistralIconProps = SVGProps<SVGSVGElement> & {
  size?: number;
  brandColor?: string;
};

export function MistralIcon({ className, size = 16, brandColor, ...props }: MistralIconProps) {
  const fill = brandColor || "currentColor";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 -30.5 213 213"
      className={cn(className)}
      aria-hidden="true"
      {...props}
    >
      <path fill={fill} d="M30.303 0h30.303v30.303H30.303zm121.212 0h30.303v30.303h-30.303z" />
      <path fill={fill} d="M30.303 30.303h60.606v30.303H30.303zm90.909 0h60.606v30.303h-60.606z" />
      <path fill={fill} d="M30.303 60.606h151.515v30.303H30.303z" />
      <path
        fill={fill}
        d="M30.303 90.909h30.303v30.303H30.303zm60.606 0h30.303v30.303H90.909zm60.606 0h30.303v30.303h-30.303z"
      />
      <path fill={fill} d="M0 121.212h90.909v30.303H0zm121.212 0h90.909v30.303h-90.909z" />
    </svg>
  );
}

export default MistralIcon;
