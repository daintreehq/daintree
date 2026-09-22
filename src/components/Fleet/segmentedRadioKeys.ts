import type { KeyboardEvent } from "react";

/**
 * The APG radio-group keyboard model for the two hand-rolled segmented
 * controls in Fleet (`SaveFleetForm`, `FleetPickerPalette`): arrows move and
 * check, Home/End jump, and the group is one tab stop through a roving
 * `tabIndex`. `ui/SegmentedRadioGroup` owns the same model but keeps its thumb
 * outside the radio buttons and exposes no per-option test ids, which the
 * palette's tests depend on — so the model is shared here rather than the
 * component.
 */
export function handleSegmentedRadioKeyDown<T extends string>(
  e: KeyboardEvent<HTMLElement>,
  values: readonly T[],
  current: T,
  onChange: (next: T) => void
): void {
  const index = values.indexOf(current);
  if (index === -1 || values.length === 0) return;
  let next: number;
  switch (e.key) {
    case "ArrowRight":
    case "ArrowDown":
      next = (index + 1) % values.length;
      break;
    case "ArrowLeft":
    case "ArrowUp":
      next = (index - 1 + values.length) % values.length;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = values.length - 1;
      break;
    default:
      return;
  }
  e.preventDefault();
  e.stopPropagation();
  const value = values[next];
  if (value === undefined) return;
  onChange(value);
  const target = e.currentTarget.querySelector<HTMLElement>(
    `[role="radio"][data-value="${value}"]`
  );
  target?.focus();
}
