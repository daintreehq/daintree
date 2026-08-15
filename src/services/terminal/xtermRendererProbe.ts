import type { Terminal } from "@xterm/xterm";

/**
 * Whether an xterm instance actually owns a live render service — the thing
 * that makes a pane capable of painting at all.
 *
 * Why this exists (#11776): `CoreBrowserTerminal.open()` is not transactional.
 * It assigns `element` (L462) and `_coreBrowserService` (L505) BEFORE
 * `_renderService` (L536), and its own re-entry guard tests only the first
 * two:
 *
 *   if (this.element?.ownerDocument.defaultView && this._coreBrowserService) return;
 *
 * So any throw in the L505-L536 window (CharSizeService / ThemeService /
 * CoreBrowserService / the RenderService constructor itself) leaves the
 * instance permanently "already opened" from xterm's point of view while it
 * has no renderer and never will — every later `open()` early-returns without
 * building one. `isOpened` alone cannot see that state, which is exactly how a
 * pane ends up blank forever while its PTY keeps streaming.
 *
 * The probe is the public, documented `dimensions` accessor rather than a
 * `_core._renderService` reach-through. xterm's own typings say "*This will be
 * undefined before {@link open} is called*", and the implementation is literally
 * `if (!this._renderService) return undefined`, so it answers the question
 * without depending on a private field name surviving a beta bump.
 *
 * Both failure modes are deliberately biased the same way — **when we cannot
 * tell, report healthy**:
 *
 *  - No `dimensions` accessor at all (an older/newer xterm, or a hand-built
 *    test double) → `true`. A probe that guessed "broken" here would send
 *    perfectly good terminals into the rebuild path on every open.
 *  - The accessor throws → `false`. `RenderService.dimensions` dereferences its
 *    renderer, so a throw means there is a service but no usable renderer,
 *    which is just as unpaintable.
 *
 * Reporting healthy on an unknown shape preserves today's behaviour; reporting
 * broken on one would invent a new failure. Cheap to call — a property read.
 */
export function hasUsableRenderer(terminal: Pick<Terminal, "dimensions">): boolean {
  if (!("dimensions" in terminal)) return true;
  try {
    return terminal.dimensions !== undefined;
  } catch {
    return false;
  }
}
