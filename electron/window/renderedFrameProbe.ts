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
 * Animation frames stop while nobody can see the page: a minimised or hidden
 * window, or on macOS one fully covered by another window. A switch made then
 * (an MCP `project.switch` from an agent, say) would wait out the paint bound
 * and roll back, although there is no screen for a blank canvas to flash on.
 * So a hidden window counts as confirmed, and so does a document that stays
 * hidden past a short settle — occlusion has no main-process API, and the
 * settle keeps a view whose `setVisible(true)` has not reached its renderer yet
 * from confirming before it has drawn.
 *
 * Each call is its own round trip, so a probe that outlives its gate (the view
 * was cached and its frames stopped) can never release a later gate — callers
 * check gate identity when it settles. There is deliberately no timeout here:
 * the paint gate's hard bound owns that decision.
 */

export const HIDDEN_DOCUMENT_SETTLE_MS = 250;

const RENDERED_FRAME_PROBE = `new Promise((resolve) => {
  let hiddenTimer = null;
  const done = () => {
    clearTimeout(hiddenTimer);
    document.removeEventListener("visibilitychange", onVisibility);
    resolve(true);
  };
  const onVisibility = () => {
    clearTimeout(hiddenTimer);
    if (document.visibilityState !== "hidden") return;
    hiddenTimer = setTimeout(() => {
      if (document.visibilityState === "hidden") done();
    }, ${HIDDEN_DOCUMENT_SETTLE_MS});
  };
  document.addEventListener("visibilitychange", onVisibility);
  onVisibility();
  requestAnimationFrame(() => requestAnimationFrame(done));
})`;

type ProbeWindow = Pick<
  Electron.BrowserWindow,
  "isDestroyed" | "isMinimized" | "isVisible" | "on" | "removeListener"
>;

function isWindowHidden(win: ProbeWindow): boolean {
  try {
    return !win.isDestroyed() && (win.isMinimized() || !win.isVisible());
  } catch {
    // The page probe is still the authority; a window we cannot query just
    // doesn't get the shortcut.
    return false;
  }
}

/**
 * Resolves `true` once the page has run two animation frames after the call,
 * or once nobody can see it (see above); `false` if the view is gone or the
 * evaluation fails. Never rejects.
 *
 * Any resolved value counts: the production expression always resolves `true`,
 * and unit-test WebContents mocks that resolve `undefined` for unmodelled
 * scripts stay neutral, as with the bootstrap probe in ProjectViewFactory.
 */
export async function waitForRenderedFrame(
  wc: Electron.WebContents,
  win?: ProbeWindow
): Promise<boolean> {
  try {
    if (wc.isDestroyed()) return false;
    if (win && isWindowHidden(win)) return true;
    const frame = wc.executeJavaScript(RENDERED_FRAME_PROBE).then(
      () => true,
      () => false
    );
    if (!win) return await frame;
    let onHidden: () => void = () => {};
    const hidden = new Promise<boolean>((resolve) => {
      onHidden = () => resolve(true);
      win.on("minimize", onHidden);
      win.on("hide", onHidden);
    });
    try {
      return await Promise.race([frame, hidden]);
    } finally {
      win.removeListener("minimize", onHidden);
      win.removeListener("hide", onHidden);
    }
  } catch {
    return false;
  }
}
