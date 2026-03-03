interface DockToBottomIconProps {
  className?: string;
}

export function DockToBottomIcon({ className }: DockToBottomIconProps) {
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
    >
      <path d="m7 4 5 5 5-5" />
      <path d="M3 16l3-2h12l3 2v5H3z" />
    </svg>
  );
}
