/**
 * Source: daintreehq/decisions, app/public/icons/mark.svg (the one-colour mark;
 * the question mark is a hole in the diamond, so it takes the surface behind it).
 */

import type { SVGProps } from "react";
import { cn } from "@/lib/utils";

type DecisionsIconProps = SVGProps<SVGSVGElement> & {
  size?: number;
};

export function DecisionsIcon({ className, size = 16, ...props }: DecisionsIconProps) {
  return (
    <svg
      width={size}
      height={size}
      // The artwork runs edge to edge in 0..512; padded so the diamond fills the
      // 20-unit live area of a 24-unit Lucide box and sits level with its neighbours.
      viewBox="-24 -24 560 560"
      className={cn(className)}
      aria-hidden="true"
      {...props}
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M222.059 23.059A48 48 0 0 1 289.941 23.059L488.941 222.059A48 48 0 0 1 488.941 289.941L289.941 488.941A48 48 0 0 1 222.059 488.941L23.059 289.941A48 48 0 0 1 23.059 222.059ZM282.2 304.4C282.2 300.8 282.3 298.7 283.3 293.7C287.4 274.5 308.3 268.5 323.5 255.8C340.4 241.7 350.8 224.2 350.2 198.6C350 190.4 347.6 178.2 342.8 168.7C319.9 123.5 259.2 112.7 214.3 130C181.2 142.8 158.9 172.4 160.7 208.3L220 208.3C220 204.5 220.3 201.6 221.4 198.4C224.1 190.6 228.3 184.1 235.7 179.5C253 168.8 282.2 174.2 284.5 197.8C286.9 221.7 264.2 230.3 249.9 239.8C229.9 253.2 219.7 270.4 219.4 295.5C219.4 298.5 219.4 301.5 219.4 304.4H282.2ZM290.4 361.7C289.9 340.3 271.9 323.3 250.7 323.6C228.3 324 211.3 342.4 211.9 363.7C212.5 384.8 230.7 402.3 252.9 401.4C273.9 400.6 290.9 382.4 290.4 361.7Z"
      />
    </svg>
  );
}

export default DecisionsIcon;
