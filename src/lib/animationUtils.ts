/* Motion token scale — mirrors the CSS custom properties in src/index.css so
 * React components using `motion` props and JS timers stay in sync with CSS
 * keyframes and Tailwind utilities. See @theme block at the top of index.css.
 */
export const DURATION_75 = 75;
export const DURATION_100 = 100;
export const DURATION_150 = 150;
export const DURATION_200 = 200;
export const DURATION_250 = 250;
export const DURATION_300 = 300;

export const CHORD_SHOW_DELAY_MS = DURATION_200;

export const EASE_SNAPPY = "cubic-bezier(0.2, 0, 0, 1)";
export const EASE_SPRING_CRITICAL =
  "linear(0, 0.007, 0.029 2.2%, 0.118 4.7%, 0.625 14.4%, 0.826 19%, 0.902 24%, 0.962 29.8%, 0.984 33.3%, 1.004 37.8%, 1.01 42.4%, 1.011 52.2%, 1.001)";
export const EASE_OUT_EXPO = "cubic-bezier(0.16, 1, 0.3, 1)";

export const TERMINAL_ANIMATION_DURATION = 0;
export const UI_ANIMATION_DURATION = DURATION_150;

export function getTerminalAnimationDuration(): number {
  return TERMINAL_ANIMATION_DURATION;
}

export function getUiAnimationDuration(): number {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return UI_ANIMATION_DURATION;
  }

  // Performance mode skips timers entirely — callers use duration === 0 as a
  // signal to complete synchronously. Reduced-motion no longer short-circuits
  // here: CSS owns reduced-motion presentation (transform removed, opacity
  // kept) so JS durations stay intact.
  const performanceMode = document.body.dataset.performanceMode === "true";
  return performanceMode ? 0 : UI_ANIMATION_DURATION;
}

/** Collapse a JS timer duration to 0 when performance mode is active; otherwise
 *  return it unchanged. Mirrors `getUiAnimationDuration`'s policy — performance
 *  mode bypasses JS timers, reduced-motion does NOT (CSS owns reduced-motion).
 *  Reads `document.body` lazily for SSR/JSDOM safety; never at module load. */
export function getPerformanceModeFloor(ms: number): number {
  if (typeof document === "undefined") {
    return ms;
  }
  const performanceMode = document.body?.dataset.performanceMode === "true";
  return performanceMode ? 0 : ms;
}

export const UI_ENTER_DURATION = DURATION_200;
export const UI_EXIT_DURATION = 120;

export const UI_PALETTE_ENTER_DURATION = DURATION_150;
export const UI_PALETTE_EXIT_DURATION = DURATION_100;

// Tooltip hover/skip delays consumed by the Radix `TooltipProvider` at the app
// root. These are wait times before a tooltip opens, not animation durations.
/** UX anti-flicker gate: sub-400ms work should show nothing (Doherty threshold).
 *  Used by discrete-action stale surfaces (e.g. Review/Commit modal background
 *  refresh via `.surface-stale`) and the `.animate-pulse-delayed` skeleton.
 *  Not an animation token — a perceptual floor.
 *  CSS counterpart: `--anti-flicker-delay` in src/index.css `:root`. The
 *  drift-contract test in animationUtils.test.ts enforces parity.
 *  See `UI_PALETTE_STALE_DELAY` for the typed-input counterpart. */
export const UI_DOHERTY_THRESHOLD = 400;

/** Pane-local settle window for `useShouldSuppressLocalError`. Once an active
 *  global recovery cause clears, local error banners stay suppressed for this
 *  long before reappearing — absorbs visible flicker when `backendStatus`
 *  flaps between `"recovering"` and `"connected"`. Stacks on top of the
 *  500ms recoveryTimer in `src/store/listeners/panel/backendHealth.ts`, so the
 *  total dead-zone from a backend reconnect to a local banner re-show is
 *  ~900ms at p50 — intentionally long enough to render the flap invisible.
 *  Performance mode collapses this to 0 via `getPerformanceModeFloor`. */
export const LOCAL_ERROR_SETTLE_MS = UI_DOHERTY_THRESHOLD;

