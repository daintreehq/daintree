/**
 * Bun Icon Component
 *
 * Custom SVG icon based on the official Bun JavaScript runtime brand icon.
 * Uses the distinctive Bun "bun/bread" shape, rendered monochrome via currentColor.
 *
 * Brand Color Reference: #FBF0DF (Bun Cream/Beige)
 * Source: https://bun.sh/press
 */

import { cn } from "@/lib/utils";

interface BunIconProps {
  className?: string;
  size?: number;
}

export function BunIcon({ className, size = 16 }: BunIconProps) {
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
        d="M12 22c5.421 0 10-3.674 10-8.5S17.421 5 12 5 2 8.674 2 13.5 6.579 22 12 22zM5.5 8.5c0-.828.56-1.5 1.25-1.5S8 7.672 8 8.5 7.44 10 6.75 10 5.5 9.328 5.5 8.5zm4.5-3c0-.828.56-1.5 1.25-1.5s1.25.672 1.25 1.5S12.19 7 11.5 7s-1.5-.672-1.5-1.5zm3 0c0-.828.56-1.5 1.25-1.5s1.25.672 1.25 1.5-.56 1.5-1.25 1.5-1.25-.672-1.25-1.5zm4.5 3c0-.828.56-1.5 1.25-1.5s1.25.672 1.25 1.5-.56 1.5-1.25 1.5S17.5 9.328 17.5 8.5zM8 14c-.552 0-1-.672-1-1.5S7.448 11 8 11s1 .672 1 1.5S8.552 14 8 14zm4 2c-1.105 0-2-.672-2-1.5s.895-1.5 2-1.5 2 .672 2 1.5-.895 1.5-2 1.5zm4-2c-.552 0-1-.672-1-1.5s.448-1.5 1-1.5 1 .672 1 1.5-.448 1.5-1 1.5z"
      />
    </svg>
  );
}

export default BunIcon;
