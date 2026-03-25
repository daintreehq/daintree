import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { className?: string };

export function CopyTreeIcon({ className, ...props }: IconProps) {
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
      <path d="M17.23,2h2.48c1.26,0,2.29,1.03,2.29,2.29v2.44" />
      <path d="M6.77,2h-2.48c-1.26,0-2.29,1.03-2.29,2.29v2.44" />
      <path d="M17.23,22h2.48c1.26,0,2.29-1.03,2.29-2.29v-2.44" />
      <path d="M6.77,22h-2.48c-1.26,0-2.29-1.03-2.29-2.29v-2.44" />
      <line x1="10.57" y1="7.32" x2="18.13" y2="7.32" />
      <line x1="13.49" y1="11.8" x2="18.13" y2="11.8" />
      <line x1="13.49" y1="16.87" x2="18.13" y2="16.87" />
      <path d="M6.22,7.32v8.17c0,.77.62,1.39,1.39,1.39h2.01" />
      <line x1="9.62" y1="12" x2="6.22" y2="12" />
    </svg>
  );
}
