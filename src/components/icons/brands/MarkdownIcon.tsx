/**
 * Source: https://github.com/dcurtis/markdown-mark (svg/markdown-mark.svg)
 * License: CC0 1.0 — dedicated to the public domain.
 *
 * The outlined mark, not the solid one: at tile sizes the solid box reads as a
 * grey slab beside the line icons it sits with. The official file is two
 * paths — the enclosure ring and the M↓ glyphs — concatenated into one so the
 * three elements can only ever share an ink, which is the mark's own usage
 * rule. The glyphs' leading moveto is made absolute, since it no longer opens
 * a path; geometry is otherwise untouched.
 *
 * The native 208x128 box is padded to a square, which centres the mark for
 * consumers that constrain both axes.
 */

import type { SVGProps } from "react";
import { cn } from "@/lib/utils";

type MarkdownIconProps = SVGProps<SVGSVGElement> & {
  size?: number;
};

export function MarkdownIcon({ className, size = 16, ...props }: MarkdownIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 -40 208 208"
      className={cn(className)}
      aria-hidden="true"
      {...props}
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="m15 10c-2.7614 0-5 2.2386-5 5v98c0 2.761 2.2386 5 5 5h178c2.761 0 5-2.239 5-5v-98c0-2.7614-2.239-5-5-5zm-15 5c0-8.28427 6.71573-15 15-15h178c8.284 0 15 6.71573 15 15v98c0 8.284-6.716 15-15 15h-178c-8.28427 0-15-6.716-15-15zM30 98v-68h20l20 25 20-25h20v68h-20v-39l-20 25-20-25v39zm125 0-30-33h20v-35h20v35h20z"
      />
    </svg>
  );
}

export default MarkdownIcon;
