import { useState, useCallback } from "react";
import { cn } from "@/lib/utils";
import { useYouTubeEmbeds } from "@/hooks/useYouTubeEmbeds";

interface YouTubeEmbedOverlayProps {
  terminalId: string;
  cwd?: string;
  className?: string;
}

function YouTubeEmbedCard({ videoId, onDismiss }: { videoId: string; onDismiss: () => void }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [thumbnailError, setThumbnailError] = useState(false);

  const handleToggle = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  if (isExpanded) {
    return (
      <div className="relative rounded-[var(--radius-md)] overflow-hidden border border-canopy-border bg-canopy-sidebar shadow-[var(--theme-shadow-floating)]">
        <div className="flex items-center justify-between px-3 py-1.5 bg-canopy-bg border-b border-canopy-border">
          <button
            type="button"
            onClick={handleToggle}
            className="text-xs text-canopy-text/60 hover:text-canopy-text transition-colors"
          >
            Collapse
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="text-canopy-text/40 hover:text-canopy-text transition-colors"
            aria-label="Dismiss embed"
          >
            x
          </button>
        </div>
        <div className="aspect-video w-80">
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${videoId}`}
            sandbox="allow-scripts allow-same-origin allow-presentation"
            allow="autoplay; encrypted-media; picture-in-picture"
            referrerPolicy="no-referrer"
            loading="lazy"
            title="YouTube video"
            className="w-full h-full"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="relative group rounded-[var(--radius-md)] overflow-hidden border border-canopy-border bg-canopy-sidebar shadow-[var(--theme-shadow-floating)]">
      <button
        type="button"
        onClick={handleToggle}
        className="relative block w-48 aspect-video bg-black"
        aria-label="Expand YouTube video"
      >
        {!thumbnailError ? (
          <img
            src={`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`}
            alt=""
            className="w-full h-full object-cover"
            onError={() => setThumbnailError(true)}
          />
        ) : null}
        <div className="absolute inset-0 flex items-center justify-center bg-black/30">
          <div className="w-10 h-10 rounded-full bg-red-600 flex items-center justify-center">
            <svg viewBox="0 0 24 24" className="w-5 h-5 text-white fill-current">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </div>
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white/80 hover:text-white flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity"
        aria-label="Dismiss embed"
      >
        x
      </button>
    </div>
  );
}

export function YouTubeEmbedOverlay({ terminalId, cwd, className }: YouTubeEmbedOverlayProps) {
  const { embeds, dismissEmbed } = useYouTubeEmbeds(terminalId, cwd);

  if (embeds.length === 0) return null;

  return (
    <div
      className={cn("absolute bottom-4 left-4 z-10 flex flex-col gap-2", className)}
      role="region"
      aria-label="YouTube video embeds"
    >
      {embeds.map((embed) => (
        <YouTubeEmbedCard
          key={embed.videoId}
          videoId={embed.videoId}
          onDismiss={() => dismissEmbed(embed.videoId)}
        />
      ))}
    </div>
  );
}

export default YouTubeEmbedOverlay;
