import { useState, useEffect } from "react";
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
    <div className="relative" role="img" aria-label={error ? alt : undefined}>
      {(!loaded || error) && (
        <div
          className={cn(
            "absolute inset-0 rounded-full bg-muted",
            !error && "animate-pulse",
            className
          )}
        />
      )}
      {!error && (
        <img
          src={src}
          alt={alt}
          title={title}
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
          className={cn(
            "rounded-full transition-opacity duration-200",
            loaded ? "opacity-100" : "opacity-0",
            className
          )}
        />
      )}
    </div>
  );
}
