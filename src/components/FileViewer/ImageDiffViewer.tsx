import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { GripVertical, ImageOff } from "lucide-react";
import type { DiffMediaFileVersions, DiffMediaSide, GitStatus } from "@shared/types";
import { getDiffMediaImageMime } from "@shared/types/ipc/diffMedia";
import { diffMediaClient } from "@/clients/diffMediaClient";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/button";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { formatBytes } from "@/lib/formatBytes";
import { cn } from "@/lib/utils";
import { TRANSPARENCY_CHECKERBOARD_STYLE } from "./transparencyCheckerboard";

export interface ImageDiffViewerProps {
  /** Repo-relative path of the changed image */
  relPath: string;
  /** Worktree root (IPC cwd) */
  worktreePath: string;
  status: GitStatus;
}

export function isImageDiffCandidate(path: string): boolean {
  return getDiffMediaImageMime(path) !== null;
}

type ImageDiffMode = "two-up" | "swipe" | "onion";

const MODE_OPTIONS: Array<{ value: ImageDiffMode; label: string }> = [
  { value: "two-up", label: "Two-up" },
  { value: "swipe", label: "Swipe" },
  { value: "onion", label: "Onion skin" },
];

const SWIPE_KEYBOARD_STEP = 2;

const CHECKERBOARD_STYLE: CSSProperties = TRANSPARENCY_CHECKERBOARD_STYLE;

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
        "rounded bg-surface-sidebar px-1.5 py-0.5 text-3xs font-medium text-muted-foreground",
        floating && "bg-daintree-sidebar/90"
      )}
    >
      {label}
    </span>
  );
}

type ImageDiffStatusSide = "head" | "working";

interface CommittedSnapshot {
  /** Identity of the fetch's *target* (worktree+path+status+nonce) — see makeRequestKey. */
  requestKey: string;
  /**
   * Monotonic id of the fetch attempt that produced this snapshot. Unlike
   * requestKey (deterministic per target, so it repeats when you navigate back
   * to a file), attempt is unique per fetch — keying each ImagePane by it forces
   * a remount on every commit, even when the same file recommits, so stale
   * per-side decode/dimension state can't survive a return visit.
   */
  attempt: number;
  versions: DiffMediaFileVersions;
  relPath: string;
  status: GitStatus;
  /**
   * Sides whose off-screen decode rejected, seeded into the matching ImagePane
   * so a genuinely broken image shows its per-side fallback instead of a torn
   * frame — and so the swap is never blocked by one bad side.
   */
  decodeFailures: { head: boolean; working: boolean };
}

function deriveSingleSide(status: GitStatus): ImageDiffStatusSide | null {
  return status === "added" || status === "untracked"
    ? "working"
    : status === "deleted"
      ? "head"
      : null;
}

/** Sides a given status can actually render, so we never decode a hidden one. */
function renderableSides(status: GitStatus): ImageDiffStatusSide[] {
  const single = deriveSingleSide(status);
  return single === null ? ["head", "working"] : [single];
}

function makeRequestKey(
  worktreePath: string,
  relPath: string,
  status: GitStatus,
  nonce: number
): string {
  return JSON.stringify([worktreePath, relPath, status, nonce]);
}

/**
 * Decode a data URL on an off-screen element so the browser's URL-keyed
 * decoded-image cache is warm before the on-screen <img> mounts with the same
 * src — that's what lets the swap paint without a blank/torn frame (the
 * hold-then-swap pattern GitHub's PR viewer and VS Code's image preview use).
 * Resolves to whether the decode succeeded; a genuinely broken image resolves
 * `false` rather than throwing, so one bad side never blocks the whole swap.
 * `decode()` is absent under jsdom (and older engines), so guard for it.
 */
async function decodeOffscreen(dataUrl: string): Promise<boolean> {
  const img = new Image();
  img.src = dataUrl;
  if (typeof img.decode !== "function") return true;
  try {
    await img.decode();
    return true;
  } catch {
    return false;
  }
}

interface ImagePaneProps {
  label: string;
  side: DiffMediaSide;
  relPath: string;
  caption?: string;
  /**
   * Seeded from the off-screen predecode so a side that failed to decode shows
   * the fallback on first paint. Each pane is keyed by the committed request +
   * side at the call site, so a new commit remounts it with fresh state — no
   * reset effect needed (the old [src] effect couldn't recover a same-URL
   * retry, since the src never changed).
   */
  initialDecodeFailed?: boolean;
  /** Offered only for transient read failures, not genuinely absent versions */
  onRetry?: () => void;
}

