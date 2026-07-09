import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { GripVertical, ImageOff } from "lucide-react";
import type { DiffMediaFileVersions, DiffMediaSide, GitStatus } from "@shared/types";
import { diffMediaClient } from "@/clients/diffMediaClient";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/button";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { formatBytes } from "@/lib/formatBytes";
import { cn } from "@/lib/utils";

export interface ImageDiffViewerProps {
  /** Repo-relative path of the changed image */
  relPath: string;
  /** Worktree root (IPC cwd) */
  worktreePath: string;
  status: GitStatus;
}

const IMAGE_DIFF_EXTENSION_RE = /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i;

export function isImageDiffCandidate(path: string): boolean {
  return IMAGE_DIFF_EXTENSION_RE.test(path);
}

type ImageDiffMode = "two-up" | "swipe" | "onion";

const MODE_OPTIONS: Array<{ value: ImageDiffMode; label: string }> = [
  { value: "two-up", label: "Two-up" },
  { value: "swipe", label: "Swipe" },
  { value: "onion", label: "Onion skin" },
];

const SWIPE_KEYBOARD_STEP = 2;

// Neutral checkerboard so transparency reads correctly on both themes — the
// border token tracks theme polarity, and the low-alpha mix keeps it quiet.
const CHECKERBOARD_STYLE: CSSProperties = {
  backgroundImage:
    "repeating-conic-gradient(color-mix(in oklab, var(--color-daintree-border) 45%, transparent) 0% 25%, transparent 0% 50%)",
  backgroundSize: "16px 16px",
};

function sideErrorMessage(error: Extract<DiffMediaSide, { ok: false }>["error"]): string {
  switch (error) {
    case "TOO_LARGE":
      return "Image too large to compare (over 8 MB)";
    case "UNSUPPORTED":
      return "This file format can't be previewed as an image";
    case "NOT_FOUND":
      return "No version to show";
    case "ERROR":
      return "Couldn't load this version";
  }
}

function SideChip({ label, floating }: { label: string; floating?: boolean }) {
  return (
    <span
      className={cn(
        "rounded bg-daintree-sidebar px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground",
        floating && "bg-daintree-sidebar/90"
      )}
    >
      {label}
    </span>
  );
}

interface ImagePaneProps {
  label: string;
  side: DiffMediaSide;
  relPath: string;
  caption?: string;
}

