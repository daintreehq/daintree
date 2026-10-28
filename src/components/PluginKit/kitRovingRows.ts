import { useLayoutEffect, type FocusEvent, type KeyboardEvent, type RefObject } from "react";

const ROVE = "[data-kit-rove]";
const ROVE_ROW = "[data-kit-rove-row]";
const ROVE_STOP = "data-kit-rove-stop";

function setRoveStop(root: HTMLElement, stop: HTMLElement | undefined): void {
  for (const control of root.querySelectorAll<HTMLElement>(ROVE)) {
    control.tabIndex = control === stop ? 0 : -1;
    control.toggleAttribute(ROVE_STOP, control === stop);
  }
}

/**
 * One Tab stop for a list of rows that each hold controls: the control last
 * focused (else the first) is the only one in the tab order. Pair with
 * {@link roveFocus} and {@link roveKeyDown} on the same element.
 */
export function useRovingRows(root: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const controls = [...element.querySelectorAll<HTMLElement>(ROVE)];
    setRoveStop(element, controls.find((c) => c.hasAttribute(ROVE_STOP)) ?? controls[0]);
  });
}

export function roveFocus(event: FocusEvent<HTMLElement>): void {
  const target = event.target;
  if (target instanceof HTMLElement && target.matches(ROVE)) {
    setRoveStop(event.currentTarget, target);
  }
}

/** Up and Down: the same control in the next row; Left and Right: along the row; Home and End: the first and last row. */
export function roveKeyDown(event: KeyboardEvent<HTMLElement>): void {
  if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.matches(ROVE)) return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>(ROVE_ROW)];
  const row = target.closest<HTMLElement>(ROVE_ROW);
  if (!row) return;
  const inRow = (r: HTMLElement) => [...r.querySelectorAll<HTMLElement>(ROVE)];
  const at = rows.indexOf(row);
  const col = inRow(row).indexOf(target);
  let next: HTMLElement | undefined;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    const step = event.key === "ArrowDown" ? 1 : -1;
    for (let i = at + step; i >= 0 && i < rows.length && !next; i += step) {
      const cells = inRow(rows[i]!);
      next = cells[Math.min(col, cells.length - 1)];
    }
  } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    next = inRow(row)[col + (event.key === "ArrowRight" ? 1 : -1)];
  } else if (event.key === "Home" || event.key === "End") {
    const edge = event.key === "Home" ? rows[0] : rows[rows.length - 1];
    next = edge ? inRow(edge)[0] : undefined;
  } else {
    return;
  }
  if (!next) return;
  event.preventDefault();
  next.focus();
}
