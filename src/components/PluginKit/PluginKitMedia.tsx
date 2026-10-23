import { useEffect, useRef, useState } from "react";
import { FileAudio, File as FileGlyph } from "lucide-react";
import type {
  PluginMediaPlayerProps,
  PluginMediaSource,
  PluginMediaThumbnailProps,
} from "@shared/types/plugin-sdk-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils";
import { getPluginKitHost } from "./kitHost";
import { nonEmpty, oneOf, pickRootProps, str } from "./kitProps";
import { usePluginKitOwner } from "./kitScope";

// Media: artifacts from the host's cache (#14100), played through a
// lease-bearing URL the host mints for this view. Bytes never pass through the
// plugin; the element streams by byte range from the host's protocol handler.

type SourceState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; url: string; mimeType: string }
  | { status: "error"; message: string; code: string | null };

function sourceId(source: PluginMediaSource | null | undefined): string | null {
  if (typeof source === "string") return nonEmpty(source) ?? null;
  return source && typeof source === "object" ? (nonEmpty(source.id) ?? null) : null;
}

function errorParts(error: unknown): { message: string; code: string | null } {
  const raw = error instanceof Error ? error.message : String(error);
  const code = /^([A-Z][A-Z_]+):\s*/.exec(raw)?.[1] ?? null;
  const message = code ? raw.slice(code.length + 1).trim() : raw;
  return { message: message || "The file couldn't be loaded", code };
}

/**
 * The view's leased source for an artifact: minted when the id is known,
 * released when it changes or the component goes, minted again on `retry`.
 */
function useArtifactSource(source: PluginMediaSource | null | undefined): {
  state: SourceState;
  retry: () => void;
} {
  const owner = usePluginKitOwner();
  const id = sourceId(source);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<SourceState>({ status: "idle" });
  useEffect(() => {
    if (!id) {
      setState({ status: "idle" });
      return;
    }
    if (!owner) {
      setState({ status: "error", message: "Media plays only in a plugin view", code: null });
      return;
    }
    let live = true;
    let minted: string | null = null;
    const host = getPluginKitHost();
    setState({ status: "loading" });
    host.artifactSource(owner, id).then(
      (resolved) => {
        if (!live) {
          host.releaseArtifactSource(resolved.url);
          return;
        }
        minted = resolved.url;
        setState({ status: "ready", url: resolved.url, mimeType: resolved.mimeType });
      },
      (error: unknown) => {
        if (live) setState({ status: "error", ...errorParts(error) });
      }
    );
    return () => {
      live = false;
      if (minted) host.releaseArtifactSource(minted);
    };
  }, [owner, id, attempt]);
  return { state, retry: () => setAttempt((n) => n + 1) };
}

/**
 * Stop any outstanding range request when the element lets go of a source:
 * removing `src` alone leaves the loader running until it next reads.
 */
function useReleaseOnSourceChange(
  ref: { current: HTMLMediaElement | null },
  url: string | null
): void {
  useEffect(() => {
    const element = ref.current;
    return () => {
      if (!element || !url) return;
      element.pause();
      element.removeAttribute("src");
      element.load();
    };
  }, [ref, url]);
}

const MEDIA_ERROR_TEXT: Record<number, string> = {
  1: "Playback was stopped",
  2: "The file stopped loading",
  3: "The file couldn't be decoded",
  4: "This format can't be played here",
};

