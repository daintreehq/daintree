import { useState } from "react";
import { User } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface AvatarProps {
  src: string;
  alt: string;
  title?: string;
  className?: string;
  shape?: "circle" | "square";
}

type AvatarStatus = "loading" | "loaded" | "failed";

// Synchronous memory-cache probe. A fresh Image set to an already-cached URL
// (HTTP or blob) reports complete/naturalWidth immediately, so a cached avatar
// renders loaded on the first paint instead of flashing the placeholder.
function probeCache(url: string): boolean {
  const img = new Image();
  img.src = url;
  return img.complete && img.naturalWidth > 0;
}

// No URL is a settled answer, not a pending one: it goes straight to the
// fallback and never mounts an <img> (an empty src would resolve to the page).
function initialStatus(src: string): AvatarStatus {
  if (!src.trim()) return "failed";
  return probeCache(src) ? "loaded" : "loading";
}

/**
 * Forge avatars request 2× the rendered edge for HiDPI via `?s=`, replacing
 * any existing `s=` so the param never doubles up; providers that ignore it
 * serve the original.
 */
export function avatarUrlAtSize(url: string | undefined, px: number): string {
  if (!url?.trim()) return "";
  if (/[?&]s=\d+/.test(url)) return url.replace(/([?&])s=\d+/, `$1s=${px}`);
  return `${url}${url.includes("?") ? "&" : "?"}s=${px}`;
}

export function Avatar({ src, alt, title, className, shape = "circle" }: AvatarProps) {
  const [state, setState] = useState(() => ({ src, status: initialStatus(src) }));

  // Status belongs to one src. On a swap it is re-derived during render, so the
  // commit that shows the new src never carries the old one's failure or
  // placeholder — a cached picture swaps in with no flash.
  let current = state;
  if (state.src !== src) {
    current = { src, status: initialStatus(src) };
    setState(current);
  }
  const { status } = current;

  const settle = (next: AvatarStatus) =>
    setState((s) => (s.src === src ? { src, status: next } : s));

  // `rounded-xs` rather than the scale's `md`: at 12–16px an 8px corner is
  // a circle, and square exists to say "bot or app, not a person".
  const radius = shape === "square" ? "rounded-xs" : "rounded-full";
  const decorative = alt === "";

  const avatarContent = (
    <span
      className={cn("relative inline-block shrink-0", className)}
      aria-hidden={decorative ? true : undefined}
      role={!decorative && status === "failed" ? "img" : undefined}
      aria-label={!decorative && status === "failed" ? alt : undefined}
    >
      {status !== "loaded" && (
        <span
          data-avatar-fallback={status}
          data-skeleton-bone={status === "loading" ? "" : undefined}
          className={cn(
            "absolute inset-0 flex items-center justify-center",
            radius,
            // Loading is the shared skeleton bone; failed is the static
            // neutral chip CommitAuthorAvatar uses for a picture-less bot.
            // `medium`, not `soft`: soft all but vanishes on the dark panels.
            status === "loading"
              ? "bg-tint/[0.08] animate-pulse-delayed"
              : "bg-overlay-medium text-text-secondary"
          )}
        >
          {status === "failed" && (
            <User className="w-[70%] h-[70%]" strokeWidth={2.5} aria-hidden="true" />
          )}
        </span>
      )}
      {status !== "failed" && (
        <img
          key={src}
          src={src}
          alt={alt}
          onLoad={() => settle("loaded")}
          onError={() => settle("failed")}
          className={cn(
            "absolute inset-0 w-full h-full object-cover",
            radius,
            "transition-opacity duration-150 ease-out"
          )}
          style={{ opacity: status === "loaded" ? 1 : 0 }}
        />
      )}
    </span>
  );

  if (title) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{avatarContent}</TooltipTrigger>
        <TooltipContent side="bottom">{title}</TooltipContent>
      </Tooltip>
    );
  }

  return avatarContent;
}
