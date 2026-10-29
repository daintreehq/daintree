/**
 * The host switch screen's exit across the view swap (#15300).
 *
 * The screen is drawn by the view the window is leaving, so it went with that
 * view: a switch landing just after the screen's loading gate cut from a mark a
 * stroke into its draw straight to the destination. Nothing in the outgoing
 * document outlives the swap, so the incoming one carries the exit. Just before
 * the swap, main reads whether the screen is up and what its resting surface is
 * (the canvas and the empty title band). When it is, the incoming document is
 * covered with that surface, the swap happens under it, and the cover then
 * fades on the shared exit tier. The destination is never held back for it:
 * the cover goes on only once the destination is ready to show.
 *
 * The cover is a pseudo-element from a stylesheet main inserts, rather than an
 * element. A cold switch reveals the pre-React skeleton, so there is no app to
 * render one yet; a pseudo-element takes no focus or pointer input, and with
 * no content it has nothing to say to assistive tech. It sits where the screen
 * sat, just above the toolbar and under every dialog and palette. While the
 * startup skeleton is up, a second copy sits on top of it, since the skeleton
 * covers everything until the app is ready; the two fade together, so the
 * skeleton leaving mid-fade changes nothing.
 *
 * The sheets are author-origin: Electron 42 removes an inserted sheet only
 * from the author origin, so a user-origin cover could never come off. Their
 * `!important` is what outranks the app's own rules.
 */

import type { BrowserWindow, WebContents } from "electron";
import { UI_EXIT_DURATION, UI_EXIT_EASING } from "../../shared/config/uiMotion.js";
import { waitForRenderedFrame } from "./renderedFrameProbe.js";

/**
 * How long a swap waits for the cover. It waits only while the screen is up,
 * where the mark keeps drawing meanwhile; a renderer slower than this gets the
 * plain swap it always had.
 */
export const SWITCH_SCREEN_HANDOFF_BUDGET_MS = 250;

// The outgoing document's switch screen (src/components/HostSwitch/HostSwitchScreen.tsx):
// its root is the canvas and its first child the title band. Inside its loading
// gate the root is transparent and the project being left is what shows, so
// that swap stays a plain one, and performance mode has no fades to hand off to.
export const READ_SWITCH_SCREEN = `(() => {
  const screen = document.querySelector('[data-testid="host-switch-screen"]');
  if (!(screen instanceof HTMLElement)) return null;
  if (document.body && document.body.dataset.performanceMode === "true") return null;
  const style = getComputedStyle(screen);
  if (style.opacity === "0" || style.visibility === "hidden") return null;
  const band = screen.firstElementChild;
  return {
    canvas: style.backgroundColor,
    band: band ? getComputedStyle(band).backgroundColor : style.backgroundColor,
    bandHeight: band ? band.getBoundingClientRect().height : 0,
  };
})()`;

const COVER = "body::after, #startup-skeleton::after";
const FADE_CSS = `${COVER} { opacity: 0 !important; }`;

// A computed colour, and nothing that could end the declaration it is written into.
const COMPUTED_COLOR = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([\w\s.,%/+-]*\)$/;

interface SwitchScreenSurface {
  canvas: string;
  band: string;
  bandHeight: number;
}

function toSurface(value: unknown): SwitchScreenSurface | null {
  if (typeof value !== "object" || value === null) return null;
  const { canvas, band, bandHeight } = value as Record<string, unknown>;
  if (typeof canvas !== "string" || !COMPUTED_COLOR.test(canvas)) return null;
  if (typeof band !== "string" || !COMPUTED_COLOR.test(band)) return null;
  if (typeof bandHeight !== "number" || !Number.isFinite(bandHeight)) return null;
  return { canvas, band, bandHeight: Math.min(Math.max(Math.round(bandHeight), 0), 200) };
}

