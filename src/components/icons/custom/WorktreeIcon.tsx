import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { className?: string };

export function WorktreeIcon({ className, ...props }: IconProps) {
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
      <circle cx="4.41" cy="18.59" r="2.41" />
      <line x1="4.41" y1="4.01" x2="4.41" y2="16.09" />
      <path d="M4.5,16.18c0-4.9,3.97-8.87,8.87-8.87" />
      <rect x="13.37" y="3" width="8.63" height="8.63" rx="1.98" ry="1.98" />
      <line x1="16.84" y1="6.19" x2="18.54" y2="6.19" />
    </svg>
  );
}
