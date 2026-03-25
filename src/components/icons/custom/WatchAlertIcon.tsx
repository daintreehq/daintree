import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { className?: string };

export function WatchAlertIcon({ className, ...props }: IconProps) {
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
      <path d="M3.92,21.41l8.3-11.63c.63-.88,1.65-1.41,2.73-1.41h0c1.85,0,3.36,1.5,3.36,3.36v2c0,3.54-2.87,6.41-6.41,6.41h-7.07" />
      <line x1="17.93" y1="10.19" x2="19.5" y2="9.48" />
      <path d="M10.77,11.8l.96,2.56c1.05,2.8-1.02,5.78-4,5.78h-.55" />
      <line x1="13.04" y1="20.03" x2="13.04" y2="22" />
      <line x1="8.56" y1="20.03" x2="8.56" y2="22" />
      <path d="M13.08,5.81c.89-.89,2.33-.89,3.22,0" />
      <path d="M10.86,3.59c2.11-2.11,5.54-2.11,7.66,0" />
    </svg>
  );
}
