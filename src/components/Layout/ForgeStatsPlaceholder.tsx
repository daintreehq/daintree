// The loaded pill's full width, invisible and inert. It holds the slot's no-drag
// rectangle and the row's layout while the view's workspace or its forge
// provider is still resolving, so the pill never grows into an area a secondary
// window cached as titlebar drag on first paint.
export function ForgeStatsPlaceholder() {
  return (
    <div className="toolbar-stats app-no-drag relative mx-1 flex h-8 w-[13rem] shrink-0 items-center overflow-hidden rounded-[var(--toolbar-pill-radius,var(--radius-md))] border opacity-0 pointer-events-none">
      <div data-stat-segment="" className="h-8 flex-1" />
      <div data-stat-segment="" className="h-8 flex-1" />
      <div data-stat-segment="" className="h-8 flex-1" />
    </div>
  );
}
