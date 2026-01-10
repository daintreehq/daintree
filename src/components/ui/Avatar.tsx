import { useState, useEffect } from "react";
import { User } from "lucide-react";
import { cn } from "@/lib/utils";

interface AvatarProps {
  src: string;
  alt: string;
  title?: string;
  className?: string;
}

export function Avatar({ src, alt, title, className }: AvatarProps) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    setLoaded(false);
    setError(false);
  }, [src]);

  return (
    <div
      className={cn("relative", className)}
      role={error ? "img" : undefined}
      aria-label={error ? alt : undefined}
    >
      {(!loaded || error) && (
        <div
          className={cn(
            "absolute inset-0 rounded-full flex items-center justify-center",
            error
              ? "bg-muted-foreground/30 ring-2 ring-inset ring-muted-foreground/50"
              : "bg-muted animate-pulse"
          )}
        >
          {error && (
            <User className="w-3 h-3 text-muted-foreground" strokeWidth={2} aria-hidden="true" />
          )}
        </div>
      )}
      {!error && (
        <img
          src={src}
          alt={alt}
          title={title}
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
          className="rounded-full transition-opacity duration-200 w-full h-full"
          style={{ opacity: loaded ? 1 : 0 }}
        />
      )}
    </div>
  );
}
