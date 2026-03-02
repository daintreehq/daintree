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
      <line x1="4" y1="20" x2="20" y2="20" />
      <path d="M11 16H7v-4" />
      <path d="M7 16L14 9" />
    </svg>
  );
}