/** UX anti-flicker gate for palette typed-input stale dimming. Shorter than
 *  Doherty's 400ms because keystrokes arrive every ~200ms at normal typing
 *  speed — a 400ms gate would almost never fire before being reset by the next
 *  keystroke, leaving stale state unacknowledged. Industry convention (Algolia
 *  `stalledSearchDelay`, React `useDeferredValue` examples) is 200ms.
 *  CSS counterpart: `--anti-flicker-delay-palette` in src/index.css `:root`.
 *  Consumed by `.palette-results-stale` and the palette loading bar. */
export const UI_PALETTE_STALE_DELAY = DURATION_200;

/** UX anti-flicker gate for skeleton components using the `immediate` prop.
 *  Sub-200ms work should show no pulse — warm-cache Suspense falls through this.
 *  Consumed by `useSkeletonGate` in `src/hooks/useDeferredLoading.ts`.
 *  Not an animation token — a perceptual floor, same family as Doherty. */
export const UI_SKELETON_GATE_MS = 200;

/** UX anti-flicker gate for a granular, per-item *inline* loading indicator —
 *  e.g. the file-tree folder-expansion spinner (`FileTreeRow`). A folder whose
 *  listing resolves in under this window shows nothing, killing the flash on a
 *  warm-cache expand. Intentionally shorter than `UI_DOHERTY_THRESHOLD`, which
 *  governs page/panel-level spinners: 400ms is too sluggish for feedback this
 *  granular, and issue #11318 asks for ~200ms here specifically. Shares the
 *  200ms value with the skeleton gate by coincidence, not by coupling — the two
 *  can diverge freely. Not an animation token — a perceptual floor, same family
 *  as the Doherty/skeleton gates. */
export const UI_INLINE_LOADING_GATE_MS = 200;

/** Minimum on-screen dwell once a skeleton has crossed its onset gate. The
 *  onset gates (`useSkeletonGate`, `useDohertyGate`) only suppress *early*
 *  display; nothing stops a skeleton that just appeared from tearing down in
 *  the same frame when the underlying work resolves moments later. That
 *  same-frame flash reads as a glitch. `useSkeletonDisplayFloor` holds the
 *  placeholder visible for this floor once shown. 250ms sits at the just-
 *  noticeable-difference threshold — long enough to kill the flash, short
 *  enough to never feel sluggish in an IDE where data usually resolves fast.
 *  Not an animation token — a perceptual floor, same family as the gates. */
export const UI_SKELETON_FLOOR_MS = DURATION_250;

/** One full rotation of Tailwind's built-in `.animate-spin` utility, which runs
 *  `spin 1s linear infinite` (`--animate-spin` in tailwindcss/theme.css, not
 *  overridden in this repo). `SpinningIcon` uses this as the backstop timer that
 *  clears a spinning refresh icon when the CSS animation is suppressed
 *  (reduced-motion / performance mode) and therefore never fires an
 *  `animationiteration` event to stop it at a rotation boundary. Pinned to
 *  Tailwind's duration; the drift-contract test in animationUtils.test.ts parses
 *  theme.css and fails if the two diverge. Not a design-motion token — a
 *  mechanism constant coupled to a third-party default. */
export const UI_SPIN_CYCLE_MS = 1_000;

/** Feedback-hint window for direct user actions (e.g. `Button`'s `loading`
 *  state). Distinct in role from the skeleton/Doherty gates: those *delay*
 *  showing a placeholder to avoid flicker on background work, whereas a
 *  user-initiated action gets *immediate* feedback. This documents the timing
 *  tier for the opacity/transition feel of in-progress affordances; it is not
 *  used as a visibility gate. Shares the 200ms value with the skeleton gate by
 *  coincidence, not by coupling. */
export const UI_FEEDBACK_HINT_MS = 200;

/** How long an action success-label swap dwells visible before the toast
 *  auto-dismisses. Covers saccade (~200ms), lexical recognition (~300ms), and
 *  a comprehension buffer so sighted and screen-reader users can process the
 *  label change before the toast disappears. */
export const UI_ACTION_SUCCESS_DWELL_MS = 2000;

/** How long a transient discovery hint stays visible after the event that
 *  triggered it (e.g. the "Moved to trash" tooltip above the trash icon after
 *  a panel is closed). One second is enough to draw the eye without dwelling
 *  — discovery cue, not an undo affordance. */