function ImagePane({
  label,
  side,
  relPath,
  caption,
  initialDecodeFailed,
  onRetry,
}: ImagePaneProps) {
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null);
  const [decodeFailed, setDecodeFailed] = useState(initialDecodeFailed ?? false);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <SideChip label={label} />
        {caption ? <span className="text-xs text-muted-foreground">{caption}</span> : null}
      </div>
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-md border border-border-default"
        style={side.ok && !decodeFailed ? CHECKERBOARD_STYLE : undefined}
      >
        {side.ok && !decodeFailed ? (
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
            onError={() => setDecodeFailed(true)}
          />
        ) : (
          <div className="flex flex-col items-center gap-2 px-4">
            <p className="text-center text-xs text-muted-foreground">
              {side.ok ? "Couldn't display this version" : sideErrorMessage(side.error)}
            </p>
            {!side.ok && side.error === "ERROR" && onRetry ? (
              <Button variant="outline" size="sm" onClick={onRetry}>
                Retry
              </Button>
            ) : null}
          </div>
        )}
      </div>
      {side.ok && !decodeFailed ? (
        <p className="text-2xs tabular-nums text-muted-foreground">
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
      className="relative min-h-0 flex-1 touch-none overflow-hidden rounded-md border border-border-default"
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
        <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-daintree-text/60 shadow-[0_0_0_1px_var(--color-surface-canvas)]" />
        <div className="relative flex h-6 w-3.5 items-center justify-center rounded border border-border-default bg-surface-sidebar">
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
      className="relative min-h-0 flex-1 overflow-hidden rounded-md border border-border-default"
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
  // The last snapshot fully fetched AND off-screen-decoded. It stays painted
  // while the next file loads, so stepping between images never tears down to a
  // skeleton — the previous frame holds until the new one is ready to paint.
  const [committed, setCommitted] = useState<CommittedSnapshot | null>(null);
  // The request key whose read failed. A key, not a boolean: effects run after
  // render, so a boolean would paint the *previous* file's error for one commit
  // on switch. Only a failure keyed to the live target counts.
  const [failedRequestKey, setFailedRequestKey] = useState<string | null>(null);
  const [fetchNonce, setFetchNonce] = useState(0);
  const [mode, setMode] = useState<ImageDiffMode>("two-up");
  const [onionOpacity, setOnionOpacity] = useState(50);
  // Bumped once per fetch; stamped into each snapshot so ImagePane keys are
  // unique per attempt (see CommittedSnapshot.attempt).
  const attemptRef = useRef(0);

  const requestKey = makeRequestKey(worktreePath, relPath, status, fetchNonce);

  // Drop a stale failure the moment the target changes, during render, so
  // returning to a file that previously failed shows a hold/skeleton and the
  // fresh fetch's outcome — not the old error. requestKey repeats per target,
  // so without this a returned-to failure would out-rank a later success that
  // never clears it. (React's "adjust state while rendering" pattern.)
  const [failureTargetKey, setFailureTargetKey] = useState(requestKey);
  if (failureTargetKey !== requestKey) {
    setFailureTargetKey(requestKey);
    setFailedRequestKey(null);
  }

  useEffect(() => {
    let cancelled = false;
    const attempt = (attemptRef.current += 1);
    diffMediaClient
      .readFileVersions({ cwd: worktreePath, filePath: relPath })
      .then(async (result) => {
        if (cancelled) return;
        // A comparison whose two transport reads both failed has nothing to
        // render — surface the aggregate error for this target rather than
        // committing (and then holding) an empty frame.
        if (deriveSingleSide(status) === null && !result.head.ok && !result.working.ok) {
          setFailedRequestKey(requestKey);
          return;
        }
        // Warm the decode cache for only the sides this status will show, so
        // the on-screen swap paints instantly. A side that fails to decode is
        // recorded, not fatal — it falls back to the per-side message in
        // two-up rather than blocking the whole swap.
        const decoded = await Promise.all(
          renderableSides(status).map(async (sideKey) => {
            const sideValue = result[sideKey];
            const ok = sideValue.ok ? await decodeOffscreen(sideValue.dataUrl) : true;
            return [sideKey, ok] as const;
          })
        );
        if (cancelled) return;
        const decodeFailures = { head: false, working: false };
        for (const [sideKey, ok] of decoded) {
          if (!ok) decodeFailures[sideKey] = true;
        }
        setCommitted({ requestKey, attempt, versions: result, relPath, status, decodeFailures });
      })
      .catch(() => {
        if (!cancelled) setFailedRequestKey(requestKey);
      });
    return () => {
      cancelled = true;
    };
  }, [worktreePath, relPath, status, requestKey]);

  const retry = useCallback(() => setFetchNonce((nonce) => nonce + 1), []);

  // 1. The live target's read failed (transport reject, or a both-sides-failed
  //    comparison): show the aggregate error. Keyed compare, so a stale failure
  //    from a file we've already navigated off never paints here.
  if (failedRequestKey === requestKey) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col items-center justify-center">
        <EmptyState
          className="self-stretch"
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

  // 2. Nothing committed yet (first-ever load, or a prior failure with no held
  //    frame to keep): show the skeleton. Bone count comes from the live status.
  if (committed === null) {
    const skeletonSingle = deriveSingleSide(status);
    return (
      <Skeleton
        label="Loading image versions"
        className="flex h-full min-h-0 w-full flex-col gap-3 p-3"
      >
        <SkeletonBone className="h-6 w-44" />
        <div className="flex min-h-0 flex-1 gap-3">
          <SkeletonBone className="min-h-0 flex-1 rounded-md" />
          {skeletonSingle === null ? <SkeletonBone className="min-h-0 flex-1 rounded-md" /> : null}
        </div>
      </Skeleton>
    );
  }

  // 3. Render the committed snapshot. Everything below reads from `committed`,
  //    not live props, so the held frame stays internally consistent (image,
  //    layout, alt text, captions all belong to the same file) until the swap.
  const view = committed;
  // Still holding an earlier file while the live one loads: flag the frame busy
  // for assistive tech. We deliberately do NOT make it `inert` — inerting the
  // focused subtree during a keyboard-driven file step blurs focus out of the
  // dialog (Chromium blurs inert descendants) with nothing to restore it. The
  // only thing inert guarded was a stale Retry firing against the new target,
  // which is harmless — it just refetches the file that's already loading.
  const isHolding = view.requestKey !== requestKey;
  const singleSide = deriveSingleSide(view.status);

  if (singleSide !== null) {
    const caption =
      singleSide === "working" ? "Added — no previous version" : "Deleted — no working version";
    return (
      <div className="flex h-full min-h-0 w-full flex-col p-3" aria-busy={isHolding || undefined}>
        <ImagePane
          key={`${view.attempt}:${singleSide}`}
          label={singleSide === "working" ? "Working tree" : "HEAD"}
          side={view.versions[singleSide]}
          relPath={view.relPath}
          caption={caption}
          initialDecodeFailed={view.decodeFailures[singleSide]}
          onRetry={retry}
        />
      </div>
    );
  }

  const okSides: OkSides | null =
    view.versions.head.ok && view.versions.working.ok
      ? { head: view.versions.head, working: view.versions.working }
      : null;
  const bothOk = okSides !== null;
  const anyDecodeFailed = view.decodeFailures.head || view.decodeFailures.working;
  // A broken side can only show its fallback in two-up (swipe/onion <img>s have
  // no error affordance), so a decode failure locks the layout to two-up and
  // hides the compare modes.
  const showModes = bothOk && !anyDecodeFailed;
  const effectiveMode: ImageDiffMode = showModes ? mode : "two-up";

  return (
    <div className="flex h-full min-h-0 w-full flex-col" aria-busy={isHolding || undefined}>
      {showModes ? (
        <div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-3">
          <SegmentedToggle options={MODE_OPTIONS} value={effectiveMode} onChange={setMode} />
          {effectiveMode === "onion" ? (
            <label className="flex items-center gap-2 text-2xs text-muted-foreground">
              Working tree opacity
              <input
                type="range"
                min={0}
                max={100}
                value={onionOpacity}
                aria-label="Working tree opacity"
                onChange={(event) => setOnionOpacity(Number(event.currentTarget.value))}
                className="w-36 cursor-pointer"
                style={{ accentColor: "var(--color-text-primary)" }}
              />
            </label>
          ) : null}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col p-3">
        {effectiveMode === "two-up" || okSides === null ? (
          <div className="flex min-h-0 flex-1 gap-3">
            <ImagePane
              key={`${view.attempt}:head`}
              label="HEAD"
              side={view.versions.head}
              relPath={view.relPath}
              initialDecodeFailed={view.decodeFailures.head}
            />
            <ImagePane
              key={`${view.attempt}:working`}
              label="Working tree"
              side={view.versions.working}
              relPath={view.relPath}
              initialDecodeFailed={view.decodeFailures.working}
            />
          </div>
        ) : effectiveMode === "swipe" ? (
          <SwipeCompare sides={okSides} relPath={view.relPath} />
        ) : (
          <OnionCompare sides={okSides} relPath={view.relPath} opacity={onionOpacity} />
        )}
      </div>
    </div>
  );
}
