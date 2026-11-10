// Up/Down across a wrapped set of controls, by what is drawn rather than by
// array order: the target is the control in the next rendered row nearest a
// column line the caller remembers across a run of presses, so a row of a
// different length (a spanning card, a short last row of chips) never strands
// the user in the wrong column. A move off the top or bottom stays put.
//
// Offset geometry, so every control must share one offset parent; sibling
// wrappers that are not positioned (the launcher's agent and tool rows) do.

export function columnCentre(element: HTMLElement): number {
  return element.offsetLeft + element.offsetWidth / 2;
}

export function moveToAdjacentRow(
  elements: ReadonlyArray<HTMLElement | null>,
  current: number,
  direction: 1 | -1,
  columnX: number
): number {
  const origin = elements[current];
  if (!origin) return current;
  const rows = [
    ...new Set(elements.flatMap((element) => (element ? [element.offsetTop] : []))),
  ].sort((a, b) => a - b);
  const targetRow = rows[rows.indexOf(origin.offsetTop) + direction];
  if (targetRow === undefined) return current;
  let best = current;
  let bestDistance = Infinity;
  elements.forEach((element, index) => {
    if (!element || element.offsetTop !== targetRow) return;
    const left = element.offsetLeft;
    const right = left + element.offsetWidth;
    const distance = columnX < left ? left - columnX : columnX > right ? columnX - right : 0;
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}
