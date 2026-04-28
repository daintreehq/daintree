import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { className?: string };

/**
 * Official MCP (Model Context Protocol) icon adapted from modelcontextprotocol.io/favicon.svg.
 * Three interlocking diagonal strokes representing connectivity.
 */
export function McpServerIcon({ className, ...props }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <path d="M2.4 11.31L11.45 2.26C12.7 1.01 14.73 1.01 15.98 2.26C17.23 3.51 17.23 5.54 15.98 6.79L9.14 13.62" />
      <path d="M9.24 13.53L15.98 6.79C17.23 5.54 19.25 5.54 20.5 6.79L20.55 6.84C21.8 8.09 21.8 10.11 20.55 11.36L12.36 19.55C11.95 19.96 11.95 20.64 12.36 21.06L14.04 22.74" />
      <path d="M13.71 4.53L7.02 11.22C5.77 12.47 5.77 14.5 7.02 15.74C8.27 16.99 10.3 16.99 11.55 15.74L18.24 9.05" />
    </svg>
  );
}