function ImagePane({ label, side, relPath, caption }: ImagePaneProps) {
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null);
  const src = side.ok ? side.dataUrl : null;

  useEffect(() => {
    setDims(null);
  }, [src]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <SideChip label={label} />
        {caption ? <span className="text-xs text-muted-foreground">{caption}</span> : null}
      </div>
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-md border border-daintree-border"
        style={side.ok ? CHECKERBOARD_STYLE : undefined}
      >
        {side.ok ? (
          <img
            src={side.dataUrl}
            alt={`${label} version of ${relPath}`}
            draggable={false}
            className="max-h-full max-w-full object-contain"
            onLoad={(event) =>
              setDims({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
          />
        ) : (
          <p className="px-4 text-center text-xs text-muted-foreground">
            {sideErrorMessage(side.error)}
          </p>
        )}
      </div>
      {side.ok ? (
        <p className="text-[11px] tabular-nums text-muted-foreground">
          {dims ? `${dims.width}×${dims.height} px · ` : ""}
          {formatBytes(side.byteSize)}
        </p>
      ) : null}
    </div>
  );
}

interface OkSides {
  head: Extract<DiffMediaSide, { ok: true }>;
  working: Extract<DiffMediaSide, { ok: true }>;
}

// Both layers render into the same full-container box with object-contain, so
// they superimpose in an identical fitted rect and pixel comparison lines up.
function OverlayLayers({
  sides,
  relPath,
  topStyle,
}: {
  sides: OkSides;
  relPath: string;
  topStyle: CSSProperties;
}) {
  return (
    <>
      <img
        src={sides.working.dataUrl}
        alt={`Working tree version of ${relPath}`}
        draggable={false}
        className="absolute inset-0 h-full w-full object-contain"
      />
      <img
        src={sides.head.dataUrl}
        alt={`HEAD version of ${relPath}`}
        draggable={false}
        className="absolute inset-0 h-full w-full object-contain"
        style={topStyle}
      />
    </>
  );
}

function OverlayChips() {
  return (
    <>
      <div className="pointer-events-none absolute left-2 top-2 z-10">
        <SideChip label="HEAD" floating />
      </div>
      <div className="pointer-events-none absolute right-2 top-2 z-10">
        <SideChip label="Working tree" floating />
      </div>
    </>
  );
}

function SwipeCompare({ sides, relPath }: { sides: OkSides; relPath: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(50);
  const draggingRef = useRef(false);

  const updateFromClientX = useCallback((clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const next = ((clientX - rect.left) / rect.width) * 100;
    setPosition(Math.min(100, Math.max(0, next)));
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative min-h-0 flex-1 touch-none overflow-hidden rounded-md border border-daintree-border"
      style={CHECKERBOARD_STYLE}
      onPointerDown={(event) => {
        draggingRef.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        updateFromClientX(event.clientX);
      }}
      onPointerMove={(event) => {
        if (draggingRef.current) updateFromClientX(event.clientX);
      }}
      onPointerUp={() => {
        draggingRef.current = false;
      }}
      onPointerCancel={() => {
        draggingRef.current = false;
      }}
    >
      <OverlayLayers
        sides={sides}
        relPath={relPath}
        // HEAD on top, clipped to the left of the divider — old on the left,
        // new on the right.
        topStyle={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
      />
      <OverlayChips />
      <div
        role="slider"
        tabIndex={0}
        aria-label="Swipe divider"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(position)}
        className="absolute inset-y-0 z-10 flex w-4 -translate-x-1/2 cursor-ew-resize items-center justify-center"
        style={{ left: `${position}%` }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const delta = event.key === "ArrowLeft" ? -SWIPE_KEYBOARD_STEP : SWIPE_KEYBOARD_STEP;
          setPosition((prev) => Math.min(100, Math.max(0, prev + delta)));
        }}
      >
        <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-daintree-text/60 shadow-[0_0_0_1px_var(--color-daintree-bg)]" />
        <div className="relative flex h-6 w-3.5 items-center justify-center rounded border border-daintree-border bg-daintree-sidebar">
          <GripVertical className="h-3 w-3 text-muted-foreground" />
        </div>
      </div>
    </div>
  );
}

function OnionCompare({
  sides,
  relPath,
  opacity,
}: {
  sides: OkSides;
  relPath: string;
  opacity: number;
}) {
  return (
    <div
      className="relative min-h-0 flex-1 overflow-hidden rounded-md border border-daintree-border"
      style={CHECKERBOARD_STYLE}
    >
      {/* HEAD as the base layer; the working-tree layer fades in on top. */}
      <img
        src={sides.head.dataUrl}
        alt={`HEAD version of ${relPath}`}
        draggable={false}
        className="absolute inset-0 h-full w-full object-contain"
      />
      <img
        src={sides.working.dataUrl}
        alt={`Working tree version of ${relPath}`}
        draggable={false}
        className="absolute inset-0 h-full w-full object-contain"
        style={{ opacity: opacity / 100 }}
      />
      <OverlayChips />
    </div>
  );
}

export function ImageDiffViewer({ relPath, worktreePath, status }: ImageDiffViewerProps) {
  const [versions, setVersions] = useState<DiffMediaFileVersions | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "error">("loading");
  const [fetchNonce, setFetchNonce] = useState(0);
  const [mode, setMode] = useState<ImageDiffMode>("two-up");
  const [onionOpacity, setOnionOpacity] = useState(50);

  useEffect(() => {
    let cancelled = false;
    setLoadState("loading");
    setVersions(null);
    diffMediaClient
      .readFileVersions({ cwd: worktreePath, filePath: relPath })
      .then((result) => {
        if (cancelled) return;
        setVersions(result);
        setLoadState("loaded");
      })
      .catch(() => {
        if (!cancelled) setLoadState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [worktreePath, relPath, fetchNonce]);

  const retry = useCallback(() => setFetchNonce((nonce) => nonce + 1), []);

  const singleSide: "head" | "working" | null =
    status === "added" || status === "untracked" ? "working" : status === "deleted" ? "head" : null;

  if (loadState === "loading") {
    return (
      <Skeleton
        label="Loading image versions"
        className="flex h-full min-h-0 w-full flex-col gap-3 p-3"
      >
        <SkeletonBone className="h-6 w-44" />
        <div className="flex min-h-0 flex-1 gap-3">
          <SkeletonBone className="min-h-0 flex-1 rounded-md" />
          {singleSide === null ? <SkeletonBone className="min-h-0 flex-1 rounded-md" /> : null}
        </div>
      </Skeleton>
    );
  }

  if (loadState === "error" || (versions !== null && !versions.head.ok && !versions.working.ok)) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col items-center justify-center">
        <EmptyState
          variant="zero-data"
          scale="canvas"
          icon={<ImageOff />}
          title="Couldn't load image versions"
          description="Neither version of this image could be read"
          action={
            <Button variant="outline" size="sm" onClick={retry}>
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  if (versions === null) return null;

  if (singleSide !== null) {
    const caption =
      singleSide === "working" ? "Added — no previous version" : "Deleted — no working version";
    return (
      <div className="flex h-full min-h-0 w-full flex-col p-3">
        <ImagePane
          label={singleSide === "working" ? "Working tree" : "HEAD"}
          side={versions[singleSide]}
          relPath={relPath}
          caption={caption}
        />
      </div>
    );
  }

  const okSides: OkSides | null =
    versions.head.ok && versions.working.ok
      ? { head: versions.head, working: versions.working }
      : null;
  const bothOk = okSides !== null;
  const effectiveMode: ImageDiffMode = bothOk ? mode : "two-up";

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {bothOk ? (
        <div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-3">
          <SegmentedToggle options={MODE_OPTIONS} value={effectiveMode} onChange={setMode} />
          {effectiveMode === "onion" ? (
            <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
              Working tree opacity
              <input
                type="range"
                min={0}
                max={100}
                value={onionOpacity}
                aria-label="Working tree opacity"
                onChange={(event) => setOnionOpacity(Number(event.currentTarget.value))}
                className="w-36 cursor-pointer"
                style={{ accentColor: "var(--color-daintree-text)" }}
              />
            </label>
          ) : null}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col p-3">
        {effectiveMode === "two-up" || okSides === null ? (
          <div className="flex min-h-0 flex-1 gap-3">
            <ImagePane label="HEAD" side={versions.head} relPath={relPath} />
            <ImagePane label="Working tree" side={versions.working} relPath={relPath} />
          </div>
        ) : effectiveMode === "swipe" ? (
          <SwipeCompare sides={okSides} relPath={relPath} />
        ) : (
          <OnionCompare sides={okSides} relPath={relPath} opacity={onionOpacity} />
        )}
      </div>
    </div>
  );
}
