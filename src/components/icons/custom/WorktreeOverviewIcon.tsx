import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { className?: string };

export function WorktreeOverviewIcon({ className, ...props }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <line x1="5.73" y1="2" x2="5.73" y2="11.92" />
      <path d="M5.8,12c0-4.16,3.37-7.53,7.53-7.53" />
      <rect x="13.33" y="2" width="4.94" height="4.94" rx="1.22" ry="1.22" />
      <path d="M5.8,12c0,4.16,3.37,7.53,7.53,7.53" />
      <rect x="13.33" y="17.06" width="4.94" height="4.94" rx="1.22" ry="1.22" />
    </svg>
  );
}