function KitMediaPlayer(props: PluginMediaPlayerProps) {
  const { source, poster, loop, muted, whenAway, onError, className } = props;
  const { state, retry } = useArtifactSource(source);
  const posterState = useArtifactSource(poster ?? null).state;
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);
  const reportError = typeof onError === "function" ? onError : undefined;
  const url = state.status === "ready" ? state.url : null;
  useReleaseOnSourceChange(mediaRef, url);

  // Pausing when the person moves away is the policy, not an option a plugin
  // has to remember: no resume on return, so nothing starts without them.
  const keepPlaying = oneOf(whenAway, ["pause", "keep-playing"] as const) === "keep-playing";
  useEffect(() => {
    if (keepPlaying || !url) return;
    return getPluginKitHost().watchPlaybackHold((held) => {
      if (held) mediaRef.current?.pause();
    });
  }, [keepPlaying, url]);

  useEffect(() => {
    if (state.status === "error") reportError?.(new Error(state.message));
  }, [state, reportError]);

  const declaredType = typeof source === "object" && source ? str(source.mimeType) : undefined;
  const mimeType = state.status === "ready" ? state.mimeType : (declaredType ?? "");
  const audio = mimeType.startsWith("audio/");
  const name =
    nonEmpty(props["aria-label"]) ??
    (typeof source === "object" && source ? nonEmpty(source.name) : undefined) ??
    (audio ? "Audio" : "Video");
  const rootProps = pickRootProps(props);

  if (state.status === "error" || playError !== null) {
    const message = playError ?? (state.status === "error" ? state.message : "");
    return (
      <Callout
        {...rootProps}
        severity="error"
        size="compact"
        title={audio ? "Couldn't play this audio" : "Couldn't play this video"}
        action={
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setPlayError(null);
              retry();
            }}
          >
            Retry
          </Button>
        }
        className={str(className)}
      >
        {message}
      </Callout>
    );
  }

  if (!url) {
    return (
      <Skeleton {...rootProps} label={`Loading ${name}`} className={cn("w-full", str(className))}>
        <SkeletonBone
          className={cn("w-full rounded-[var(--radius-md)]", audio ? "h-10" : "aspect-video")}
        />
      </Skeleton>
    );
  }

  const shared = {
    src: url,
    controls: true,
    preload: "metadata" as const,
    loop: loop === true,
    muted: muted === true,
    "aria-label": name,
    onError: (event: { currentTarget: HTMLMediaElement }) => {
      const code = event.currentTarget.error?.code ?? 0;
      const message = MEDIA_ERROR_TEXT[code] ?? "The file couldn't be played";
      setPlayError(message);
      reportError?.(new Error(message));
    },
  };
  return (
    <div {...rootProps} className={cn("w-full", str(className))}>
      {audio ? (
        <audio
          {...shared}
          ref={(el) => {
            mediaRef.current = el;
          }}
          className="w-full"
        />
      ) : (
        <video
          {...shared}
          ref={(el) => {
            mediaRef.current = el;
          }}
          playsInline
          poster={posterState.status === "ready" ? posterState.url : undefined}
          className="w-full rounded-[var(--radius-md)] bg-overlay-subtle"
        />
      )}
    </div>
  );
}

const THUMBNAIL_SIZE = { sm: "h-10 w-10", md: "h-16 w-16", lg: "h-24 w-24" } as const;

function KitMediaThumbnail(props: PluginMediaThumbnailProps) {
  const { source, className } = props;
  const declaredType = typeof source === "object" && source ? str(source.mimeType) : undefined;
  // A declared type with no playable source (a PDF, an archive) shows its
  // glyph without asking the host for a source it would refuse.
  const playable = declaredType === undefined || /^(audio|video|image)\//.test(declaredType);
  const { state } = useArtifactSource(playable ? source : null);
  const ref = useRef<HTMLMediaElement | null>(null);
  const url = state.status === "ready" ? state.url : null;
  useReleaseOnSourceChange(ref, url);
  const mimeType = state.status === "ready" ? state.mimeType : (declaredType ?? "");
  const alt = nonEmpty(props.alt);
  const size = THUMBNAIL_SIZE[oneOf(props.size, ["sm", "md", "lg"] as const) ?? "md"];

  let body;
  if (url && mimeType.startsWith("image/")) {
    body = <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" />;
  } else if (url && mimeType.startsWith("video/")) {
    // The first frame: metadata only, never playing, out of the tab order.
    body = (
      <video
        ref={(el) => {
          ref.current = el;
        }}
        src={`${url}#t=0.1`}
        preload="metadata"
        muted
        playsInline
        tabIndex={-1}
        aria-hidden="true"
        className="h-full w-full object-cover"
      />
    );
  } else if (state.status === "loading") {
    body = <SkeletonBone className="h-full w-full rounded-none" />;
  } else {
    const Glyph = mimeType.startsWith("audio/") ? FileAudio : FileGlyph;
    body = <Glyph className="h-1/3 w-1/3" aria-hidden="true" />;
  }

  return (
    <span
      {...pickRootProps(props)}
      role={alt ? "img" : undefined}
      aria-label={alt}
      aria-hidden={alt ? undefined : true}
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-sm)] bg-overlay-subtle text-text-secondary",
        size,
        str(className)
      )}
    >
      {body}
    </span>
  );
}

export const pluginKitMedia = {
  MediaPlayer: KitMediaPlayer,
  MediaThumbnail: KitMediaThumbnail,
};