export const UI_TRANSIENT_HINT_DWELL_MS = 1_000;

export const UI_TOOLTIP_DELAY_DURATION = 500;
export const UI_TOOLTIP_SKIP_DELAY_DURATION = DURATION_300;

export const UI_ENTER_EASING = EASE_SPRING_CRITICAL;
export const UI_EXIT_EASING = "cubic-bezier(0.2, 0, 0.7, 0)";

/** Scrim/backdrop fade easing. A dialog backdrop only interpolates opacity, and
 *  opacity has no perceived mass — the eased and spring curves used for the card
 *  read as inertia the scrim doesn't have. Shared by `AppDialog` and
 *  `AppPaletteDialog` so both overlay families dim identically. */
export const UI_SCRIM_EASING = "linear";

/** Framer-motion-compatible easing tuples. framer-motion 12.x tightened
 *  Transition.ease to its own Easing type and rejects CSS string easings. */
export const UI_ENTER_EASING_FM: [number, number, number, number] = [0.2, 0, 0, 1];
export const UI_EXIT_EASING_FM: [number, number, number, number] = [0.2, 0, 0.7, 0];
export const EASE_OUT_EXPO_FM: [number, number, number, number] = [0.16, 1, 0.3, 1];

export function getUiTransitionDuration(direction: "enter" | "exit"): number {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return direction === "enter" ? UI_ENTER_DURATION : UI_EXIT_DURATION;
  }

  const performanceMode = document.body.dataset.performanceMode === "true";
  if (performanceMode) return 0;

  return direction === "enter" ? UI_ENTER_DURATION : UI_EXIT_DURATION;
}

export function getUiPaletteTransitionDuration(direction: "enter" | "exit"): number {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return direction === "enter" ? UI_PALETTE_ENTER_DURATION : UI_PALETTE_EXIT_DURATION;
  }

  const performanceMode = document.body.dataset.performanceMode === "true";
  if (performanceMode) return 0;

  return direction === "enter" ? UI_PALETTE_ENTER_DURATION : UI_PALETTE_EXIT_DURATION;
}

export const PANEL_MINIMIZE_DURATION = 120;
export const PANEL_RESTORE_DURATION = DURATION_200;

export const BANNER_ENTER_DURATION = DURATION_250;
export const BANNER_EXIT_DURATION = DURATION_200;

/** Screen-reader buffer flush delay for live-region content swaps. When a
 *  `role="status"` / `aria-live` region's text changes synchronously, VoiceOver
 *  on macOS Sequoia and iOS 18 has been observed to drop the announcement.
 *  The APG mitigation is clear-then-add-on-next-tick: clear the region, wait
 *  ~150ms, then render new content. Below the 400ms Doherty threshold so
 *  sighted users perceive it as instant. Not a motion token — must not be
 *  gated on `prefers-reduced-motion`. */
export const LIVE_REGION_SWAP_DELAY = DURATION_150;

export const DRAG_GHOST_OPACITY = 0.4;
export const DRAG_GHOST_EASING = "easeOut";
export const DRAG_OVERLAY_ENTRY_SCALE = 0.95;
export const DRAG_OVERLAY_ENTRY_OPACITY = 0.8;
/** Perceptual spring tuning for the drag-overlay pickup. `visualDuration` is in
 *  seconds (Framer Motion 12 perceptual spring API) and tracks the prior ~150ms
 *  tween feel; near-zero `bounce` keeps overshoot sub-pixel so the pickup reads
 *  crisp in a dense grid rather than springy. */
export const DRAG_OVERLAY_SPRING_VISUAL_DURATION = 0.15;
export const DRAG_OVERLAY_SPRING_BOUNCE = 0.05;

export const PANEL_MINIMIZE_EASING = "cubic-bezier(0.3, 0, 0.8, 0.15)";
export const PANEL_RESTORE_EASING = EASE_OUT_EXPO;

export function getPanelTransitionDuration(direction: "minimize" | "restore"): number {
  return direction === "minimize" ? PANEL_MINIMIZE_DURATION : PANEL_RESTORE_DURATION;
}
