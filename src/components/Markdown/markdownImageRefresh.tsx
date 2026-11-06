import { createContext, useEffect, useState, type ComponentProps } from "react";
import { PATH_CANONICAL_HEADER } from "@shared/types/ipc/files";
import { isPathInside, toWorktreeRelative } from "@shared/utils/path";
import { useFileChangeCount, type FileChangeSignal } from "@/hooks/useFileChangeCount";

/**
 * What a host that watches the worktree lends its rendered Markdown, so each
 * local image refreshes on the ticks that could have rewritten it rather than
 * on every write anywhere in the worktree (#15678).
 */
export interface MarkdownImageTracking {
  /** Moves on every change the host hears about: its change tick. */
  trigger: unknown;
  /** What moved behind `trigger`. Undefined means every move counts. */
  signal: FileChangeSignal | undefined;
  /** The worktree `signal`'s directories are relative to, or "" for none. */
  worktreePath: string;
}

/**
 * Opt-in: without it, local images take the host's cache token alone, as
 * every surface that tracks no worktree does.
 */
export const MarkdownImageTrackingContext = createContext<MarkdownImageTracking | null>(null);

// This machine's protocol URLs. A remote view's (`daintree-file://host/…`)
// are proxied to a host that sends no canonical-path answer, so they are
// never probed and refresh on every tick, as they always have.
const LOCAL_PROBE_PREFIX = "daintree-file://load?";

let lastImageInstance = 0;
// Every mounted image gets a token no earlier mount used. Chromium hands an
// `<img>` whose URL it already holds the decoded copy, so a fresh mount (back
// to Rendered, a re-render that moved the image) has to ask again: nothing
// was tracking this file while it was off screen.
function claimImageInstance(): number {
  lastImageInstance += 1;
  return lastImageInstance;
}

/** The image's worktree-relative path, or null when the signal can't speak for it. */
function imageRelativePath(src: string, worktreePath: string): string | null {
  if (!worktreePath) return null;
  let filePath: string | null;
  try {
    filePath = new URL(src).searchParams.get("path");
  } catch {
    return null;
  }
  if (!filePath || !isPathInside(filePath, worktreePath)) return null;
  return toWorktreeRelative(filePath, worktreePath) || null;
}

/**
 * The cache token for one local image: the host's `epoch` (Refresh, reveal,
 * focus regain), this mount, and a count of the ticks that could have touched
 * the file.
 *
 * A tick is only skipped on the strength of a proof that the image's path is
 * its own realpath with no other hard link, taken by a `daintree-file:` HEAD
 * after the refresh it covers, so containment decides it exactly as it decides
 * the image itself. Until a proof lands, and for a path that fails one
 * (symlinked, hard-linked, missing, refused), every tick refreshes the image.
 * Each refresh asks again, so a file that appears or stops being aliased is
 * picked up on the refresh after.
 */
function useMarkdownImageToken(src: string, epoch: string, tracking: MarkdownImageTracking) {
  const [instance] = useState(claimImageInstance);
  // The token whose proof landed: one refresh's, so the next one lapses it.
  const [provenToken, setProvenToken] = useState<string | null>(null);
  const tokenFor = (count: number) => `${src}\n${epoch}.${instance}.${count}`;
  const count = useFileChangeCount(
    tracking.trigger,
    tracking.signal,
    imageRelativePath(src, tracking.worktreePath),
    (countBefore) => provenToken === tokenFor(countBefore)
  );
  const token = tokenFor(count);

  useEffect(() => {
    if (!src.startsWith(LOCAL_PROBE_PREFIX)) return;
    const controller = new AbortController();
    void fetch(src, { method: "HEAD", signal: controller.signal }).then(
      (response) => {
        // Checked before the write: a settled fetch can still run this after
        // the cleanup aborted it, and the proof would belong to a refresh
        // already superseded.
        if (controller.signal.aborted) return;
        if (response.ok && response.headers.get(PATH_CANONICAL_HEADER) === "true") {
          setProvenToken(token);
        }
      },
      () => {}
    );
    return () => controller.abort();
  }, [src, token]);

  return `${epoch}.${instance}.${count}`;
}

/** A local Markdown image whose `src` moves only when its own file may have. */
export function TrackedMarkdownImage({
  src,
  epoch,
  tracking,
  ...props
}: Omit<ComponentProps<"img">, "src"> & {
  src: string;
  epoch: string;
  tracking: MarkdownImageTracking;
}) {
  const token = useMarkdownImageToken(src, epoch, tracking);
  return <img {...props} src={`${src}&v=${encodeURIComponent(token)}`} />;
}
