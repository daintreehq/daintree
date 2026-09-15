/**
 * Main-side proof that a project view has drawn a frame (#12394).
 *
 * A view that has been `setVisible(false)`, frozen, purged or never shown at
 * all has no tiles to composite, so revealing it before its renderer produces
 * a new frame shows the flat canvas background. Renderer readiness signals
 * (skeleton parsed, React committed, warm wake finished) prove work ran, not
 * that it was drawn. The paint gate therefore asks the page itself to wait out
 * two animation frames: by the second callback the first frame has committed
 * and been submitted to the compositor, which keeps that surface and shows it
 * the moment the outgoing view detaches. This is the same double-rAF settle
 * `notifyViewPainted` uses behind the anti-flash bridge.
 *
 * Each call is its own round trip, so a probe that outlives its gate (the view
 * was cached and its frames stopped) can never release a later gate — callers
 * check gate identity when it settles. There is deliberately no timeout here:
 * the paint gate's hard bound owns that decision.
 */

const RENDERED_FRAME_PROBE =
  "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))";

/**
 * Resolves `true` once the page has run two animation frames after the call,
 * `false` if the view is gone or the evaluation fails. Never rejects.
 *
 * Any resolved value counts: the production expression always resolves `true`,
 * and unit-test WebContents mocks that resolve `undefined` for unmodelled
 * scripts stay neutral, as with the bootstrap probe in ProjectViewFactory.
 */
export async function waitForRenderedFrame(wc: Electron.WebContents): Promise<boolean> {
  try {
    if (wc.isDestroyed()) return false;
    await wc.executeJavaScript(RENDERED_FRAME_PROBE);
    return true;
  } catch {
    return false;
  }
}
