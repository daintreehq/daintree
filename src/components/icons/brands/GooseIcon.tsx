import { cn } from "@/lib/utils";

interface GooseIconProps {
  className?: string;
  size?: number;
  brandColor?: string;
}

export function GooseIcon({ className, size = 16, brandColor }: GooseIconProps) {
  // Stylized goose silhouette: head + curved neck + body, evoking the
  // "__( O)>" boot banner ASCII glyph upstream uses for Block's Goose CLI.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn(className)}
      aria-hidden="true"
    >
      <path
        fill={brandColor || "currentColor"}
        fillRule="evenodd"
        clipRule="evenodd"
        d="M14 3.5a3 3 0 0 0-3 3v.6a4.5 4.5 0 0 0-3.2 4.3v.5l-3.6 1.5a.8.8 0 0 0 .3 1.5h3.6a4.5 4.5 0 0 0 4.4 3.6h.7v2H7a.8.8 0 0 0 0 1.5h11a.8.8 0 0 0 0-1.5h-3.5v-2h.7a4.5 4.5 0 0 0 4.5-4.5V8a4.5 4.5 0 0 0-4-4.5V6.5a.8.8 0 0 1-1.5 0v-3a.5.5 0 0 0-.2 0Zm.7 5.7a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8Z"
      />
    </svg>
  );
}

export default GooseIcon;
