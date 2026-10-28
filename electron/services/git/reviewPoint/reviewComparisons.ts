import path from "node:path";
import type { ReviewComparisonResult } from "../../../../shared/types/reviewComparison.js";
import { compareReviewPoint, type CompareReviewPointOptions } from "./compareReviewPoint.js";

/**
 * One comparison per worktree at a time on this host. A newer request for the
 * same worktree cancels the one in flight, which answers `superseded`, and
 * starts once that one has answered; a request superseded while still waiting
 * answers without running at all. A filesystem read already stuck when the
 * cancel arrives can't be stopped (see `captureReviewPoint`), so the next
 * comparison doesn't wait on it.
 *
 * Keyed by the path as given, so callers pass the worktree's root as the
 * worktree list spells it.
 */
export class ReviewComparisons {
  private readonly latest = new Map<
    string,
    { controller: AbortController; settled: Promise<void> }
  >();

  constructor(private readonly run: typeof compareReviewPoint = compareReviewPoint) {}

  compare(
    cwd: string,
    point: unknown,
    options: CompareReviewPointOptions = {}
  ): Promise<ReviewComparisonResult> {
    const key = path.resolve(cwd);
    const previous = this.latest.get(key);
    const controller = new AbortController();
    previous?.controller.abort(SUPERSEDED);

    const external = options.signal;
    const forward = () => controller.abort(external?.reason);
    if (external?.aborted) forward();
    else external?.addEventListener("abort", forward, { once: true });

    const entry = { controller, settled: Promise.resolve() };
    this.latest.set(key, entry);
    const result = (async (): Promise<ReviewComparisonResult> => {
      await previous?.settled;
      const outcome = controller.signal.aborted
        ? stopped()
        : await this.run(cwd, point, { ...options, signal: controller.signal });
      // Whatever it found is older than what the newer request will find.
      if (controller.signal.reason === SUPERSEDED) {
        return {
          state: "failed",
          reason: "superseded",
          message: "A newer comparison of this worktree replaced it.",
        };
      }
      return outcome;
    })().finally(() => {
      external?.removeEventListener("abort", forward);
      if (this.latest.get(key) === entry) this.latest.delete(key);
    });

    entry.settled = result.then(noop, noop);
    return result;
  }
}

const SUPERSEDED = Symbol("superseded");

function stopped(): ReviewComparisonResult {
  return { state: "failed", reason: "cancelled", message: "The comparison was cancelled." };
}

function noop(): void {}

/** The host's one queue: every caller on this host goes through it. */
export const reviewComparisons = new ReviewComparisons();
