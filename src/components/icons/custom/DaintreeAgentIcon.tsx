import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { className?: string };

export function DaintreeAgentIcon({ className, ...props }: IconProps) {
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
      <line x1="4.28" y1="22.01" x2="19.72" y2="22.01" />
      <path d="M20.03,7.73c-1.92,1.92-5.63,1.31-5.63,1.31,0,0-.61-3.72,1.31-5.63s5.63-1.31,5.63-1.31c0,0,.61,3.72-1.31,5.63Z" />
      <path d="M6.48,13.72c2.42,1.26,5.81-.44,5.81-.44,0,0-.54-3.76-2.96-5.02s-5.81.44-5.81.44c0,0,.54,3.76,2.96,5.02Z" />
      <path d="M14.4,9.04s-3.59,2.04-1.4,6.02-.56,6.95-.56,6.95" />
      <circle cx="9.85" cy="3.54" r="1" />
    </svg>
  );
}
