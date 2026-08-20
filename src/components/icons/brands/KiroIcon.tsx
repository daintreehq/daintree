import type { SVGProps } from "react";
import { cn } from "@/lib/utils";

type KiroIconProps = SVGProps<SVGSVGElement> & {
  size?: number;
};

export function KiroIcon({ className, size = 16, ...props }: KiroIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1200 1200"
      className={cn(className)}
      aria-hidden="true"
      {...props}
    >
      {/*
        Mascot silhouette only. The tile and the knocked-out pupils this mark
        used to draw itself are now the badge's job (#11895), and a single-token
        glyph is what lets it inherit the badge ink like every other agent.
      */}
      <mask
        id="kiro-mask"
        style={{ maskType: "luminance" }}
        maskUnits="userSpaceOnUse"
        x="272"
        y="202"
        width="655"
        height="796"
      >
        <path d="M926.578 202.793H272.637V997.857H926.578V202.793Z" fill="white" />
      </mask>
      <g mask="url(#kiro-mask)">
        <path
          d="M398.554 818.914C316.315 1001.03 491.477 1046.74 620.672 940.156C658.687 1059.66 801.052 970.473 852.234 877.795C964.787 673.567 919.318 465.357 907.64 422.374C827.637 129.443 427.623 128.946 358.8 423.865C342.651 475.544 342.402 534.18 333.458 595.051C328.986 625.86 325.507 645.488 313.83 677.785C306.873 696.424 297.68 712.819 282.773 740.645C259.915 783.881 269.604 867.113 387.87 823.883L399.051 818.914H398.554Z"
          fill="currentColor"
        />
      </g>
    </svg>
  );
}

export default KiroIcon;
