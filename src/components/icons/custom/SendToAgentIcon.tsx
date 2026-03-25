import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { className?: string };

export function SendToAgentIcon({ className, ...props }: IconProps) {
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
      <line x1="2" y1="10.96" x2="5.53" y2="10.96" />
      <line x1="2" y1="14.63" x2="5.53" y2="14.63" />
      <polyline points="9.56 9.99 13.59 12.79 9.56 15.6" />
      <line x1="21.28" y1="16.69" x2="14.7" y2="16.69" />
      <path d="M21.13,10.72c-1.16,1.12-3.36.73-3.36.73,0,0-.33-2.22.83-3.34s3.36-.73,3.36-.73c0,0,.33,2.22-.83,3.34Z" />
      <path d="M17.69,10.9c-.04.39-.18.83-.44,1.31-1.41,2.56.36,4.48.36,4.48" />
    </svg>
  );
}
