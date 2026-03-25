import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { className?: string };

export function AgentCompletedIcon({ className, ...props }: IconProps) {
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
      <line x1="3.26" y1="21.99" x2="18.69" y2="21.99" />
      <path d="M5.45,13.71c2.42,1.26,5.81-.44,5.81-.44,0,0-.54-3.76-2.96-5.02s-5.81.44-5.81.44c0,0,.54,3.76,2.96,5.02Z" />
      <path d="M11.41,21.99s2.75-2.98.56-6.95c-2.19-3.97,1.4-6.02,1.4-6.02l2.65,2.96,5.49-5.49" />
      <circle cx="11.26" cy="4.05" r="2.05" />
    </svg>
  );
}
