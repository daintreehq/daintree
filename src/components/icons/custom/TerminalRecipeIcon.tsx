import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { className?: string };

export function TerminalRecipeIcon({ className, ...props }: IconProps) {
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
      <path d="M2,12v-7.71c0-1.26,1.03-2.29,2.29-2.29h15.42c1.26,0,2.29,1.03,2.29,2.29v15.42c0,1.26-1.03,2.29-2.29,2.29h-4.57" />
      <polyline points="6.86 5.73 9.1 7.96 6.86 10.2" />
      <line x1="12.82" y1="10.44" x2="17.46" y2="10.44" />
      <path d="M6.16,14.4h3.61c.77,0,1.4.63,1.4,1.4v4.19" />
      <polyline points="12.82 18.35 11.17 20 9.52 18.35" />
      <path d="M8.67,22h-3.61c-.77,0-1.4-.63-1.4-1.4v-4.19" />
      <polyline points="2 18.06 3.65 16.41 5.3 18.06" />
    </svg>
  );
}
