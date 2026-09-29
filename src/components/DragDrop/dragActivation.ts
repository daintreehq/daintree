// Every drag surface that is also a click target (a tab, a panel header, a dock
// chip, a worktree card) waits for the same travel before it picks up, so a
// click never turns into a drag at a different jitter from its neighbour. 8px
// rather than the platform threshold (~4px) because several of these surfaces
// carry a popover trigger inside them. A dedicated grip has no click to protect
// and may pick up on the first move.
export const DRAG_ACTIVATION_DISTANCE = 8;

// Module-level so `useSensor`'s [sensor, options] memo holds across renders.
export const POINTER_SENSOR_OPTIONS = {
  activationConstraint: { distance: DRAG_ACTIVATION_DISTANCE },
};

// A long-press, so a touch that scrolls a strip doesn't lift what it lands on.
export const TOUCH_SENSOR_OPTIONS = {
  activationConstraint: { delay: 150, tolerance: 5 },
};
