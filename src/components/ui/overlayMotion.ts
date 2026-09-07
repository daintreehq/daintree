/**
 * The shared motion contract for Radix **anchored** overlays — the surfaces
 * that attach to a trigger and carry `data-state` plus `data-side`.
 *
 * Deliberately not app-wide: dialogs (`AppDialog`), `FixedDropdown`, toasts and
 * the hand-rolled Browser toolbar lists animate through Tailwind's discrete
 * `translate`/`scale` properties on a transition, not through keyframes, and
 * they stay that way. This is the keyframe family only.
 *
 * It exists because all five wrappers had grown their own copy of one class
 * list — six identical strings, plus two more inlined on the dock popovers —
 * so a change to the app's overlay motion meant eight coordinated edits. Two
 * exports replace them: panels below, and the lighter tooltip variant built
 * from the same parts. Both are defaults rather than locks; a consumer's own
 * `className` still lands after these through `cn()`.
 */

/**
 * The 4px directional nudge, shared by every surface including the tooltip.
 * Radix sets `data-side` to the side the content was actually placed on after
 * collision handling, so the surface always drifts in from its anchor.
 */
const OVERLAY_SLIDE =
  "data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1";

/**
 * Popovers, dropdown menus, context menus, selects and their submenus.
 *
 * Exit is deliberately faster than enter (120ms against 200ms): a surface on
 * its way out is no longer the thing being looked at, and matching the two
 * makes dismissal feel like it lagged the click.
 *
 * Those numbers are the entry/exit tier, and they are the same numbers
 * `UI_ENTER_DURATION` / `UI_EXIT_DURATION` carry in `src/lib/animationUtils.ts`
 * — the tier the dialogs animate on. A Tailwind utility cannot read a JS
 * constant, so this is a second spelling of one value rather than a second
 * value; `radix-animation-classes.test.tsx` derives the expected class from
 * the constant so the two cannot drift apart silently.
 *
 * Plain `join()` rather than `cn()` because there is nothing here to merge: no
 * conditional segments and no two tokens in the same conflict group. Every
 * consumer passes the result through `cn()` with its own `className` anyway,
 * so this is a readability choice, not a merge-safety boundary.
 */
export const OVERLAY_MOTION_CLASS = [
  "data-[state=open]:animate-in data-[state=closed]:animate-out",
  "data-[state=open]:duration-200 data-[state=closed]:duration-120",
  "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
  "data-[state=open]:zoom-in-97 data-[state=closed]:zoom-out-97",
  OVERLAY_SLIDE,
].join(" ");

/**
 * Tooltips: the same slide and fade, quicker, and no zoom.
 *
 * The two differences are the point rather than drift. A tooltip is a caption
 * that tracks the pointer across a toolbar, so 200ms in reads as lag on a
 * surface that should already be there — and a 3% scale on a one-line chip is
 * a few subpixels of blur, all cost and no signal. Everything that carries the
 * shared language — direction, distance, the fade — comes from the same place.
 */
export const TOOLTIP_MOTION_CLASS = [
  "animate-in fade-in-0 duration-150",
  "data-[state=closed]:animate-out data-[state=closed]:duration-100 data-[state=closed]:fade-out-0",
  OVERLAY_SLIDE,
].join(" ");
