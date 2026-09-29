import type { MouseEvent as ReactMouseEvent } from "react";
import { MouseSensor, type MouseSensorOptions } from "@dnd-kit/core";

// Every drag surface that is also a click target (a tab, a panel header, a dock
// chip, a worktree card) waits for the same travel before it picks up, so a
// click never turns into a drag at a different jitter from its neighbour. 8px
// rather than the platform threshold (~4px) because several of these surfaces
// carry a popover trigger inside them. A dedicated grip has no click to protect
// and may pick up on the first move.
export const DRAG_ACTIVATION_DISTANCE = 8;

// Module-level so `useSensor`'s [sensor, options] memo holds across renders.
// Paired with a MouseSensor, never a PointerSensor: a PointerSensor also takes
// touch, which would then pick up on 8px of travel (a scroll) instead of the
// long-press below.
export const MOUSE_SENSOR_OPTIONS = {
  activationConstraint: { distance: DRAG_ACTIVATION_DISTANCE },
};

// A long-press, so a touch that scrolls a strip doesn't lift what it lands on.
export const TOUCH_SENSOR_OPTIONS = {
  activationConstraint: { delay: 150, tolerance: 5 },
};

// Primary button only. The stock MouseSensor refuses a right-click but takes a
// middle-button drag, which the tab strips' old PointerSensor never did.
const MOUSE_PRIMARY_BUTTON = 0;

export class PrimaryMouseSensor extends MouseSensor {
  static activators: {
    eventName: "onMouseDown";
    handler: (event: ReactMouseEvent, options: MouseSensorOptions) => boolean;
  }[] = [
    {
      eventName: "onMouseDown",
      handler: ({ nativeEvent: event }, { onActivation }) => {
        if (event.button !== MOUSE_PRIMARY_BUTTON) return false;
        onActivation?.({ event });
        return true;
      },
    },
  ];
}
