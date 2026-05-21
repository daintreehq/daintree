import { useState, useEffect, useRef } from "react";
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

// Synchronous memory-cache probe. A fresh Image set to an already-cached URL
// (HTTP or blob) reports complete/naturalWidth immediately, so this runs in a
// lazy useState initializer to render cached avatars loaded on the first paint
// instead of flashing the placeholder for one commit.
function probeCache(url: string): boolean {
  const img = new Image();
  img.src = url;
  return img.complete && img.naturalWidth > 0;
}

export function Avatar({ src, alt, title, className, shape = "circle" }: AvatarProps) {
  const [loaded, setLoaded] = useState(() => probeCache(src));
  const [error, setError] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  const radius = shape === "square" ? "rounded-md" : "rounded-full";

  // On src change the lazy initializer above does not re-run, so re-probe
  // here: cached → stay loaded (no placeholder flash on avatar swaps),
  // otherwise reset to false and let the img's onLoad drive the cold path.
  useEffect(() => {
    setError(false);
    setLoaded(probeCache(src));
  }, [src]);

  const avatarContent = (
    <div
      className={cn("relative", className)}
      role={error ? "img" : undefined}
      aria-label={error ? alt : undefined}
    >
      {(!loaded || error) && (
        <div
          className={cn(
            "absolute inset-0 flex items-center justify-center",
            radius,
            error
              ? "bg-muted-foreground/30 ring-2 ring-inset ring-muted-foreground/50"
              : "bg-muted-foreground/20 animate-pulse-delayed"
          )}
        >
          {error && (
            <User className="w-3 h-3 text-muted-foreground" strokeWidth={2} aria-hidden="true" />
          )}
        </div>
      )}
      {!error && (
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
          className={cn(radius, "transition-opacity duration-150 ease-out w-full h-full")}
          style={{ opacity: loaded ? 1 : 0 }}
        />
      )}
    </div>
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
