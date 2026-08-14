import { logWarn } from "@/utils/logger";
import { getErrorMessage } from "@/utils/errorContext";

// Upper bound on frames a single terminal will keep retrying its reveal before
// the caller gives up on it. A warm project-view return that's settling its
// layout needs only a couple of frames; the ceiling just stops a pane that's
// genuinely offscreen/unmeasurable from spinning forever (~10 frames ≈ 160ms).
export const MAX_REVEAL_FRAMES = 10;
// Paint each pane on two SEPARATE frames once it's paintable. The first paint
// can land in the frame before the compositor swaps the now-foreground project
// view in — or before xterm's own IntersectionObserver re-fires as the view
// un-occludes and momentarily re-pauses the renderer — so it doesn't visually
// stick. The second, a frame later once those observers have settled, is the
// one the user actually sees. This double pass is what turns the previously
// intermittent reveal into a reliable one.
export const REVEAL_CONFIRM_PAINTS = 2;

// rAF is paused for a backgrounded/occluded WebContentsView, so its callback can
// never fire there. Race it against a timeout so a caller awaiting a frame can't
// hang forever (and later resume stale to interleave with the next reveal). In
// the normal foreground case the real frame (~16ms) always wins well before the
// fallback.
const NEXT_FRAME_FALLBACK_MS = 250;

export function nextFrame(): Promise<void> {
  if (typeof requestAnimationFrame !== "function") return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const done = (): void => {
      if (settled) return;
      settled = true;
      // Release the loser. In the normal foreground case the real frame wins in
      // ~16ms and this fallback would otherwise stay armed for the remaining
      // ~234ms holding the promise closure — once per frame, and a reveal burns
      // up to MAX_REVEAL_FRAMES of them per terminal.
      if (fallback !== undefined) clearTimeout(fallback);
      resolve();
    };
    requestAnimationFrame(done);
    if (typeof setTimeout === "function") fallback = setTimeout(done, NEXT_FRAME_FALLBACK_MS);
  });
}

export function isDocumentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * Attempt one reveal pass. Returns `true` when the terminal was paintable and
 * the pass landed, `false` when it isn't paintable yet and the caller should
 * retry on a later frame.
 *
 * The two reveal entry points are NOT interchangeable, which is why this is
 * injected rather than hard-wired:
 *
 * - `revealTerminal` — the project-view sweep's pass. Opens hibernated/unopened
 *   panes and passes `trustDomVisibility` so a stale reactive `isVisible=false`
 *   on a warm WebContentsView resume doesn't skip the WebGL reattach. It also
 *   reports `true` for a MISSING instance ("gone — nothing to retry").
 * - `repaintForReveal` — the assistant sidebar-transition pass. Keeps the
 *   `isVisible` gate (a transform-hidden pane must not accumulate a fleet-wide
 *   WebGL want, #10671) and reports `false` for a missing instance, so a
 *   still-provisioning terminal keeps retrying instead of banking a false paint.
 */
export type RevealAttempt = (id: string) => boolean | Promise<boolean>;

/**
 * Drive a single terminal's reveal to a stable result: retry frame-by-frame
 * until {@link RevealAttempt} reports paintable, then paint it
 * {@link REVEAL_CONFIRM_PAINTS} times across separate frames to defeat the
 * compositor/observer present-race that otherwise leaves the first paint
 * un-stuck. Bounded by {@link MAX_REVEAL_FRAMES}.
 *
 * @returns `true` once every confirm paint landed; `false` when the caller
 * aborted, the frame budget ran out before the terminal became paintable, or the
 * attempt threw. A `false` return means the reveal obligation is NOT discharged —
 * callers that own a durable obligation (the assistant sidebar transition) must
 * keep it armed for a later retry.
 */
export async function revealUntilStable(
  id: string,
  attempt: RevealAttempt,
  isAborted: () => boolean,
  logContext: string
): Promise<boolean> {
  let painted = 0;
  for (let frame = 0; frame < MAX_REVEAL_FRAMES && painted < REVEAL_CONFIRM_PAINTS; frame++) {
    // The view may have been switched away (detached → hidden) since the reveal
    // started, or the assistant re-hidden, during a frame yield. Stop before
    // touching a hidden surface — the caller owns the retry.
    if (isAborted()) return false;
    let paintable: boolean;
    try {
      paintable = await attempt(id);
    } catch (error) {
      // One broken terminal must not abort the caller's wider sweep — the next
      // visible terminal still needs its post-reveal repaint.
      // getErrorMessage, not the Error itself: `message` is non-enumerable, so
      // a nested Error serialises to `{}` in the log context and the one line
      // that could explain a wedged terminal says nothing at all (#11776).
      logWarn(`${logContext} reveal failed`, { id, error: getErrorMessage(error) });
      return false;
    }
    if (paintable) painted++;
    // Yield a frame between attempts: lets layout/compositor settle before a
    // retry, and spaces the confirm paint out from the first.
    await nextFrame();
  }
  return painted >= REVEAL_CONFIRM_PAINTS;
}