function coverCss({ canvas, band, bandHeight }: SwitchScreenSurface): string {
  // The solid colour is what forced colours keep: it drops gradients, and
  // swaps the colour for the system canvas rather than leaving nothing.
  const surface = [
    'content: "" !important;',
    "position: fixed !important;",
    "inset: 0 !important;",
    "pointer-events: none !important;",
    `background-color: ${canvas} !important;`,
    `background-image: linear-gradient(${band} 0 ${bandHeight}px, ${canvas} ${bandHeight}px) !important;`,
    `transition: opacity ${UI_EXIT_DURATION}ms ${UI_EXIT_EASING} !important;`,
  ].join(" ");
  return [
    `body::after { ${surface} z-index: calc(var(--z-toolbar) + 1) !important; }`,
    `#startup-skeleton::after { ${surface} z-index: 2147483647 !important; }`,
  ].join("\n");
}

function removeCss(wc: WebContents, key: string): void {
  try {
    if (!wc.isDestroyed()) void wc.removeInsertedCSS(key).catch(() => {});
  } catch {
    // A view mid-teardown takes its stylesheets with it.
  }
}

export interface SwitchScreenHandoff {
  /** The outgoing view is gone: fade the cover out, then drop it. */
  release(): void;
  /** The swap didn't happen: drop the cover at once. */
  cancel(): void;
}

/**
 * Cover `incoming` with the switch screen `outgoing` is showing, and wait for
 * a frame drawn with it, so the swap uncovers nothing. Null when there is no
 * screen up to hand over, or the cover couldn't be put on in time. Never
 * rejects: the handoff is cosmetic and must never be what fails a switch.
 */
export async function prepareSwitchScreenHandoff(
  outgoing: WebContents | undefined,
  incoming: WebContents,
  win: BrowserWindow
): Promise<SwitchScreenHandoff | null> {
  const TIMED_OUT = Symbol("timed-out");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), SWITCH_SCREEN_HANDOFF_BUDGET_MS);
  });
  try {
    if (!outgoing || outgoing.isDestroyed() || incoming.isDestroyed()) return null;
    // A document still loading (a new window's first view) has no screen up,
    // and Electron would hold the read until it finished.
    if (outgoing.isLoadingMainFrame()) return null;
    const read = await Promise.race([
      outgoing.executeJavaScript(READ_SWITCH_SCREEN).catch(() => null),
      timedOut,
    ]);
    const surface = read === TIMED_OUT ? null : toSurface(read);
    if (!surface || incoming.isDestroyed()) return null;

    const inserting = incoming.insertCSS(coverCss(surface));
    const key = await Promise.race([inserting.catch(() => null), timedOut]);
    if (key === TIMED_OUT) {
      // Too late for the frame the swap uncovers. The fade is queued behind it
      // to the same renderer, so a cover that lands after the swap normally
      // lands already faded (unless that renderer draws between the two), and
      // both come off once they have.
      for (const late of [inserting, incoming.insertCSS(FADE_CSS)]) {
        void late.then(
          (lateKey) => removeCss(incoming, lateKey),
          () => {}
        );
      }
      return null;
    }
    if (key === null) return null;
    // Past the budget the cover may miss the first uncovered frame, but it is
    // on and still fades: a frame of the destination is the plain swap's cut.
    // A window nobody can see draws no frames, and has nothing to flash on.
    if (!win.isDestroyed() && !win.isMinimized() && win.isVisible()) {
      await Promise.race([waitForRenderedFrame(incoming), timedOut]);
    }

    let settled = false;
    return {
      release() {
        if (settled) return;
        settled = true;
        try {
          if (incoming.isDestroyed()) return;
          void incoming
            .insertCSS(FADE_CSS)
            .then((fadeKey) => {
              setTimeout(() => {
                removeCss(incoming, key);
                removeCss(incoming, fadeKey);
              }, UI_EXIT_DURATION);
            })
            .catch(() => removeCss(incoming, key));
        } catch {
          // The view went with its stylesheets.
        }
      },
      cancel() {
        if (settled) return;
        settled = true;
        removeCss(incoming, key);
      },
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
