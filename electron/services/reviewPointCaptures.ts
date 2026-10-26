import { randomUUID } from "crypto";
import type { ReviewPoint } from "../../shared/types/reviewPoint.js";

/**
 * Review points Review Hub captured as it read a worktree (#14585), held on the
 * host so a point, which can run to megabytes, never makes the trip to a view
 * and back. The hub keeps only the id of the capture behind the read it shows,
 * and marking the worktree reviewed names that id.
 *
 * Bounded by count per worktree, total size and age, oldest going first. A
 * hub whose capture has gone is told so when it marks, and reads again.
 */

const MAX_PER_WORKTREE = 8;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_AGE_MS = 30 * 60_000;

interface HeldCapture {
  projectId: string;
  worktreeId: string;
  point: ReviewPoint;
  bytes: number;
  heldAt: number;
}

export class ReviewPointCaptures {
  /** Insertion order is age order: the first entry is the oldest. */
  private readonly held = new Map<string, HeldCapture>();
  private totalBytes = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Hold `point` for the worktree and return the id that names it. */
  hold(projectId: string, worktreeId: string, point: ReviewPoint): string {
    this.sweep();
    const captureId = randomUUID();
    const bytes = Buffer.byteLength(JSON.stringify(point));
    this.held.set(captureId, { projectId, worktreeId, point, bytes, heldAt: this.now() });
    this.totalBytes += bytes;

    const ofWorktree = [...this.held].filter(
      ([, entry]) => entry.projectId === projectId && entry.worktreeId === worktreeId
    );
    for (const [id] of ofWorktree.slice(0, Math.max(0, ofWorktree.length - MAX_PER_WORKTREE))) {
      this.drop(id);
    }
    for (const [id] of this.held) {
      if (this.totalBytes <= MAX_TOTAL_BYTES || id === captureId) break;
      this.drop(id);
    }
    return captureId;
  }

  /** The point a capture id names, only for the project and worktree it was taken in. */
  get(projectId: string, worktreeId: string, captureId: string): ReviewPoint | null {
    this.sweep();
    const entry = this.held.get(captureId);
    if (!entry || entry.projectId !== projectId || entry.worktreeId !== worktreeId) return null;
    return entry.point;
  }

  clear(): void {
    this.held.clear();
    this.totalBytes = 0;
  }

  private sweep(): void {
    const oldest = this.now() - MAX_AGE_MS;
    for (const [id, entry] of this.held) {
      if (entry.heldAt > oldest) break;
      this.drop(id);
    }
  }

  private drop(id: string): void {
    const entry = this.held.get(id);
    if (!entry) return;
    this.held.delete(id);
    this.totalBytes -= entry.bytes;
  }
}

/** The host's one holder: every view of every project on this host uses it. */
export const reviewPointCaptures = new ReviewPointCaptures();
